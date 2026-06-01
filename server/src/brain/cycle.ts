import {
  addToQueue,
  logExecution,
  markQueueItemHandled,
  markQueueRetriageAttempted,
  pendingQueueItemExists,
  setSystemState
} from "../db/queries";
import { brainLog } from "../utils/requestLog";
import { prewarmRundownCacheIfStale } from "../routes/rundown";
import { Communication } from "./communication";
import { Execution } from "./execution";
import { Judgment } from "./judgment";
import { Perception } from "./perception";
import type { JudgmentDecision } from "./types";

const perception = new Perception();
const judgment = new Judgment();
const execution = new Execution();
const communication = new Communication();

let cycleRunning = false;

function queueFromDecision(decision: JudgmentDecision) {
  const urgency =
    decision.urgency ||
    (decision.notifyUrgency === "now" ? "NOW" : decision.notifyUrgency === "next_briefing" ? "TODAY" : "THIS_WEEK");

  addToQueue({
    type: decision.itemType,
    source_id: decision.itemId,
    summary: decision.summary,
    action_needed: decision.reason,
    urgency,
    handled: false,
    raw_data: JSON.stringify({ judgment: decision })
  });
}

export async function brainCycle() {
  if (cycleRunning) {
    brainLog("cycle skipped — previous run active");
    return;
  }

  cycleRunning = true;
  const cycleId = Date.now().toString(36);
  brainLog(`cycle ${cycleId} start`);
  try {
    const payload = await perception.sense();
    brainLog(
      `cycle ${cycleId} perception — queue: ${payload.currentQueueSize} newEmails: ${payload.newEmails.length}`
    );
    const decisions = await judgment.evaluate(payload);
    brainLog(`cycle ${cycleId} judgment — ${decisions.length} decision(s)`);
    const results = [];

    for (const decision of decisions) {
      if (decision.sourceQueueId) {
        if (decision.action === "execute_now") {
          const result = await execution.execute(decision);
          results.push(result);
          markQueueItemHandled(decision.sourceQueueId);
        } else if (decision.action === "ignore") {
          markQueueItemHandled(decision.sourceQueueId);
        } else if (decision.action === "queue") {
          markQueueRetriageAttempted(decision.sourceQueueId);
        }
        continue;
      }

      if (pendingQueueItemExists(decision.itemType, decision.itemId) && decision.action === "ignore") {
        continue;
      }

      if (decision.action === "execute_now") {
        const result = await execution.execute(decision);
        results.push(result);
      } else if (decision.action === "queue") {
        if (!pendingQueueItemExists(decision.itemType, decision.itemId)) {
          queueFromDecision(decision);
        }
      }
    }

    const comms = await communication.decide(results, payload, "cycle");

    if (results.length) {
      const lines = results
        .slice(0, 5)
        .map((r) => (r.success ? r.summary : `${r.summary} (failed)`))
        .join(" | ");
      logExecution({
        type: "system",
        action: "brain.cycle",
        summary: `Autonomous cycle: ${results.length} action(s) — ${lines}`.slice(0, 500),
        result: results.some((r) => !r.success) ? "failed" : "success"
      });
    }

    brainLog(
      `cycle ${cycleId} end — executed: ${results.length} speak: ${comms.shouldSpeak ? "yes" : "no"}`
    );

    if (comms.shouldSpeak && comms.message) {
      await setSystemState(
        "active_alert",
        JSON.stringify({
          hasAlert: true,
          summary: comms.message,
          message: comms.message,
          panel: comms.uiPanel,
          data: comms.uiData
        })
      );
      communication.recordBriefing(comms.briefedItemIds);
    }
  } catch (error) {
    brainLog(`cycle error: ${error instanceof Error ? error.message : "unknown"}`);
    console.error("[brain] cycle error:", error);
  } finally {
    cycleRunning = false;
    setImmediate(() => {
      void prewarmRundownCacheIfStale();
    });
  }
}

export { perception, judgment, execution, communication };
