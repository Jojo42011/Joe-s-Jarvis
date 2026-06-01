import {
  getActiveAlertPayload,
  getExecutionLogToday,
  getQueue,
  getState,
  incrementOccurrence,
  type ConversationState
} from "../../db/queries";
import { getWorldIntelForPrompt } from "../../brain/worldIntelStore";
import { OPERATOR_SYSTEMS_WIRING } from "../../config/systemPrompt";
import { rememberMemory, savePreferenceFromCorrection, MEMORY_CATEGORIES } from "../../services/memory";
import { detectCorrectionSignal, getOhioDateTimeString } from "./utils";
import { memoryLog, reqLog } from "../../utils/requestLog";
import { formatExecutionLogLine, formatRelativeAge } from "../../utils/temporal";
import { humanizeLogSummary } from "../../utils/executionSummary";
import { getSessionUploads } from "../../services/uploadSession";
import { getSpokenListForPrompt } from "./spokenSessionTracker";

export function detectPreferenceSignal(message: string): boolean {
  const t = message.toLowerCase();
  return (
    /\bi like how you\b/.test(t) ||
    /\bgood call on\b/.test(t) ||
    /\bexactly right\b/.test(t) ||
    /that's perfect|that is perfect/.test(t) ||
    /\bspot on\b/.test(t) ||
    /\bkeep that up\b/.test(t) ||
    /\bnice work\b/.test(t)
  );
}

export function applyMemoryFeedbackToSpeech(message: string, speech: string) {
  let out = speech.trim();
  if (detectCorrectionSignal(message)) {
    void savePreferenceFromCorrection(message);
    if (!/noted sir/i.test(out)) {
      out = `${out} Noted sir. I'll handle it that way going forward.`;
    }
  }

  if (detectPreferenceSignal(message)) {
    const ok = incrementOccurrence(
      MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
      "operator_tone_positive"
    );
    if (!ok) {
      void rememberMemory({
        category: MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
        key: "operator_tone_positive",
        value: message.slice(0, 1500),
        confidence: 0.72
      });
    }
  }

  return out;
}

const MEMORY_EXTRACTION_SKIP_INTENTS = new Set([
  "activation.briefing",
  "morning_brief",
  "unclear",
  "execute.cancel",
  "fetch.emails"
]);

export function shouldExtractMemories(intent: string) {
  return !MEMORY_EXTRACTION_SKIP_INTENTS.has(intent);
}

export function memoryOutcomeLabel(intent: string) {
  if (intent === "execute.send") return "send_confirmed";
  if (intent === "intelligence.handled") return "item_handled";
  if (intent === "execute.edit" || intent === "email.reply.edit") return "draft_updated";
  return intent;
}

export function buildChatStateForClaude(
  state: ConversationState,
  alertPayload: ReturnType<typeof getActiveAlertPayload>,
  sessionId?: string
) {
  const todayLog = getExecutionLogToday(40);
  const recentExecutionLog = todayLog.slice(0, 3);
  const olderExecutionLog = todayLog.slice(3);
  const groupedActions = new Map<string, { count: number; last: string | null }>();
  for (const row of olderExecutionLog) {
    const key = row.action || row.type || "unknown";
    const existing = groupedActions.get(key) || { count: 0, last: null };
    existing.count += 1;
    if (!existing.last || Date.parse(row.timestamp) > Date.parse(existing.last)) {
      existing.last = row.timestamp;
    }
    groupedActions.set(key, existing);
  }
  const executionLogSummary = [...groupedActions.entries()]
    .map(([action, value]) => {
      const when = value.last ? formatRelativeAge(value.last) : "earlier today";
      return `${when}: ${action} (${value.count}×)`;
    })
    .join(" | ");
  const priorityQueueOpen = getQueue(false)
    .slice(0, 12)
    .map((q) => ({
      id: q.id,
      type: q.type,
      urgency: q.urgency,
      summary: q.summary,
      actionNeeded: q.actionNeeded
    }));
  memoryLog(`read: execution_log today=${todayLog.length} queue=${priorityQueueOpen.length}`);
  reqLog(
    `execution_log: ${recentExecutionLog.length} recent | memory context in prompt | queue: ${priorityQueueOpen.length} open`
  );

  const worldIntelCache = getWorldIntelForPrompt()
    .slice(0, 8)
    .map((w) => ({
      query: w.query,
      summary: w.summary || null,
      relevance: w.relevance
    }));

  return {
    ...state,
    currentDateTime: getOhioDateTimeString(),
    currentDateTimeZone: "America/New_York (Ohio / Eastern Time)",
    intelligence: {
      activeAlert: alertPayload.hasAlert ? alertPayload.alert : null,
      priorityQueueOpen,
      queueOpenCount: priorityQueueOpen.length
    },
    worldIntelCache,
    operatorSystems: OPERATOR_SYSTEMS_WIRING,
    executionLogSummary: executionLogSummary || "No older execution-log entries today.",
    executionLogToday: recentExecutionLog.map((e) => ({
      line: formatExecutionLogLine(e.summary || e.action || "Action logged", e.timestamp),
      action: e.action,
      summary: humanizeLogSummary(e.summary || ""),
      result: e.result,
      when: formatRelativeAge(e.timestamp)
    })),
    pendingUploads: getSessionUploads(state.sessionId).map((u) => ({
      uploadId: u.uploadId,
      filename: u.filename,
      mimeType: u.mimeType,
      isImage: u.isImage,
      documentId: u.documentId
    })),
    operatorContext: state.operatorContext,
    alreadyCoveredThisSession: sessionId ? getSpokenListForPrompt(sessionId) : [],
    conversationNote:
      "Use executionLogToday as source of truth for what was actually done. Never claim you sent an email unless executionLogToday or a successful gmail.send_reply on this turn confirms it. Live weather/news/world questions are answered via automatic Brave ReAct before this response — use world.intel and weather panel when applicable. Follow up questions refer to the conversation above."
  };
}
