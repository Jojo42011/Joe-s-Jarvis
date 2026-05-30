import { Router } from "express";

export const deepgramRouter = Router();

const apiKey = process.env.DEEPGRAM_API_KEY;

deepgramRouter.get("/deepgram/token", (_req, res) => {
  if (!apiKey) {
    res.status(500).json({
      error: "DEEPGRAM_API_KEY is not configured"
    });
    return;
  }

  res.json({
    mode: "proxy",
    url: "/api/deepgram/listen"
  });
});
