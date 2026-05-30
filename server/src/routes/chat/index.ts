import { Router } from "express";
import { clearState } from "../../db/queries";
import { getSessionId } from "./utils";
import { processChatRequest } from "./processChat";

export const chatRouter = Router();

chatRouter.post("/chat", async (req, res) => {
  const result = await processChatRequest(req);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.payload);
});

chatRouter.post("/chat/state/clear", (req, res) => {
  const sessionId = getSessionId(req);
  const state = clearState(sessionId);
  res.json({ status: "cleared", state });
});
