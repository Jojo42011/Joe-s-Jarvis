import OpenAI from 'openai';
import { Response } from 'express';
import { ARLO_SYSTEM_PROMPT } from '../config/constants';
import { ARLO_MODEL, ARLO_FAST_MODEL, ARLO_MAX_TOKENS } from '../config/models';
import { getMemoryPacket } from './memoryPacket';
import { needsSonnet, isGreeting } from './routing';
import { drainSentences, flushSentenceBuffer } from './extractSentences';
import { insertConversation, getRecentConversation } from '../db/queries';
import { getRetrievalConfidence } from '../db/memory';
import { buildInboxCalendarContext } from '../services/google/context';
import { getSelectedPersonality } from '../services/personality';
import { FUNCTION_TOOLS, executeTool } from './tools';

type ChatTurn = { role: 'user' | 'assistant'; content: string };

// Tool-calling can be turned off instantly via env if it ever misbehaves.
const TOOLS_ENABLED = process.env.ARLO_TOOLS_ENABLED !== 'false';
const MAX_TOOL_ROUNDS = 4;

/** Recent turns as working memory, plus the current message, for the model input. */
function buildConversationInput(message: string): ChatTurn[] {
  // 12 turns (was 8) so a conversation picked back up after a break still has
  // enough working memory to feel continuous, without the token cost of the
  // whole history — long-term facts/episodes are the real durable memory.
  const history = getRecentConversation(12)
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && t.content?.trim())
    .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content }));
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
    console.log(`[Brain] Inbox/calendar snapshot injected into Arlo's context (${inbox.length} chars)`);
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
  if (needsSonnet(message) || message.length > 80) return ARLO_MODEL;
  // Only a cold-open greeting (no prior turns) takes the fast path. Mid-flow, use
  // the full brain so replies stay sharp and in-context.
  if (isGreeting(message) && !hasHistory) return ARLO_FAST_MODEL;
  return ARLO_MODEL;
}

const WEB_SEARCH_TOOLS = [{ type: 'web_search_preview' as const }];

// Tools that resolve near-instantly (in-process SQLite reads) — no need to bridge
// silence for these. Everything else (network calls, generation) gets a short,
// natural filler so a tool round-trip never reads as dead air / a rough stall.
const FAST_TOOLS = new Set(['open_dashboard', 'get_agent_status']);
const BRIDGE_PHRASES = ['One sec.', 'On it.', 'Give me a beat.', 'Working on it.', 'Hang on.', 'Pulling that now.'];

// Function tools only on the full model (never the fast greeting path).
function toolsFor(model: string) {
  if (model === ARLO_FAST_MODEL || !TOOLS_ENABLED) return WEB_SEARCH_TOOLS as unknown[];
  return [...WEB_SEARCH_TOOLS, ...FUNCTION_TOOLS] as unknown[];
}

function baseParams(model: string, system: string, input: ChatTurn[]) {
  return {
    model,
    instructions: system,
    input,
    max_output_tokens: model === ARLO_FAST_MODEL ? 512 : ARLO_MAX_TOKENS,
    tools: toolsFor(model),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function functionCalls(output: any): any[] {
  return ((output || []) as any[]).filter((i) => i && i.type === 'function_call');
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const { message } = options;
  const client = new OpenAI({ apiKey });
  const input = buildConversationInput(message);
  const model = selectModel(message, input.length > 1);
  const system = await buildSystemPrompt(message);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let response: any = await client.responses.create(baseParams(model, system, input) as any);
  let navigate: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const calls = functionCalls(response.output);
    if (!calls.length) break;
    const outputs: unknown[] = [];
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* keep {} */ }
      const outcome = await executeTool(call.name, args);
      if (outcome.navigate) navigate = outcome.navigate;
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(outcome.result) });
    }
    response = await client.responses.create({
      model, previous_response_id: response.id, input: outputs,
      tools: toolsFor(model), max_output_tokens: ARLO_MAX_TOKENS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  const text = response.output_text || '';
  insertConversation('user', message);
  insertConversation('assistant', text);
  return { text, speech: text, navigate };
}

export async function streamAgentLoop(
  options: AgentLoopOptions,
  res: Response
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const { message } = options;
  const client = new OpenAI({ apiKey });
  const input = buildConversationInput(message);
  const model = selectModel(message, input.length > 1);
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

  const emitText = (delta: string) => {
    fullText += delta;
    sentenceBuffer.text += delta;
    for (const s of drainSentences(sentenceBuffer)) send({ type: 'sentence', text: s });
  };

  // Round-based: stream text; if the model calls tools instead, run them (emitting
  // navigation), then continue with previous_response_id to stream the real answer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let curInput: any = input;
  let previousResponseId: string | undefined;
  let disableTools = false;
  let bridgeSent = false;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = previousResponseId
        ? { model, previous_response_id: previousResponseId, input: curInput, max_output_tokens: ARLO_MAX_TOKENS, tools: disableTools ? WEB_SEARCH_TOOLS : toolsFor(model), stream: true }
        : { ...baseParams(model, system, input), tools: disableTools ? WEB_SEARCH_TOOLS : toolsFor(model), stream: true };

      let stream;
      try {
        stream = await client.responses.create(params);
      } catch (err) {
        // Safety: if the tool-enabled call fails, fall back to a plain stream.
        if (!disableTools && !previousResponseId) {
          console.warn('[Brain] tool-enabled stream failed, falling back to plain:', err instanceof Error ? err.message : err);
          disableTools = true;
          stream = await client.responses.create({ ...baseParams(model, system, input), tools: WEB_SEARCH_TOOLS, stream: true });
        } else { throw err; }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingCalls: any[] = [];
      let respId: string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const event of stream as any) {
        if (event.type === 'response.output_text.delta') {
          if (event.delta) emitText(event.delta);
        } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
          pendingCalls.push(event.item);
        } else if (event.type === 'response.completed') {
          respId = event.response?.id;
        }
      }

      if (!pendingCalls.length || !respId) break; // answered (or can't safely continue)

      // Bridge the silence for slower tool calls so it never feels like a stall.
      if (!fullText && !bridgeSent && pendingCalls.some((c) => !FAST_TOOLS.has(c.name))) {
        bridgeSent = true;
        const filler = BRIDGE_PHRASES[Math.floor(Math.random() * BRIDGE_PHRASES.length)];
        send({ type: 'sentence', text: filler });
      }

      const outputs: unknown[] = [];
      for (const call of pendingCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.arguments || '{}'); } catch { /* keep {} */ }
        const outcome = await executeTool(call.name, args);
        if (outcome.navigate) { send({ type: 'navigate', tab: outcome.navigate }); didNavigate = true; }
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(outcome.result) });
      }
      previousResponseId = respId;
      curInput = outputs;
    }
  } catch (err) {
    console.error('[Brain] stream error:', err instanceof Error ? err.message : err);
    if (!fullText) send({ type: 'sentence', text: 'Give me a second on that, sir.' });
  }

  const tail = flushSentenceBuffer(sentenceBuffer);
  if (tail) send({ type: 'sentence', text: tail });
  if (!fullText && didNavigate) send({ type: 'sentence', text: 'Pulling that up now.' });

  insertConversation('user', message);
  insertConversation('assistant', fullText);

  send({ type: 'done', text: fullText });
  res.end();
}
