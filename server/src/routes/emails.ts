import { Router } from "express";
import { getRecentGmailMessages, sendGmailReply } from "../services/gmail";

export const emailsRouter = Router();

emailsRouter.get("/emails", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 8);
    const emails = await getRecentGmailMessages(Math.min(Math.max(limit, 1), 20));

    res.json({
      status: "ready",
      emails
    });
  } catch (error) {
    next(error);
  }
});

emailsRouter.post("/emails/reply", async (req, res, next) => {
  try {
    const messageId = String(req.body?.messageId || "").trim();
    const threadId = String(req.body?.threadId || "").trim();
    const to = String(req.body?.to || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const body = String(req.body?.body || "").trim();

    if (!messageId || !to || !subject || !body) {
      res.status(400).json({
        error: "messageId, to, subject, and body are required"
      });
      return;
    }

    const sent = await sendGmailReply({
      messageId,
      threadId,
      to,
      subject,
      body
    });

    res.json({
      status: "sent",
      messageId: sent.id,
      threadId: sent.threadId
    });
  } catch (error) {
    next(error);
  }
});
