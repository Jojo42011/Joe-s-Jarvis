import { Router } from "express";
import {
  streamSpeech as streamDeepgramSpeech,
  synthesizeSpeech as synthesizeDeepgramSpeech
} from "../services/deepgram";
import {
  streamElevenLabsSpeech,
  synthesizeElevenLabsSpeech
} from "../services/elevenlabs";

export const voiceRouter = Router();

const activeTtsProvider = process.env.TTS_PROVIDER || "deepgram";

async function streamSpeech(text: string, signal?: AbortSignal) {
  if (activeTtsProvider === "elevenlabs") {
    try {
      return await streamElevenLabsSpeech(text, signal);
    } catch (error) {
      console.error("ElevenLabs stream failed, falling back to Deepgram:", error);
    }
  }

  const speech = await streamDeepgramSpeech(text, signal);
  return {
    ...speech,
    provider: "deepgram",
    model: speech.voice
  };
}

async function synthesizeSpeech(text: string) {
  if (activeTtsProvider === "elevenlabs") {
    try {
      return await synthesizeElevenLabsSpeech(text);
    } catch (error) {
      console.error("ElevenLabs synthesis failed, falling back to Deepgram:", error);
    }
  }

  const speech = await synthesizeDeepgramSpeech(text);
  return {
    ...speech,
    provider: "deepgram",
    model: speech.voice
  };
}

voiceRouter.get("/voice", async (req, res, next) => {
  const controller = new AbortController();

  req.on("close", () => {
    controller.abort();
  });

  try {
    const text = String(req.query.text || "").trim();

    if (!text) {
      res.status(400).json({
        error: "text is required"
      });
      return;
    }

    const speech = await streamSpeech(text, controller.signal);

    res.setHeader("Content-Type", speech.contentType);
    res.setHeader("X-TTS-Provider", speech.provider);
    res.setHeader("X-TTS-Voice", speech.voice);
    res.setHeader("X-TTS-Model", speech.model);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "none");

    speech.stream.on("error", (error) => {
      if (!res.headersSent) {
        next(error);
      } else {
        res.destroy(error);
      }
    });

    speech.stream.pipe(res);
  } catch (error) {
    if (!res.headersSent) {
      next(error);
    }
  }
});

voiceRouter.post("/voice", async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").trim();

    if (!text) {
      res.status(400).json({
        error: "text is required"
      });
      return;
    }

    const speech = await synthesizeSpeech(text);

    res.setHeader("Content-Type", speech.contentType);
    res.setHeader("X-TTS-Provider", speech.provider);
    res.setHeader("X-TTS-Voice", speech.voice);
    res.setHeader("X-TTS-Model", speech.model);
    res.setHeader("Cache-Control", "no-store");
    res.send(speech.audio);
  } catch (error) {
    next(error);
  }
});
