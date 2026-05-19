import { Router } from "express";
import { getExecutionLogSince } from "../db/queries";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "joes-jarvis",
    status: "online",
    timestamp: new Date().toISOString()
  });
});

healthRouter.get("/execution/log", (_req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const entries = getExecutionLogSince(since, 60).map((e) => ({
    id: e.id,
    type: e.type,
    action: e.action,
    summary: e.summary,
    result: e.result,
    itemId: e.itemId,
    timestamp: e.timestamp
  }));
  res.json({ entries, count: entries.length });
});
