import {
  getCallsSince,
  getExecutionLogSince,
  getLastBriefedDate,
  getLastBriefedItems,
  getLastBriefingTime,
  getQueue,
  getSystemState,
  logExecution,
  recordActivationBriefingDelivered,
  setLastBriefedDate,
  type CallLogItem,
  type ExecutionLogEntry,
  type PriorityQueueItem
} from "../db/queries";
import { buildDynamicSystemPrompt } from "../config/systemPrompt";
import { sanitizeSpeech } from "./communication";
import { generateActivationBriefingFromContext } from "../services/claude";
import {
  getQueueForBriefing,
  markQueueItemBriefed
} from "./queueEscalation";
import {
  formatCurrentTimeForPrompt,
  formatElapsedSinceActive,
  getActivationGreeting,
  getOhioDateKey,
  getOhioTimeOfDayGreeting
} from "../utils/temporal";
import { humanizeLogSummary, isOperatorFacingLog } from "../utils/executionSummary";

const SILENCE_WINDOW_MS = 5 * 60 * 1000;
export const ALL_CLEAR = "All clear sir. What do you need?";
const MONITORED_ONLY_SPEECH =
  "Nothing new since last briefing sir. Items are still being monitored.";
const MAX_BRIEF_ITEMS = 3;

export type ActivationBriefItem = {
  briefId: string;
  summary: string;
  detail?: string;
  queueId?: number;
};

export type ActivationContext = {
  ohioTime: string;
  greeting: string;
  elapsedSinceJoeActive: string;
  lastBriefingTime: Date | null;
  joeLastActive: Date | null;
  executions: ActivationBriefItem[];
  pendingQueue: ActivationBriefItem[];
  calls: ActivationBriefItem[];
  briefedIds: Set<string>;
  totalOpenQueue: number;
};

export type ActivationBriefingResult = {
  speech: string;
  intent: string;
  uiPanel: "rundown" | null;
  uiData: unknown[] | null;
  briefedItemIds: string[];
  silenced: boolean;
};

function parseStateDate(key: string): Date | null {
  const raw = getSystemState(key);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function execBriefId(id: number): string {
  return `exec:${id}`;
}

export function queueBriefId(id: number): string {
  return `queue:${id}`;
}

export function callBriefId(id: number): string {
  return `call:${id}`;
}

function isBriefableExecution(row: ExecutionLogEntry): boolean {
  if (row.result !== "success") return false;
  if (!isOperatorFacingLog(row)) return false;
  if (row.type === "morning_brief" && row.action === "briefing_delivered") return false;
  if (row.action === "activation_briefing") return false;
  return true;
}

function mapExecutionItem(row: ExecutionLogEntry): ActivationBriefItem {
  return {
    briefId: execBriefId(row.id),
    summary: humanizeLogSummary(row.summary || `${row.action} on ${row.type}`),
    detail: `${row.type} · ${row.action}`
  };
}

function mapQueueItem(q: PriorityQueueItem): ActivationBriefItem {
  return {
    briefId: queueBriefId(q.id),
    queueId: q.id,
    summary: (q.summary || "Queue item").slice(0, 200),
    detail: q.actionNeeded || q.urgency || "Needs your decision"
  };
}

function mapCallItem(c: CallLogItem): ActivationBriefItem {
  const from = c.callerName || c.from || c.callerNumber || "Unknown caller";
  return {
    briefId: callBriefId(c.id),
    summary: `${from} — ${c.reason || c.callReason || c.outcome}`.slice(0, 200),
    detail: c.outcome
  };
}

function limitBriefContext(ctx: ActivationContext): ActivationContext {
  const combined = [
    ...ctx.pendingQueue.map((item) => ({ kind: "queue" as const, item })),
    ...ctx.executions.map((item) => ({ kind: "exec" as const, item })),
    ...ctx.calls.map((item) => ({ kind: "call" as const, item }))
  ].slice(0, MAX_BRIEF_ITEMS);

  return {
    ...ctx,
    pendingQueue: combined.filter((e) => e.kind === "queue").map((e) => e.item),
    executions: combined.filter((e) => e.kind === "exec").map((e) => e.item),
    calls: combined.filter((e) => e.kind === "call").map((e) => e.item)
  };
}

function allClearSpeech(now: Date = new Date()): string {
  return `${getActivationGreeting(now)} All clear.`;
}

/** Pull real operator data for activation briefing. */
export function buildActivationContext(now: Date = new Date()): ActivationContext {
  const briefedList = getLastBriefedItems();
  const briefedIds = new Set(briefedList);

  const lastBriefingIso = getLastBriefingTime();
  const lastBriefingTime = lastBriefingIso ? new Date(lastBriefingIso) : null;
  const sinceBriefing = lastBriefingTime && !Number.isNaN(lastBriefingTime.getTime())
    ? lastBriefingTime
    : new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const joeLastActive = parseStateDate("joe_last_active");

  const executionRows = getExecutionLogSince(sinceBriefing, 200)
    .filter(isBriefableExecution)
    .filter((row) => !briefedIds.has(execBriefId(row.id)))
    .map(mapExecutionItem);

  const pendingQueue = getQueueForBriefing().map(mapQueueItem);
  const totalOpenQueue = getQueue(false).length;

  const callRows = getCallsSince(sinceBriefing, 80)
    .filter((c) => !briefedIds.has(callBriefId(c.id)))
    .map(mapCallItem);

  return {
    ohioTime: formatCurrentTimeForPrompt(now).replace(/^Current time: /, ""),
    greeting: getOhioTimeOfDayGreeting(now),
    elapsedSinceJoeActive: formatElapsedSinceActive(joeLastActive, now),
    lastBriefingTime,
    joeLastActive,
    executions: executionRows,
    pendingQueue,
    calls: callRows,
    briefedIds,
    totalOpenQueue
  };
}

/** True when Joe was briefed <5 min ago and nothing new needs saying. */
export function shouldSilenceActivationBriefing(ctx: ActivationContext, now: Date = new Date()): boolean {
  if (!ctx.lastBriefingTime) return false;
  const msSince = now.getTime() - ctx.lastBriefingTime.getTime();
  if (msSince >= SILENCE_WINDOW_MS) return false;

  const since = ctx.lastBriefingTime;
  const newExec = getExecutionLogSince(since, 50).some(
    (row) => isBriefableExecution(row) && !ctx.briefedIds.has(execBriefId(row.id))
  );
  if (newExec) return false;

  const newCalls = getCallsSince(since, 20).some((c) => !ctx.briefedIds.has(callBriefId(c.id)));
  if (newCalls) return false;

  if (getQueueForBriefing().length > 0) return false;
  if (ctx.totalOpenQueue > 0) return false;

  return true;
}

export function isActivationNetNewEmpty(ctx: ActivationContext): boolean {
  return (
    ctx.executions.length === 0 &&
    ctx.pendingQueue.length === 0 &&
    ctx.calls.length === 0 &&
    ctx.totalOpenQueue === 0
  );
}

function buildMonitoredOnlySpeech(ctx: ActivationContext, now: Date = new Date()): string {
  const n = ctx.totalOpenQueue;
  return `${getActivationGreeting(now)} ${MONITORED_ONLY_SPEECH} ${n} item${n === 1 ? "" : "s"} still open.`;
}

function buildFallbackActivationSpeech(ctx: ActivationContext, now: Date = new Date()): string {
  const limited = limitBriefContext(ctx);
  if (limited.totalOpenQueue === 0 && limited.executions.length === 0 && limited.calls.length === 0) {
    return allClearSpeech(now);
  }

  const parts: string[] = [getActivationGreeting(now)];
  if (limited.executions.length) {
    const top = limited.executions.slice(0, 3).map((e) => e.summary);
    parts.push(`While you were away I ${top.join(", ")}.`);
  }
  if (limited.pendingQueue.length) {
    parts.push(
      `${limited.pendingQueue.length} item${limited.pendingQueue.length === 1 ? "" : "s"} need your attention.`
    );
  } else if (limited.totalOpenQueue > 0) {
    return buildMonitoredOnlySpeech(limited, now);
  } else if (limited.calls.length) {
    parts.push(
      `${limited.calls.length} call${limited.calls.length === 1 ? "" : "s"} logged since your last briefing.`
    );
  } else {
    parts.push("All clear on pending items, sir.");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function collectBriefedIds(ctx: ActivationContext): string[] {
  return [
    ...ctx.executions.map((e) => e.briefId),
    ...ctx.pendingQueue.map((q) => q.briefId),
    ...ctx.calls.map((c) => c.briefId)
  ];
}

function markBriefedQueueItems(ctx: ActivationContext) {
  for (const item of ctx.pendingQueue) {
    if (item.queueId != null) {
      markQueueItemBriefed(item.queueId);
    }
  }
}

function greetingOnlyResult(now: Date, intent: string, silenced = false): ActivationBriefingResult {
  return {
    speech: getActivationGreeting(now),
    intent,
    uiPanel: null,
    uiData: null,
    briefedItemIds: [],
    silenced
  };
}

/**
 * Full activation briefing for __JARVIS_ACTIVATE__ — DB-only, no Gmail perception round-trip.
 */
export async function handleJoeActivation(): Promise<ActivationBriefingResult> {
  const now = new Date();
  const ctx = buildActivationContext(now);
  const todayOhio = getOhioDateKey(now);
  const isFirstOpenToday = getLastBriefedDate() !== todayOhio;

  if (!isFirstOpenToday) {
    return greetingOnlyResult(now, "activation.greeting");
  }

  if (shouldSilenceActivationBriefing(ctx, now)) {
    return greetingOnlyResult(now, "activation.clear", true);
  }

  if (isActivationNetNewEmpty(ctx)) {
    return {
      speech: allClearSpeech(now),
      intent: "activation.clear",
      uiPanel: null,
      uiData: null,
      briefedItemIds: [],
      silenced: false
    };
  }

  if (
    ctx.pendingQueue.length === 0 &&
    ctx.executions.length === 0 &&
    ctx.calls.length === 0 &&
    ctx.totalOpenQueue > 0
  ) {
    const speech = buildMonitoredOnlySpeech(ctx, now);
    recordActivationBriefingDelivered([], speech);
    setLastBriefedDate();
    return {
      speech,
      intent: "activation.monitored",
      uiPanel: null,
      uiData: null,
      briefedItemIds: [],
      silenced: false
    };
  }

  const briefCtx = limitBriefContext(ctx);
  const system = await buildDynamicSystemPrompt();
  let speech = await generateActivationBriefingFromContext(briefCtx, system);
  speech = sanitizeSpeech(speech || buildFallbackActivationSpeech(ctx, now));
  if (!speech || /^one moment/i.test(speech)) {
    speech = sanitizeSpeech(buildFallbackActivationSpeech(ctx, now));
  }
  if (!speech.startsWith("Good ")) {
    speech = `${getActivationGreeting(now)} ${speech}`;
  }

  const briefedItemIds = collectBriefedIds(ctx);
  markBriefedQueueItems(ctx);
  recordActivationBriefingDelivered(briefedItemIds, speech);
  setLastBriefedDate();

  logExecution({
    type: "morning_brief",
    action: "activation_briefing",
    summary: `Activation brief. Actions: ${ctx.executions.length}, Queue due: ${ctx.pendingQueue.length}, Open: ${ctx.totalOpenQueue}, Calls: ${ctx.calls.length}`,
    result: "success"
  });

  const panelItems = ctx.pendingQueue.map((q) => ({
    urgency: q.detail,
    type: "queue",
    summary: q.summary,
    actionNeeded: q.detail
  }));

  return {
    speech,
    intent: "activation.briefing",
    uiPanel: ctx.pendingQueue.length || ctx.executions.length ? "rundown" : null,
    uiData:
      ctx.pendingQueue.length || ctx.executions.length
        ? [{ queueItems: panelItems, executions: ctx.executions }]
        : null,
    briefedItemIds,
    silenced: false
  };
}
