import {
  getExecutionLogToday,
  getQueue,
  getRecentConversation,
  type ConversationMessage,
  type ExecutionLogEntry
} from "../db/queries";
import { getOhioDateTimeString } from "../routes/chat/utils";
import { humanizeLogSummary } from "../utils/executionSummary";
import {
  formatMemoryFeedForPrompt,
  getMemoryFeedForMessage,
  type MemoryFeed
} from "../memory/memoryFeed";

export type SpeakerIdentity = "joe_operator" | "jahan_developer";

const JAHAN_MESSAGE_PATTERN =
  /\b(this is jahan|it'?s jahan|its jahan|jahan here|hey jahan|hi jahan)\b/i;

const JAHAN_SESSION_HINTS = ["jahan", "dev", "developer", "aethon"];

export function detectSpeakerIdentity(message: string, sessionId: string): SpeakerIdentity {
  if (JAHAN_MESSAGE_PATTERN.test(message)) return "jahan_developer";
  const sid = sessionId.toLowerCase();
  if (JAHAN_SESSION_HINTS.some((hint) => sid.includes(hint))) return "jahan_developer";
  return "joe_operator";
}

export type LeanChatContext = {
  ohio_time: string;
  speaker: SpeakerIdentity;
  queue_count: number;
  last_execution: string | null;
  recent_conversation: ConversationMessage[];
};

export type SmartContext = LeanChatContext & {
  memory_feed: MemoryFeed;
  memory_feed_text: string;
};

function summarizeLastExecution(entries: ExecutionLogEntry[]): string | null {
  const row = entries.find((e) => e.result === "success" && e.summary?.trim());
  if (!row?.summary) return null;
  return humanizeLogSummary(row.summary);
}

export function buildLeanChatContext(sessionId: string): LeanChatContext {
  const todayLog = getExecutionLogToday(1);
  return {
    ohio_time: getOhioDateTimeString(),
    speaker: "joe_operator",
    queue_count: getQueue(false).length,
    last_execution: summarizeLastExecution(todayLog),
    recent_conversation: getRecentConversation(sessionId, 8)
  };
}

export async function buildSmartContext(
  message: string,
  sessionId: string
): Promise<SmartContext> {
  const lean = buildLeanChatContext(sessionId);
  lean.speaker = detectSpeakerIdentity(message, sessionId);
  const memory_feed = await getMemoryFeedForMessage(message, sessionId);
  return {
    ...lean,
    memory_feed,
    memory_feed_text: formatMemoryFeedForPrompt(memory_feed)
  };
}

export function formatLeanContextNote(ctx: LeanChatContext): string {
  const last = ctx.last_execution || "none logged yet";
  const speakerLabel =
    ctx.speaker === "jahan_developer"
      ? "Jahan (developer, full system access)"
      : "Joe (operator)";
  return `Current state: Ohio time ${ctx.ohio_time}. Queue: ${ctx.queue_count} open item${
    ctx.queue_count === 1 ? "" : "s"
  }. Speaker: ${speakerLabel}. Last autonomous action: ${last}.`;
}

export function formatSmartContextNote(ctx: SmartContext): string {
  return `${ctx.memory_feed_text}\n${formatLeanContextNote(ctx)}`;
}
