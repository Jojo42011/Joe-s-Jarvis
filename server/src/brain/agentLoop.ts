import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '../config/anthropic';
import { Response } from 'express';
import { ARLO_SYSTEM_PROMPT } from '../config/constants';
import { ANTHROPIC_MODEL, ANTHROPIC_FAST_MODEL, ARLO_MAX_TOKENS } from '../config/models';
import { getMemoryPacket } from './memoryPacket';
import { needsSonnet, isGreeting } from './routing';
import { drainSentences, flushSentenceBuffer } from './extractSentences';
import { insertConversation, getRecentConversation } from '../db/queries';
import { getRetrievalConfidence } from '../db/memory';
import { buildInboxCalendarContext } from '../services/google/context';
import { getSelectedPersonality } from '../services/personality';
import { FUNCTION_TOOLS, executeTool } from './tools';
import { braveWebSearch } from '../services/webSearch';

// Anthropic message shapes (kept loose — the SDK's union types are verbose and
// this loop only needs the handful of fields below).
type MsgContent = string | unknown[];
type ChatMessage = { role: 'user' | 'assistant'; content: MsgContent };

// Tool-calling can be turned off instantly via env if it ever misbehaves.
const TOOLS_ENABLED = process.env.ARLO_TOOLS_ENABLED !== 'false';
// Web search is a client tool backed by Brave; off if no key or explicitly disabled.
const WEB_SEARCH_ENABLED = process.env.ARLO_WEB_SEARCH !== 'false';
const MAX_TOOL_ROUNDS = 4;

/** Recent turns as working memory, plus the current message, for the model input. */
function buildConversationInput(message: string): ChatMessage[] {
  // 12 turns so a conversation picked back up after a break still has enough
  // working memory to feel continuous, without the token cost of the whole
  // history — long-term facts/episodes are the real durable memory.
  const history = getRecentConversation(12)
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && t.content?.trim())
    .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content as MsgContent }));
  history.push({ role: 'user', content: message });
  return history;
}

export interface AgentLoopOptions {
  message: string;
  sessionId?: string;
}

export interface AgentLoopResult {
  text: string;
  speech: string;
  curiosityQuestion?: string | null;
  navigate?: string | null;
}

async function buildSystemPrompt(message: string): Promise<string> {
  const packet = await getMemoryPacket(message);
  const persona = getSelectedPersonality();
  let system = `${ARLO_SYSTEM_PROMPT}\n\n## ACTIVE PERSONALITY — ${persona.name.toUpperCase()}\n${persona.prompt}\n\n## MEMORY CONTEXT\n${packet.text}`;

  const inbox = buildInboxCalendarContext();
  if (inbox) {
    system += `\n\n${inbox}`;
    console.log(`[Brain] Inbox/calendar snapshot injected into Jarvis's context (${inbox.length} chars)`);
  } else {
    console.log('[Brain] No inbox/calendar snapshot to inject — no mailbox connected or nothing to surface');
  }

  const confidence = getRetrievalConfidence(
    packet.factCount > 0
      ? [{ id: 0, content: '', category: null, score: packet.confidence }]
      : []
  );

  if (packet.factCount < 3 && confidence < 0.15 && message.length > 20 && needsSonnet(message)) {
    system += `\n\n## CLARIFICATION MODE
Memory confidence is low for this business-specific query. If you lack founder-specific facts,
ask ONE targeted clarifying question instead of guessing from general knowledge.`;
  }

  return system;
}

function selectModel(message: string, hasHistory: boolean): string {
  if (needsSonnet(message) || message.length > 80) return ANTHROPIC_MODEL;
  // Only a cold-open greeting (no prior turns) takes the fast path. Mid-flow, use
  // the full brain so replies stay sharp and in-context.
  if (isGreeting(message) && !hasHistory) return ANTHROPIC_FAST_MODEL;
  return ANTHROPIC_MODEL;
}

// Tools that resolve near-instantly (in-process SQLite reads) — no need to bridge
// silence for these. Everything else (network calls, generation) gets a short,
// natural filler so a tool round-trip never reads as dead air / a rough stall.
const FAST_TOOLS = new Set(['open_dashboard', 'get_agent_status']);
const BRIDGE_PHRASES = ['One sec.', 'On it.', 'Give me a beat.', 'Working on it.', 'Hang on.', 'Pulling that now.'];

// A web-search client tool backed by Brave, in Anthropic's tool schema.
const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the live web for current information — prices, a supplier, news, a ' +
    "lead's business, a permit rule, anything not already in memory or general " +
    'knowledge. Returns titles, URLs, and snippets. Use it, then answer from the results.',
  input_schema: {
    type: 'object' as const,
    properties: { query: { type: 'string', description: 'The search query.' } },
    required: ['query'],
  },
};

/** Convert the OpenAI-style FUNCTION_TOOLS into Anthropic's tool schema. */
function convertFunctionTools() {
  return (FUNCTION_TOOLS as unknown as { name: string; description: string; parameters: unknown }[]).map(
    (t) => ({ name: t.name, description: t.description, input_schema: t.parameters })
  );
}

// Full tool set for the main model; the fast greeting path runs tool-free.
function toolsFor(model: string): unknown[] {
  if (model === ANTHROPIC_FAST_MODEL || !TOOLS_ENABLED) return [];
  const tools: unknown[] = [...convertFunctionTools()];
  if (WEB_SEARCH_ENABLED) tools.unshift(WEB_SEARCH_TOOL);
  return tools;
}

/** Run one collected tool call — web_search goes to Brave, everything else to executeTool. */
async function runToolCall(name: string, input: Record<string, unknown>): Promise<{ result: unknown; navigate?: string }> {
  if (name === 'web_search') {
    return { result: await braveWebSearch(String(input.query || '')) };
  }
  return executeTool(name, input);
}

interface ToolUse { id: string; name: string; input: Record<string, unknown> }

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new Error('Claude is disabled on this deployment (see server/src/config/anthropic.ts)');

  const { message } = options;
  const client = new Anthropic({ apiKey });
  const messages = buildConversationInput(message);
  const model = selectModel(message, messages.length > 1);
  const system = await buildSystemPrompt(message);
  const tools = toolsFor(model);

  let navigate: string | null = null;
  let finalText = '';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp: any = await client.messages.create({
      model,
      max_tokens: model === ANTHROPIC_FAST_MODEL ? 512 : ARLO_MAX_TOKENS,
      system,
      messages: messages as Anthropic.MessageParam[],
      ...(tools.length ? { tools: tools as Anthropic.Tool[] } : {}),
    });

    const textBlocks = (resp.content || []).filter((b: { type: string }) => b.type === 'text');
    finalText = textBlocks.map((b: { text: string }) => b.text).join('');
    const toolUses = (resp.content || []).filter((b: { type: string }) => b.type === 'tool_use') as ToolUse[];

    if (resp.stop_reason !== 'tool_use' || !toolUses.length || round === MAX_TOOL_ROUNDS) break;

    messages.push({ role: 'assistant', content: resp.content });
    const toolResults: unknown[] = [];
    for (const tu of toolUses) {
      const outcome = await runToolCall(tu.name, tu.input || {});
      if (outcome.navigate) navigate = outcome.navigate;
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(outcome.result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  insertConversation('user', message);
  insertConversation('assistant', finalText);
  return { text: finalText, speech: finalText, navigate };
}

export async function streamAgentLoop(
  options: AgentLoopOptions,
  res: Response
): Promise<void> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new Error('Claude is disabled on this deployment (see server/src/config/anthropic.ts)');

  const { message } = options;
  const client = new Anthropic({ apiKey });
  const messages = buildConversationInput(message);
  const model = selectModel(message, messages.length > 1);
  const system = await buildSystemPrompt(message);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sentenceBuffer = { text: '', emitted: 0 };
  let fullText = '';
  let didNavigate = false;
  let bridgeSent = false;
  let toolsDisabled = false;

  const emitText = (delta: string) => {
    fullText += delta;
    sentenceBuffer.text += delta;
    for (const s of drainSentences(sentenceBuffer)) send({ type: 'sentence', text: s });
  };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const tools = toolsDisabled ? [] : toolsFor(model);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        model,
        max_tokens: model === ANTHROPIC_FAST_MODEL ? 512 : ARLO_MAX_TOKENS,
        system,
        messages: messages as Anthropic.MessageParam[],
        stream: true,
        ...(tools.length ? { tools } : {}),
      };

      let stream;
      try {
        stream = await client.messages.create(params);
      } catch (err) {
        // If the tool-enabled call fails on the first round, retry tool-free so
        // Joe still gets an answer instead of dead air.
        if (!toolsDisabled && round === 0) {
          console.warn('[Brain] tool-enabled stream failed, retrying tool-free:', err instanceof Error ? err.message : err);
          toolsDisabled = true;
          stream = await client.messages.create({
            model, max_tokens: ARLO_MAX_TOKENS, system, messages: messages as Anthropic.MessageParam[], stream: true,
          });
        } else { throw err; }
      }

      // Reconstruct the assistant turn's content blocks so a tool round can be
      // continued (Anthropic needs the tool_use blocks echoed back verbatim).
      const assistantBlocks: unknown[] = [];
      const toolUses: ToolUse[] = [];
      let curText = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let curTool: { id: string; name: string; json: string } | null = null;
      let stopReason: string | null = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const event of stream as any) {
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'text') {
            curText = '';
          } else if (event.content_block?.type === 'tool_use') {
            curTool = { id: event.content_block.id, name: event.content_block.name, json: '' };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            curText += event.delta.text;
            emitText(event.delta.text);
          } else if (event.delta?.type === 'input_json_delta' && curTool) {
            curTool.json += event.delta.partial_json || '';
          }
        } else if (event.type === 'content_block_stop') {
          if (curTool) {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(curTool.json || '{}'); } catch { /* keep {} */ }
            assistantBlocks.push({ type: 'tool_use', id: curTool.id, name: curTool.name, input });
            toolUses.push({ id: curTool.id, name: curTool.name, input });
            curTool = null;
          } else if (curText) {
            assistantBlocks.push({ type: 'text', text: curText });
            curText = '';
          }
        } else if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        }
      }

      if (stopReason !== 'tool_use' || !toolUses.length || round === MAX_TOOL_ROUNDS) break;

      // Bridge the silence for slower tool calls so it never feels like a stall.
      if (!fullText && !bridgeSent && toolUses.some((c) => !FAST_TOOLS.has(c.name))) {
        bridgeSent = true;
        const filler = BRIDGE_PHRASES[Math.floor(Math.random() * BRIDGE_PHRASES.length)];
        send({ type: 'sentence', text: filler });
      }

      messages.push({ role: 'assistant', content: assistantBlocks });
      const toolResults: unknown[] = [];
      for (const tu of toolUses) {
        const outcome = await runToolCall(tu.name, tu.input || {});
        if (outcome.navigate) { send({ type: 'navigate', tab: outcome.navigate }); didNavigate = true; }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(outcome.result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    console.error('[Brain] stream error:', err instanceof Error ? err.message : err);
    if (!fullText) send({ type: 'sentence', text: 'Give me a second on that, boss.' });
  }

  const tail = flushSentenceBuffer(sentenceBuffer);
  if (tail) send({ type: 'sentence', text: tail });
  if (!fullText && didNavigate) send({ type: 'sentence', text: 'Pulling that up now.' });

  insertConversation('user', message);
  insertConversation('assistant', fullText);

  send({ type: 'done', text: fullText });
  res.end();
}
