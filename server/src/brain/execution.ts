import {
  addToQueue,
  getQueue,
  logExecution,
  markQueueItemHandled,
  pendingQueueItemExists
} from "../db/queries";
import { archiveGmailMessage, hasReadableInboundEmailContent, sendGmailReply } from "../services/gmail";
import { generateAutonomousEmailReply } from "../services/claude";
import { emailBodyHasOperatorContamination, resolveOutboundEmailBody } from "../utils/emailBody";
import type { ExecutionResult, JudgmentDecision } from "./types";

const BLOCKED_OUTBOUND_PHRASES = [
  "what's the content",
  "what is the content",
  "pull up the full thread",
  "i'll draft",
  "i will draft",
  "let me",
  "i need",
  "came through empty"
] as const;

const EMPTY_BODY_QUEUE_NOTE = "Email body empty — needs Joe's review";
const OPERATOR_COMMENTARY_BLOCK_MSG = "Blocked outbound email — operator commentary detected";

function outboundHasOperatorCommentary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  for (const phrase of BLOCKED_OUTBOUND_PHRASES) {
    if (lower.includes(phrase)) return true;
  }

  if (emailBodyHasOperatorContamination(trimmed)) return true;

  if (
    /\b(i'll|i will|let me|i need|i can|i should|i've|i have)\b[^.!?]{0,80}\b(draft|thread|content|body|email|message|review|joe|pull up)\b/i.test(
      trimmed
    )
  ) {
    return true;
  }

  return false;
}

function queueEmailForJoe(decision: JudgmentDecision, actionNeeded: string) {
  if (pendingQueueItemExists(decision.itemType, decision.itemId)) return;

  const urgency =
    decision.urgency ||
    (decision.notifyUrgency === "now" ? "NOW" : decision.notifyUrgency === "next_briefing" ? "TODAY" : "THIS_WEEK");

  addToQueue({
    type: decision.itemType,
    source_id: decision.itemId,
    summary: decision.summary || actionNeeded,
    action_needed: actionNeeded,
    urgency,
    handled: false,
    raw_data: JSON.stringify({ judgment: { ...decision, action: "queue", reason: actionNeeded } })
  });
}

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
          summary = messageId ? "Archived a spam email." : "Archived a message.";
          break;
        }
        case "send_reply":
        case "draft_and_send":
        case "email.send_reply": {
          const blocked = await this.generateAndSendReply(plan.args, decision);
          summary = blocked.summary;
          if (blocked.blocked) {
            return {
              success: false,
              summary,
              itemId,
              itemType,
              action: plan.tool,
              notifyJoe: true,
              notifyUrgency: decision.notifyUrgency || "next_briefing"
            };
          }
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

  private blockOutboundEmail(decision: JudgmentDecision, logMsg: string): string {
    queueEmailForJoe(decision, logMsg);
    logExecution({
      type: decision.itemType,
      action: "email.send_blocked",
      item_id: decision.itemId,
      summary: logMsg,
      result: "failed"
    });
    return logMsg;
  }

  async generateAndSendReply(
    args: Record<string, unknown>,
    decision: JudgmentDecision
  ): Promise<{ summary: string; blocked: boolean }> {
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
    const bodyHint = String(args.body || "");

    const readable = await hasReadableInboundEmailContent({ messageId, snippet, subject });
    if (!readable) {
      return {
        summary: this.blockOutboundEmail(decision, EMPTY_BODY_QUEUE_NOTE),
        blocked: true
      };
    }

    if (bodyHint && outboundHasOperatorCommentary(bodyHint)) {
      return {
        summary: this.blockOutboundEmail(decision, OPERATOR_COMMENTARY_BLOCK_MSG),
        blocked: true
      };
    }

    const body = await resolveOutboundEmailBody(bodyHint, () =>
      generateAutonomousEmailReply({
        from,
        subject,
        snippet,
        emailType
      })
    );

    if (outboundHasOperatorCommentary(body)) {
      return {
        summary: this.blockOutboundEmail(decision, OPERATOR_COMMENTARY_BLOCK_MSG),
        blocked: true
      };
    }

    await sendGmailReply({
      messageId,
      threadId,
      to: from,
      subject,
      body
    });

    return { summary: `Replied to ${from} re: ${subject}`, blocked: false };
  }
}
