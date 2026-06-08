import { Router } from "express";
import {
  enrichEmailsForPanel,
  getEmailDetail,
  getRecentGmailMessages,
  sendGmailReply
} from "../services/gmail";

export const emailsRouter = Router();

emailsRouter.get("/emails", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 8);
    const emails = enrichEmailsForPanel(
      await getRecentGmailMessages(Math.min(Math.max(limit, 1), 20), true)
    );

    res.json({
      status: "ready",
      emails
    });
  } catch (error) {
    next(error);
  }
});

emailsRouter.get("/emails/:id/body", async (req, res, next) => {
  try {
    const detail = await getEmailDetail(String(req.params.id || ""));
    if (!detail) {
      res.status(404).json({ error: "Email not found" });
      return;
    }
    res.json(detail);
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
