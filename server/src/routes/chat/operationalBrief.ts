import { getActiveAlertPayload, type ConversationState } from "../../db/queries";
import {
  buildFallbackBriefingSpeech,
  compileBriefingDataForSession,
  sanitizeSpeech
} from "../../brain/communication";
import { briefLog, reqLog, routeLog } from "../../utils/requestLog";
import { normalizeText, sanitizeSpeechForClient } from "./utils";
import {
  recordBriefingKeys,
  recordSpokenFromResponse,
  topicSpokenKey
} from "./spokenSessionTracker";
import type { IntentResponse } from "./types";

export function isOperationalBriefQuery(message: string): boolean {
  const t = normalizeText(message);
  return (
    /\b(brief me|my brief|morning brief|operational brief|full brief|give me a brief|daily brief)\b/.test(
      t
    ) ||
    /\b(rundown|catch me up|fill me in|status update|what have i missed|what s new|whats new)\b/.test(
      t
    ) ||
    /\b(what did you do|what have you done|what did you handle|last night|overnight)\b/.test(t) ||
    /\b(what else should i know|anything else i should know|what should i know)\b/.test(t)
  );
}

export function tryOperationalBriefRoute(
  message: string,
  _state: ConversationState,
  sessionId: string
): IntentResponse | null {
  if (!isOperationalBriefQuery(message)) return null;

  routeLog("matched: tryOperationalBriefRoute");
  briefLog("judgment: operational brief — execution_log + memory + queue");

  const { data, includedKeys } = compileBriefingDataForSession(sessionId);
  const queueOpen = data.queueCount;
  const alertPayload = getActiveAlertPayload();

  reqLog(
    `execution_log: ${data.emailsHandled + data.emailsArchived} email actions | memory: ${data.memoryPromotions.length} items | queue: ${queueOpen} open`
  );

  const parts: string[] = [];
  const core = buildFallbackBriefingSpeech(data);
  if (core) parts.push(core);

  if (alertPayload.hasAlert && alertPayload.alert?.summary) {
    parts.push(`Priority alert: ${sanitizeSpeech(alertPayload.alert.summary)}`);
  }

  const speech =
    parts.length > 0
      ? parts.join(" ").replace(/\s+/g, " ").trim()
      : "All quiet on my side, sir. Queue is clear. Say the word if you want email or weather.";

  recordBriefingKeys(sessionId, includedKeys);
  recordBriefingKeys(sessionId, [topicSpokenKey("morning_brief"), topicSpokenKey("rundown")]);
  recordSpokenFromResponse(sessionId, {
    speech,
    intent: "morning_brief",
    uiData: queueOpen > 0 ? [{ queueOpenCount: queueOpen }] : []
  });

  return {
    speech: sanitizeSpeechForClient(speech),
    intent: "morning_brief",
    entities: {},
    ui: {
      panel: queueOpen > 0 ? "rundown" : null,
      data: queueOpen > 0 ? [{ queueOpenCount: queueOpen }] : [],
      action: queueOpen > 0 ? "open" : null
    },
    tool: { name: null, args: {} }
  };
}
