import { Router } from "express";
import {
  cleanupStaleQueueItems,
  escalateQueueItemUrgency,
  getActionListPayload,
  getQueueStatusPayload,
  markQueueItemHandled,
  snoozeQueueItem
} from "../brain/queueEscalation";
import { clearAlertIfMatchingQueueItem } from "../db/queries";

export const queueRouter = Router();

queueRouter.get("/queue", (_req, res) => {
  res.json(getQueueStatusPayload());
});

queueRouter.get("/action-list", (_req, res) => {
  res.json(getActionListPayload());
});

queueRouter.post("/queue/cleanup", (_req, res) => {
  const result = cleanupStaleQueueItems();
  res.json({ success: true, ...result });
});

queueRouter.post("/queue/:id/handle", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const reason =
    typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim()
      : "joe_explicit";

  markQueueItemHandled(id, reason);
  clearAlertIfMatchingQueueItem(id);
  res.json({ success: true, id });
});

queueRouter.post("/queue/:id/snooze", (req, res) => {
  const id = Number(req.params.id);
  const hours = Number(req.body?.hours);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    res.status(400).json({ error: "hours must be a positive number" });
    return;
  }

  const result = snoozeQueueItem(id, hours);
  if (!result) {
    res.status(404).json({ error: "Queue item not found" });
    return;
  }

  res.json({ success: true, resurfaces_at: result.resurfacesAt });
});

queueRouter.post("/queue/:id/escalate", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const result = escalateQueueItemUrgency(id);
  if (!result) {
    res.status(404).json({ error: "Queue item not found" });
    return;
  }

  res.json({ success: true, new_urgency: result.newUrgency });
});
