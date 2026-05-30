import { Router } from "express";
import {
  getOperationsSnapshot,
  getQueue,
  getQueueGroupedByUrgency,
  getRecentCalls,
  getRecentCommunicationLogs,
  getUpcomingAppointments,
  countHandledQueueItems
} from "../db/queries";
import { getRecentGmailMessages } from "../services/gmail";
import { generateOperatorBriefing } from "../services/claude";
import { briefLog } from "../utils/requestLog";

export const rundownRouter = Router();

const RUNDOWN_CACHE_MS = 5 * 60 * 1000;

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

async function getRundownBriefing(queuePayload: Record<string, unknown>): Promise<string> {
  const signature = JSON.stringify(queuePayload);
  briefLog("rundown briefing — generating operator briefing");
  return generateOperatorBriefing(signature);
}

rundownRouter.get("/rundown", async (_req, res, next) => {
  try {
    const signature = rundownCacheSignature();
    const age = rundownCache ? Date.now() - rundownCache.at : Infinity;

    if (rundownCache && rundownCache.signature === signature && age < RUNDOWN_CACHE_MS) {
      briefLog(`rundown full cache hit (${Math.round(age / 1000)}s old) — skipping Gmail`);
      res.json(rundownCache.body);
      return;
    }

    briefLog("rundown cache miss — fetching Gmail and building response");

    const operations = getOperationsSnapshot();
    const recentLogs = getRecentCommunicationLogs(8);
    const calls = getRecentCalls(20);
    const emails = await getRecentGmailMessages(8);
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

    const briefing = await getRundownBriefing(queuePayload);

    const appointments = getUpcomingAppointments(20).map((a) => ({
      callerName: a.callerName,
      serviceRequested: a.serviceRequested,
      preferredDate: a.preferredDate,
      status: a.status,
      calendarLink: a.calendarLink
    }));

    const body: RundownResponse = {
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

    rundownCache = { at: Date.now(), signature, body };
    res.json(body);
  } catch (error) {
    next(error);
  }
});
