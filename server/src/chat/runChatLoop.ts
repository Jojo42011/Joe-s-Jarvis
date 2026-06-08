import Anthropic from "@anthropic-ai/sdk";
import type { ConversationMessage } from "../db/queries";
import { claudeCircuit } from "../services/circuitBreaker";
import { findWorkingModel, generateFastJarvisResponse } from "../services/claude";
import { enforceTruthfulSpeech } from "../routes/chat/truthGuard";
import type { JarvisUiPayload } from "../routes/chat/types";
import { sanitizeSpeechForClient } from "../routes/chat/utils";
import {
  buildSmartContext,
  detectSpeakerIdentity,
  formatSmartContextNote,
  type SmartContext
} from "./context";
import { buildChatSystemPrompt } from "./systemPrompt";
import {
  CHAT_TOOL_DEFINITIONS,
  emailWasSent,
  executeChatTool,
  type ToolExecutionResult
} from "./tools";
import { claudeLog } from "../utils/requestLog";

const chatAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MAX_TOOL_ROUNDS = 5;

export type ChatLoopResult = {
  speech: string;
  intent: string;
  ui: JarvisUiPayload;
  tool: string;
  sentEmail: boolean;
  toolsCalled: string[];
};

function extractAssistantText(content: Anthropic.ContentBlock[]): string {
  const parts = content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean);
  return parts.join(" ").trim();
}

function historyToMessages(
  history: ConversationMessage[]
): Anthropic.MessageParam[] {
  return history
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({
      role: entry.role as "user" | "assistant",
      content: entry.content
    }));
}

function inferUiFromTools(
  toolsCalled: string[],
  toolPayloads: Array<{ name: string; result: ToolExecutionResult }>
): JarvisUiPayload {
  const data: unknown[] = [];
  let panel: JarvisUiPayload["panel"] = null;

  if (toolsCalled.includes("read_emails")) {
    panel = "emails";
    const hit = toolPayloads.find((t) => t.name === "read_emails");
    if (hit?.result.emails) data.push({ emails: hit.result.emails });
  } else if (toolsCalled.includes("get_calls")) {
    panel = "calls";
    const hit = toolPayloads.find((t) => t.name === "get_calls");
    if (hit?.result.calls) data.push({ calls: hit.result.calls });
  } else if (toolsCalled.includes("get_notes") || toolsCalled.includes("save_note")) {
    panel = "notes";
    const hit = toolPayloads.find((t) => t.name === "get_notes" || t.name === "save_note");
    if (hit?.result.notes) data.push({ notes: hit.result.notes });
    else if (hit?.result.note_id) data.push({ note: { id: hit.result.note_id, content: hit.result.content } });
  } else if (toolsCalled.includes("get_weather")) {
    panel = "weather";
    const hit = toolPayloads.find((t) => t.name === "get_weather");
    if (hit?.result) {
      data.push({
        location: hit.result.location,
        temperature: hit.result.temperature ?? hit.result.temp,
        conditions: hit.result.conditions,
        wind: hit.result.wind,
        crew_impact: hit.result.crew_impact ?? hit.result.job_site_rating,
        crew_note: hit.result.crew_note
      });
    }
  } else if (toolsCalled.includes("get_queue") || toolsCalled.includes("book_calendar")) {
    panel = "rundown";
    const hit = toolPayloads.find((t) => t.name === "get_queue" || t.name === "book_calendar");
    if (hit?.result.items) data.push({ priorityQueue: hit.result.items });
    else if (hit?.result) data.push(hit.result);
  }

  return { panel, action: panel ? "open" : null, data };
}

function inferIntent(toolsCalled: string[]): string {
  if (!toolsCalled.length) return "chat.direct";
  if (toolsCalled.includes("save_note")) return "save_note";
  if (toolsCalled.includes("search_web")) return "world.search";
  if (toolsCalled.includes("read_emails")) return "gmail.read";
  if (toolsCalled.includes("send_email")) return "gmail.send_reply";
  if (toolsCalled.includes("get_weather")) return "weather.get";
  if (toolsCalled.includes("get_notes")) return "notes.query";
  if (toolsCalled.includes("get_full_picture") || toolsCalled.includes("get_entity")) return "memory";
  if (toolsCalled.includes("get_memory") || toolsCalled.includes("save_memory")) return "memory";
  if (toolsCalled.includes("get_queue")) return "intelligence.queue";
  if (toolsCalled.includes("get_execution_log")) return "execution.log";
  if (toolsCalled.includes("book_calendar")) return "calendar.create";
  return "chat.tools";
}

const SIMPLE_INTENT_RE =
  /^(hi|hello|hey|thanks|thank you|ok|okay|got it|sounds good|perfect|great|sure|yes|no|what time|what's the time|how are you|good morning|good afternoon|good evening)[\s?!.]*$/i;

function isSimpleIntent(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.length < 50 && SIMPLE_INTENT_RE.test(trimmed);
}

function parseFastJarvisSpeech(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Standing by, sir.";
  try {
    const parsed = JSON.parse(trimmed) as { speech?: string };
    if (typeof parsed.speech === "string" && parsed.speech.trim()) {
      return parsed.speech.trim();
    }
  } catch {
    if (!trimmed.startsWith("{")) return trimmed;
  }
  return "Standing by, sir.";
}

async function runSimpleChatLoop(message: string): Promise<ChatLoopResult> {
  claudeLog("chat fast path: Haiku (simple intent)");
  const raw = await generateFastJarvisResponse(message);
  const speech = sanitizeSpeechForClient(parseFastJarvisSpeech(raw), "Standing by, sir.");
  return {
    speech,
    intent: "chat.direct",
    ui: { panel: null, data: [], action: null },
    tool: "",
    sentEmail: false,
    toolsCalled: []
  };
}

export async function runChatLoop(
  message: string,
  sessionId: string,
  smartContext?: SmartContext
): Promise<ChatLoopResult> {
  const context = smartContext || (await buildSmartContext(message, sessionId));
  context.speaker = detectSpeakerIdentity(message, sessionId);

  const fallbackSpeech = "Standing by, sir. I need Claude online to run that properly.";
  if (!chatAnthropic) {
    return {
      speech: fallbackSpeech,
      intent: "chat.unconfigured",
      ui: { panel: null, data: [], action: null },
      tool: "",
      sentEmail: false,
      toolsCalled: []
    };
  }

  if (isSimpleIntent(message)) {
    return runSimpleChatLoop(message);
  }

  const model = await findWorkingModel();
  if (!model) {
    return {
      speech:
        "No Claude model responded, sir. Check the API key and billing at Anthropic.",
      intent: "chat.model_error",
      ui: { panel: null, data: [], action: null },
      tool: "",
      sentEmail: false,
      toolsCalled: []
    };
  }

  const system = `${buildChatSystemPrompt(context.speaker)}\n\n${formatSmartContextNote(context)}`;
  const messages: Anthropic.MessageParam[] = [
    ...historyToMessages(context.recent_conversation),
    { role: "user", content: message }
  ];

  const toolsCalled: string[] = [];
  const toolPayloads: Array<{ name: string; result: ToolExecutionResult }> = [];
  let sentEmail = false;

  let finalText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await claudeCircuit.execute("chat_tool_loop", () =>
      chatAnthropic.messages.create({
        model,
        max_tokens: 1024,
        temperature: 0.35,
        system: [
          {
            type: "text" as const,
            text: system,
            cache_control: { type: "ephemeral" }
          }
        ],
        tools: CHAT_TOOL_DEFINITIONS,
        tool_choice: { type: "auto" },
        messages
      })
    );

    if (response.usage) {
      const cacheRead =
        (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
      const cacheCreate =
        (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ??
        0;
      if (cacheRead || cacheCreate) {
        claudeLog(
          `chat_tool_loop cache: read=${cacheRead} create=${cacheCreate} in=${response.usage.input_tokens}`
        );
      }
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          toolsCalled.push(block.name);
          const result = await executeChatTool(
            block.name,
            block.input as Record<string, unknown>,
            sessionId
          );
          toolPayloads.push({ name: block.name, result });
          if (block.name === "send_email" && emailWasSent(result)) {
            sentEmail = true;
          }
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: JSON.stringify(result)
          };
        })
      );

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    finalText = extractAssistantText(response.content);
    break;
  }

  if (!finalText) {
    finalText = "I hit a limit on tool rounds, sir. Ask again with a narrower question.";
  }

  const intent = inferIntent(toolsCalled);
  let speech = sanitizeSpeechForClient(finalText, "Standing by, sir.");
  speech = enforceTruthfulSpeech(speech, intent, sentEmail);
  const ui = inferUiFromTools(toolsCalled, toolPayloads);

  return {
    speech,
    intent,
    ui,
    tool: toolsCalled.join(","),
    sentEmail,
    toolsCalled
  };
}
