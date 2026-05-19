import {
  getQueue,
  logExecution,
  markQueueItemHandled,
  pendingQueueItemExists
} from "../db/queries";
import { archiveGmailMessage, sendGmailReply } from "../services/gmail";
import { generateAutonomousEmailReply } from "../services/claude";
import type { ExecutionResult, JudgmentDecision } from "./types";

export class Execution {
  async execute(decision: JudgmentDecision): Promise<ExecutionResult> {
    const plan = decision.executionPlan;
    const itemType = decision.itemType;
    const itemId = decision.itemId;

    if (!plan || decision.action !== "execute_now") {
      return {
        success: true,
        summary: decision.reason || "No execution required.",
        itemId,
        itemType,
        action: "none",
        notifyJoe: decision.notify,
        notifyUrgency: decision.notifyUrgency
      };
    }

    try {
      let summary = decision.reason;

      switch (plan.tool) {
        case "archive":
        case "email.archive": {
          const messageId = String(plan.args.messageId || plan.args.id || "").replace(/^gmail:/, "");
          if (messageId) await archiveGmailMessage(messageId);
          summary = `Archived ${messageId || "message"}.`;
          break;
        }
        case "send_reply":
        case "draft_and_send":
        case "email.send_reply": {
          summary = await this.generateAndSendReply(plan.args);
          break;
        }
        case "log":
        case "call.log":
        case "text.log": {
          summary = decision.summary || "Logged for records.";
          break;
        }
        case "tag_priority":
        case "call.tag_priority": {
          summary = "Priority contact flagged.";
          break;
        }
        default:
          summary = decision.summary || `Executed ${plan.tool}.`;
      }

      const match = getQueue(false).find((q) => q.sourceId === itemId);
      if (match) markQueueItemHandled(match.id);

      logExecution({
        type: itemType,
        action: plan.tool,
        item_id: itemId,
        summary,
        result: "success"
      });

      return {
        success: true,
        summary,
        itemId,
        itemType,
        action: plan.tool,
        notifyJoe: decision.notify,
        notifyUrgency: decision.notifyUrgency
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Execution failed";
      const { logServiceError } = await import("../utils/logError");
      logServiceError("execution", plan.tool, error);
      logExecution({
        type: itemType,
        action: plan?.tool || "unknown",
        item_id: itemId,
        summary: msg.slice(0, 500),
        result: "failed"
      });
      return {
        success: false,
        summary: msg,
        itemId,
        itemType,
        action: plan?.tool || "unknown",
        notifyJoe: decision.notify,
        notifyUrgency: decision.notifyUrgency
      };
    }
  }

  async generateAndSendReply(args: Record<string, unknown>): Promise<string> {
    const messageId = String(args.messageId || args.id || "").replace(/^gmail:/, "");
    if (!messageId) {
      throw new Error("Cannot send reply — missing Gmail message id");
    }
    const threadId = args.threadId ? String(args.threadId) : undefined;
    const from = String(args.from || "");
    if (!from) {
      throw new Error("Cannot send reply — missing recipient");
    }
    const subject = String(args.subject || "No subject");
    const snippet = String(args.snippet || "");
    const emailType = String(args.emailType || args.category || "general");

    const body =
      String(args.body || "").trim() ||
      (await generateAutonomousEmailReply({
        from,
        subject,
        snippet,
        emailType
      }));

    await sendGmailReply({
      messageId,
      threadId,
      to: from,
      subject,
      body
    });

    return `Replied to ${from} re: ${subject}`;
  }
}
