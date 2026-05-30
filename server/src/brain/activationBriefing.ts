import {
  getCallsSince,
  getExecutionLogSince,
  getLastBriefedItems,
  getLastBriefingTime,
  getQueue,
  getSystemState,
  logExecution,
  recordActivationBriefingDelivered,
  type CallLogItem,
  type ExecutionLogEntry,
  type PriorityQueueItem
} from "../db/queries";
import { buildDynamicSystemPrompt } from "../config/systemPrompt";
import { sanitizeSpeech } from "./communication";
import { generateActivationBriefingFromContext } from "../services/claude";
import {
  formatCurrentTimeForPrompt,
  formatElapsedSinceActive,
  getOhioTimeOfDayGreeting
} from "../utils/temporal";
import { humanizeLogSummary, isOperatorFacingLog } from "../utils/executionSummary";

const SILENCE_WINDOW_MS = 5 * 60 * 1000;
const ALL_CLEAR = "All clear sir. What do you need?";

export type ActivationBriefItem = {
  briefId: string;
  summary: string;
  detail?: string;
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

/** Pull real operator data for activation; exclude IDs already in last_briefed_items. */
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

  const pendingQueue = getQueue(false)
    .filter((q) => !briefedIds.has(queueBriefId(q.id)))
    .map(mapQueueItem);

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
    briefedIds
  };
}

/** True when Joe was briefed <5 min ago and nothing new hit log or queue since then. */
export function shouldSilenceActivationBriefing(ctx: ActivationContext, now: Date = new Date()): boolean {
  if (!ctx.lastBriefingTime) return false;
  const msSince = now.getTime() - ctx.lastBriefingTime.getTime();
  if (msSince >= SILENCE_WINDOW_MS) return false;

  const since = ctx.lastBriefingTime;
  const newExec = getExecutionLogSince(since, 50).some(
    (row) => isBriefableExecution(row) && !ctx.briefedIds.has(execBriefId(row.id))
  );
  if (newExec) return false;

  const newQueue = getQueue(false).some((q) => {
    if (ctx.briefedIds.has(queueBriefId(q.id))) return false;
    const ts = new Date(q.timestamp);
    return !Number.isNaN(ts.getTime()) && ts >= since;
  });
  if (newQueue) return false;

  return true;
}

export function isActivationNetNewEmpty(ctx: ActivationContext): boolean {
  return ctx.executions.length === 0 && ctx.pendingQueue.length === 0 && ctx.calls.length === 0;
}

function buildFallbackActivationSpeech(ctx: ActivationContext): string {
  if (isActivationNetNewEmpty(ctx)) return ALL_CLEAR;

  const parts: string[] = [`${ctx.greeting}, sir.`];
  if (ctx.executions.length) {
    const top = ctx.executions.slice(0, 3).map((e) => e.summary);
    parts.push(`While you were away I ${top.join(", ")}.`);
  }
  if (ctx.pendingQueue.length) {
    parts.push(
      `${ctx.pendingQueue.length} item${ctx.pendingQueue.length === 1 ? "" : "s"} still need your attention.`
    );
  } else if (ctx.calls.length) {
    parts.push(`${ctx.calls.length} call${ctx.calls.length === 1 ? "" : "s"} logged since your last briefing.`);
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

/**
 * Full activation briefing for __JARVIS_ACTIVATE__ — DB-only, no Gmail perception round-trip.
 */
export async function handleJoeActivation(): Promise<ActivationBriefingResult> {
  const ctx = buildActivationContext();

  if (shouldSilenceActivationBriefing(ctx)) {
    return {
      speech: ALL_CLEAR,
      intent: "activation.clear",
      uiPanel: null,
      uiData: null,
      briefedItemIds: [],
      silenced: true
    };
  }

  if (isActivationNetNewEmpty(ctx)) {
    return {
      speech: ALL_CLEAR,
      intent: "activation.clear",
      uiPanel: null,
      uiData: null,
      briefedItemIds: [],
      silenced: false
    };
  }

  const system = await buildDynamicSystemPrompt();
  let speech = await generateActivationBriefingFromContext(ctx, system);
  speech = sanitizeSpeech(speech || buildFallbackActivationSpeech(ctx));
  if (!speech || /^one moment/i.test(speech)) {
    speech = sanitizeSpeech(buildFallbackActivationSpeech(ctx));
  }

  const briefedItemIds = collectBriefedIds(ctx);
  recordActivationBriefingDelivered(briefedItemIds, speech);

  logExecution({
    type: "morning_brief",
    action: "activation_briefing",
    summary: `Activation brief. Actions: ${ctx.executions.length}, Queue: ${ctx.pendingQueue.length}, Calls: ${ctx.calls.length}`,
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
