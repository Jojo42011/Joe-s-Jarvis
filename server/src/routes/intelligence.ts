import { Router } from "express";
import { Judgment } from "../brain/judgment";
import { Perception, runWorldIntelPipeline } from "../brain/perception";
import {
  getWorldIntelById,
  getWorldIntelSinceHours
} from "../brain/worldIntelStore";
import {
  clearAlertIfMatchingQueueItem,
  clearActiveAlertState,
  getActiveAlertPayload,
  getQueueGroupedByUrgency,
  markQueueItemHandled
} from "../db/queries";

export const intelligenceRouter = Router();

intelligenceRouter.get("/intelligence/queue", (_req, res) => {
  const grouped = getQueueGroupedByUrgency();
  res.json({ grouped, flat: [...grouped.NOW, ...grouped.TODAY, ...grouped.THIS_WEEK] });
});

intelligenceRouter.get("/intelligence/alerts", (_req, res) => {
  const { hasAlert, alert } = getActiveAlertPayload();
  res.json({ hasAlert, alert });
});

intelligenceRouter.post("/intelligence/alerts/clear", (_req, res) => {
  clearActiveAlertState();
  res.json({ status: "cleared" });
});

intelligenceRouter.post("/intelligence/handled/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  markQueueItemHandled(id);
  clearAlertIfMatchingQueueItem(id);
  res.json({ status: "ok", id });
});

intelligenceRouter.get("/intelligence/world", (_req, res) => {
  const items = getWorldIntelSinceHours(48).map((row) => ({
    id: row.id,
    query: row.query,
    summary: row.summary,
    relevance: row.relevance,
    briefed: row.briefed,
    fetchedAt: row.fetchedAt
  }));
  res.json({ items, count: items.length });
});

intelligenceRouter.post("/intelligence/world/search", async (req, res, next) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const perception = new Perception();
    const row = await perception.runOnDemandWorldSearch(query);
    if (!row) {
      res.status(503).json({ error: "Search unavailable — check BRAVE_API_KEY" });
      return;
    }

    const judgment = new Judgment();
    await judgment.judgeWorldIntel([row.id]);

    const updated = getWorldIntelById(row.id);
    res.json({
      id: row.id,
      query,
      summary: updated?.summary || null,
      relevance: updated?.relevance || null,
      results: updated?.resultsJson ? JSON.parse(updated.resultsJson) : null
    });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.post("/intelligence/world/run", async (_req, res, next) => {
  try {
    await runWorldIntelPipeline();
    const items = getWorldIntelSinceHours(48);
    res.json({ status: "ok", itemsProcessed: items.length });
  } catch (error) {
    next(error);
  }
});
