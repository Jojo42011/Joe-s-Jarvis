import { Router } from "express";

export const deepgramRouter = Router();

const apiKey = process.env.DEEPGRAM_API_KEY;

deepgramRouter.get("/deepgram/token", async (_req, res, next) => {
  try {
    if (!apiKey) {
      res.status(500).json({
        error: "DEEPGRAM_API_KEY is not configured"
      });
      return;
    }

    const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ttl_seconds: 60
      })
    });

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      reason?: string;
    };

    if (!response.ok || !payload.access_token) {
      res.json({
        mode: "proxy",
        url: "/api/deepgram/listen",
        reason:
          payload.reason ||
          payload.error ||
          `Deepgram token request failed with ${response.status}`
      });
      return;
    }

    res.json({
      mode: "token",
      token: payload.access_token,
      expiresIn: payload.expires_in || 60
    });
  } catch (error) {
    next(error);
  }
});
