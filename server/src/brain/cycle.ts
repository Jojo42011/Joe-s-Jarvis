import { addToQueue, pendingQueueItemExists, setSystemState } from "../db/queries";
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
    console.log("[brain] cycle skipped — previous run active");
    return;
  }

  cycleRunning = true;
  try {
    const payload = await perception.sense();
    const decisions = await judgment.evaluate(payload);
    const results = [];

    for (const decision of decisions) {
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
    console.error("[brain] cycle error:", error);
  } finally {
    cycleRunning = false;
  }
}

export { perception, judgment, execution, communication };
