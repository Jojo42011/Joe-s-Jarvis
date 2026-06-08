import { Router } from "express";
import {
  getOperationsSnapshot,
  getQueue,
  getQueueGroupedByUrgency,
  getRecentCalls,
  getRecentCommunicationLogs,
  getUpcomingAppointments,
  countHandledQueueItems,
  getUnacknowledgedNotes,
  markNotesSeenInRundown
} from "../db/queries";
import { formatNotesBriefingSnippet } from "../services/notes";
import { enrichEmailsForPanel, getRecentGmailMessages } from "../services/gmail";
import { generateOperatorBriefing } from "../services/claude";
import { briefLog } from "../utils/requestLog";

export const rundownRouter = Router();

export const RUNDOWN_CACHE_MS = 15 * 60 * 1000;
export const RUNDOWN_PREWARM_MS = 10 * 60 * 1000;

type RundownResponse = {
  status: string;
  briefing: string;
  summary: string;
  operations: Record<string, unknown>;
  priorityQueue: ReturnType<typeof getQueueGroupedByUrgency>;
  emails: Awaited<ReturnType<typeof getRecentGmailMessages>>;
  calls: ReturnType<typeof getRecentCalls>;
  recentLogs: ReturnType<typeof getRecentCommunicationLogs>;
  appointments: Array<{
    callerName: string | null;
    serviceRequested: string | null;
    preferredDate: string | null;
    status: string;
    calendarLink: string | null;
  }>;
};

let rundownCache: {
  at: number;
  signature: string;
  body: RundownResponse;
} | null = null;

let prewarmInFlight = false;

function rundownCacheSignature() {
  const grouped = getQueueGroupedByUrgency();
  const queueFlat = getQueue(false);
  const handledQueueCount = countHandledQueueItems();
  return JSON.stringify({
    grouped,
    handledQueueItemsLifetime: handledQueueCount,
    priorityQueueItems: queueFlat.length
  });
}

export function getRundownCacheAge(): number {
  return rundownCache ? Date.now() - rundownCache.at : Infinity;
}

async function getRundownBriefing(queuePayload: Record<string, unknown>): Promise<string> {
  const signature = JSON.stringify(queuePayload);
  briefLog("rundown briefing — generating operator briefing");
  return generateOperatorBriefing(signature);
}

export async function buildRundownResponse(): Promise<RundownResponse> {
  const operations = getOperationsSnapshot();
  const recentLogs = getRecentCommunicationLogs(8);
  const calls = getRecentCalls(20);
  const emails = enrichEmailsForPanel(await getRecentGmailMessages(8));
  const priorityEmails = emails.filter((email) => email.priority === "HIGH");
  const forwardedCalls = calls.filter((call) => call.outcome === "FORWARDED").length;

  const grouped = getQueueGroupedByUrgency();
  const queueFlat = getQueue(false);
  const handledQueueCount = countHandledQueueItems();

  const queuePayload = {
    grouped,
    handledQueueItemsLifetime: handledQueueCount,
    recentEmailCount: emails.length,
    recentCallCount: calls.length
  };

  let briefing = await getRundownBriefing(queuePayload);
  const recentNotes = getUnacknowledgedNotes(24);
  if (recentNotes.length) {
    const notesSpeech = formatNotesBriefingSnippet(recentNotes);
    briefing = `${briefing.trim()} ${notesSpeech}`.trim();
    markNotesSeenInRundown(recentNotes.map((n) => n.id));
  }

  const appointments = getUpcomingAppointments(20).map((a) => ({
    callerName: a.callerName,
    serviceRequested: a.serviceRequested,
    preferredDate: a.preferredDate,
    status: a.status,
    calendarLink: a.calendarLink
  }));

  return {
    status: "ready",
    briefing,
    summary: briefing,
    operations: {
      ...operations,
      priorityCalls: forwardedCalls,
      flaggedEmails: priorityEmails.length,
      priorityQueueItems: queueFlat.length
    },
    priorityQueue: grouped,
    emails,
    calls,
    recentLogs,
    appointments
  };
}

export async function prewarmRundownCacheIfStale(): Promise<void> {
  if (prewarmInFlight) return;
  const age = getRundownCacheAge();
  if (age < RUNDOWN_PREWARM_MS) return;

  prewarmInFlight = true;
  try {
    briefLog(`rundown pre-warm — cache age ${Math.round(age / 1000)}s`);
    const signature = rundownCacheSignature();
    const body = await buildRundownResponse();
    rundownCache = { at: Date.now(), signature, body };
    briefLog("rundown pre-warm complete");
  } catch (error) {
    console.warn("[rundown] pre-warm failed:", error);
  } finally {
    prewarmInFlight = false;
  }
}

rundownRouter.get("/rundown", async (_req, res, next) => {
  try {
    const signature = rundownCacheSignature();
    const age = getRundownCacheAge();

    if (rundownCache && rundownCache.signature === signature && age < RUNDOWN_CACHE_MS) {
      briefLog(`rundown full cache hit (${Math.round(age / 1000)}s old) — skipping Gmail`);
      res.json(rundownCache.body);
      return;
    }

    briefLog("rundown cache miss — fetching Gmail and building response");
    const body = await buildRundownResponse();
    rundownCache = { at: Date.now(), signature, body };
    res.json(body);
  } catch (error) {
    next(error);
  }
});
