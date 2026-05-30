import {
  clearGmailAuthAlertIfPresent,
  getExecutionLogSince,
  getExecutionLogToday,
  logExecution,
  searchExecutionLog,
  type ConversationState
} from "../../db/queries";
import {
  buildExecutionSummarySpeech,
  executionLogWindowMs,
  humanizeLogSummary,
  isOperatorFacingLog
} from "../../utils/executionSummary";
import { routeLog } from "../../utils/requestLog";
import { CircuitOpenError, isGmailCircuitOpen } from "../../services/gmail";
import { getRecentGmailMessages } from "../../services/gmail";
import {
  isAskAboutPastActions,
  isSendCommand,
  isSendVerification,
  normalizeText,
  resolveItemFromState,
  sanitizeSpeechForClient
} from "./utils";
import { getGeneratedImage } from "../../services/uploadSession";
import { messageNeedsLiveDataSearch } from "./liveData";
import { buildChatStateForClaude } from "./memoryOrchestrator";
import type { EmailStateItem, IntentResponse } from "./types";
import type { getActiveAlertPayload } from "../../db/queries";

export function isEmailConnectionCheck(message: string): boolean {
  const t = normalizeText(message);
  return /\b(check email|email connection|gmail connection|test email|is gmail|gmail working|email working|gmail connected|email connected)\b/.test(
    t
  );
}

export function isFetchEmailsRequest(message: string): boolean {
  const t = normalizeText(message);
  if (isEmailConnectionCheck(message)) return false;
  return (
    /\b(pull up|pull|show|open|fetch|read|see|list|grab|get|display)\b.*\b(emails?|inbox|gmail)\b/.test(t) ||
    /\b(emails?|inbox|gmail)\b.*\b(pull|show|open|fetch|read|see|list|grab|get|access|up)\b/.test(t) ||
    /\b(check my emails|check the inbox|my emails|the inbox|email panel|show mail)\b/.test(t) ||
    /\b(can you (see|read|access)|do you have access to).*(emails?|inbox|gmail)\b/.test(t)
  );
}

async function runGmailFetchRoute(
  limit: number,
  speechForSuccess: (count: number, previewLine: string) => string
): Promise<IntentResponse> {
  if (isGmailCircuitOpen()) {
    return {
      speech:
        "Gmail circuit is cooling down from earlier errors, sir. Wait about a minute or restart the server, then ask again.",
      intent: "general.chat",
      entities: {},
      ui: { panel: null, data: [], action: null },
      tool: { name: null, args: {} }
    };
  }

  try {
    const emails = await getRecentGmailMessages(limit);
    clearGmailAuthAlertIfPresent();
    const preview = emails[0];
    const line = preview
      ? `Latest: ${preview.from} — ${preview.subject}.`
      : "Inbox is empty in the last two weeks.";
    const speech = speechForSuccess(emails.length, line);
    logExecution({
      type: "email",
      action: "gmail.fetch",
      summary: speech.slice(0, 500),
      result: "success"
    });
    return {
      speech,
      intent: "fetch.emails",
      entities: {},
      ui: { panel: "emails", action: "open", data: emails },
      tool: { name: "gmail.fetch", args: {} }
    };
  } catch (error) {
    const detail =
      error instanceof CircuitOpenError
        ? "Circuit is open from earlier failures."
        : error instanceof Error
          ? error.message
          : "Unknown error";
    return {
      speech: `Gmail is not reachable right now, sir. ${detail} If this persists, re-auth at /api/auth/google and update GMAIL_REFRESH_TOKEN.`,
      intent: "general.chat",
      entities: {},
      ui: { panel: null, data: [], action: null },
      tool: { name: null, args: {} }
    };
  }
}

export async function tryFetchEmailsRoute(
  message: string,
  _state: ConversationState
): Promise<IntentResponse | null> {
  if (!isFetchEmailsRequest(message)) return null;
  routeLog("hit: tryFetchEmailsRoute");
  return runGmailFetchRoute(8, (count, line) =>
    count > 0
      ? `Inbox is up, sir. ${count} recent message${count === 1 ? "" : "s"} on screen. ${line}`
      : "Inbox is connected but quiet in the last two weeks, sir."
  );
}

export async function tryEmailConnectionRoute(
  message: string,
  _state: ConversationState
): Promise<IntentResponse | null> {
  if (!isEmailConnectionCheck(message)) return null;
  routeLog("hit: tryEmailConnectionRoute");
  return runGmailFetchRoute(5, (count, line) =>
    `Gmail is connected, sir. I pulled ${count} recent message${count === 1 ? "" : "s"}. ${line}`
  );
}

export function isOpenEndedOperatorQuery(message: string): boolean {
  const t = normalizeText(message);
  if (messageNeedsLiveDataSearch(message)) return false;
  return (
    /\b(what else should i know|anything else i should know|what should i know|what am i missing|anything i need to know|what do i need to know|what else do i need)\b/.test(
      t
    ) ||
    /\b(catch me up|fill me in|update me|status update|brief me|what s new|whats new|what have i missed)\b/.test(
      t
    ) ||
    /^(what else|anything else)\b/.test(t)
  );
}

export function tryOpenEndedBriefingRoute(
  message: string,
  state: ConversationState,
  alertPayload: ReturnType<typeof getActiveAlertPayload>
): IntentResponse | null {
  if (!isOpenEndedOperatorQuery(message)) return null;

  const ctx = buildChatStateForClaude(state, alertPayload) as {
    intelligence?: { activeAlert?: unknown; queueOpenCount?: number };
    executionLogToday?: Array<{ summary?: string; result?: string }>;
  };

  const parts: string[] = [];

  if (alertPayload.hasAlert && alertPayload.alert?.summary) {
    parts.push(`Priority alert: ${alertPayload.alert.summary}`);
  }

  const queueCount = ctx.intelligence?.queueOpenCount ?? 0;
  if (queueCount > 0) {
    parts.push(`${queueCount} item${queueCount === 1 ? "" : "s"} on your priority queue.`);
  }

  const recentExec = ctx.executionLogToday?.slice(0, 3) ?? [];
  if (recentExec.length) {
    const line = recentExec
      .map((e) => e.summary)
      .filter(Boolean)
      .slice(0, 2)
      .join("; ");
    if (line) parts.push(`Recent actions: ${line}`);
  }

  const speech =
    parts.length > 0
      ? `Here is what matters, sir. ${parts.join(" ")} What would you like me to handle first?`
      : "All quiet on my side, sir. Queue is clear and nothing urgent is flagged. Say the word if you want email, weather, or a full rundown.";

  return {
    speech: sanitizeSpeechForClient(speech),
    intent: "general.chat",
    entities: {},
    ui: { panel: queueCount > 0 ? "rundown" : null, data: [], action: queueCount > 0 ? "open" : null },
    tool: { name: null, args: {} }
  };
}

export function extractNameRefs(message: string) {
  const t = normalizeText(message);
  const refs: string[] = [];
  const m = t.match(/\b([a-z][a-z0-9]{2,})\b/g);
  if (m) {
    for (const word of m) {
      if (
        ![
          "did",
          "you",
          "send",
          "sent",
          "the",
          "that",
          "what",
          "have",
          "done",
          "sure",
          "actually",
          "email",
          "lead",
          "sir",
          "jarvis"
        ].includes(word)
      ) {
        refs.push(word);
      }
    }
  }
  return [...new Set(refs)];
}

export async function findEmailByReference(ref: string, state: ConversationState) {
  const resolved = resolveItemFromState(state, { query: ref }, {});
  if (resolved && typeof resolved === "object" && "id" in resolved) {
    return resolved as EmailStateItem;
  }

  const emails = state.activeItems.length
    ? (state.activeItems as EmailStateItem[])
    : await getRecentGmailMessages(30);

  const normalized = normalizeText(ref);
  const parts = normalized.split(" ").filter((p) => p.length > 1);

  const match = emails.find((email) => {
    const hay = normalizeText(`${email.from} ${email.subject} ${email.snippet}`);
    return hay.includes(normalized) || parts.every((p) => hay.includes(p));
  });

  return match || null;
}

export async function findEmailFromMessage(message: string, state: ConversationState) {
  const refs = extractNameRefs(message);
  for (const ref of refs) {
    const found = await findEmailByReference(ref, state);
    if (found) return found;
  }
  if (state.selectedItem && typeof state.selectedItem === "object") {
    return state.selectedItem as EmailStateItem;
  }
  if (state.operatorContext?.lastEmailAction?.messageId) {
    const last = state.operatorContext.lastEmailAction;
    return {
      id: last.messageId,
      from: last.from,
      subject: last.subject,
      snippet: "",
      time: last.at
    };
  }
  return null;
}

export async function tryOperatorStatusRoute(
  message: string,
  state: ConversationState,
  sessionId: string
) {
  if (!isAskAboutPastActions(message) && !isSendVerification(message)) return null;
  if (getGeneratedImage(sessionId)) return null;
  routeLog("hit: tryOperatorStatusRoute");

  const refs = extractNameRefs(message);
  const logs = refs.length
    ? refs.flatMap((r) => searchExecutionLog(r, 10)).filter(isOperatorFacingLog)
    : getExecutionLogSince(new Date(Date.now() - executionLogWindowMs(message)), 80).filter(
        isOperatorFacingLog
      );

  const uniqueLogs = [...new Map(logs.map((l) => [l.id, l])).values()];

  if (isSendVerification(message)) {
    const ref = refs[0] || "";
    const matching = uniqueLogs.filter((l) =>
      normalizeText(`${l.summary} ${l.itemId}`).includes(ref || "___none___")
    );

    if (!matching.length) {
      const email = ref ? await findEmailByReference(ref, state) : await findEmailFromMessage(message, state);
      if (email && isSendCommand(message)) {
        return null;
      }
      return {
        speech: ref
          ? `No confirmed send to ${ref} in my execution log, sir. I have not sent that yet.`
          : "No confirmed send on that in my log, sir. Which contact should I send to?",
        intent: "execution.log",
        ui: { panel: "emails" as const, action: "open" as const, data: state.activeItems },
        toolExecuted: false
      };
    }

    const last = matching[0];
    if (last.result === "failed") {
      return {
        speech: `That send failed, sir. ${last.summary}`,
        intent: "execution.log",
        ui: { panel: null, data: [], action: null },
        toolExecuted: true
      };
    }

    return {
      speech: `Yes sir. Log confirms: ${humanizeLogSummary(last.summary)}`,
      intent: "execution.log",
      ui: { panel: "emails" as const, action: "keep_open" as const, data: state.activeItems },
      toolExecuted: true
    };
  }

  if (!uniqueLogs.length) {
    return {
      speech: "Nothing logged autonomously today yet, sir. What do you need?",
      intent: "execution.log",
      ui: { panel: null, data: [], action: null },
      toolExecuted: true
    };
  }

  const speech = sanitizeSpeechForClient(buildExecutionSummarySpeech(uniqueLogs));

  return {
    speech,
    intent: "execution.log",
    ui: { panel: null, data: [], action: null },
    toolExecuted: true
  };
}

export function enforceTruthfulSpeech(
  speech: string,
  intent: string,
  toolConfirmedSend: boolean
) {
  const claimsAction = /\b(sent|replied|handled.*send|fired off|shoot.*over)\b/i.test(speech);
  const sendIntent = intent === "gmail.send_reply" || intent === "execute.send";

  if (claimsAction && !sendIntent && !toolConfirmedSend) {
    const logs = getExecutionLogToday(5).filter(
      (l) => l.result === "success" && isOperatorFacingLog(l)
    );
    if (logs.length) {
      return `Checking the log, sir. ${humanizeLogSummary(logs[0].summary)}`;
    }
    return "I have not confirmed that send in my execution log yet, sir. Say the word and I will send it now.";
  }

  return speech;
}
