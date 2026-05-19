import { Router } from "express";
import {
  getOperationsSnapshot,
  getQueue,
  getQueueGroupedByUrgency,
  getRecentCalls,
  getRecentCommunicationLogs,
  countHandledQueueItems
} from "../db/queries";
import { getRecentGmailMessages } from "../services/gmail";
import { generateOperatorBriefing } from "../services/claude";

export const rundownRouter = Router();

rundownRouter.get("/rundown", async (_req, res, next) => {
  try {
    const operations = getOperationsSnapshot();
    const recentLogs = getRecentCommunicationLogs(8);
    const calls = getRecentCalls(20);
    const emails = await getRecentGmailMessages(8);
    const priorityEmails = emails.filter((email) => email.priority === "HIGH");
    const forwardedCalls = calls.filter((call) => call.outcome === "FORWARDED").length;

    const grouped = getQueueGroupedByUrgency();
    const queueFlat = getQueue(false);
    const handledQueueCount = countHandledQueueItems();

    const briefing = await generateOperatorBriefing(
      JSON.stringify({
        grouped,
        handledQueueItemsLifetime: handledQueueCount,
        recentEmailCount: emails.length,
        recentCallCount: calls.length
      })
    );

    res.json({
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
      recentLogs
    });
  } catch (error) {
    next(error);
  }
});
