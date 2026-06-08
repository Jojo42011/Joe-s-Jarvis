import { Router } from "express";

import { GoogleGenAI, Modality } from "@google/genai";

import {

  GEMINI_API_KEY,

  GEMINI_LIVE_MODEL,

  GEMINI_LIVE_VOICE,
  GEMINI_VOICE_DELIVERY,

  isGeminiConfigured

} from "../config/gemini";

import { buildGeminiSessionConfig } from "../chat/geminiSystemPrompt";

import { executeChatTool } from "../chat/tools";



export const geminiLiveRouter = Router();



const GEMINI_LIVE_WS_BETA =

  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";



function geminiLog(message: string, extra?: Record<string, unknown>) {

  if (extra && Object.keys(extra).length > 0) {

    console.log(`[gemini-live] ${message}`, extra);

    return;

  }

  console.log(`[gemini-live] ${message}`);

}



type ToolCallBody = {

  sessionId?: string;

  toolCall?: {

    functionCalls?: Array<{

      id?: string;

      name?: string;

      args?: Record<string, unknown>;

    }>;

  };

};



geminiLiveRouter.post("/gemini-live/token", async (req, res) => {
  try {
    if (!isGeminiConfigured()) {
      res.status(503).json({ error: "GEMINI_API_KEY is not configured" });
      return;
    }
    const sessionId = String(req.body?.sessionId || "").trim() || "gemini-voice";
    const config = await buildGeminiSessionConfig(sessionId);
    const wsUrl = `${GEMINI_LIVE_WS_BETA}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    geminiLog("using api_key mode", {
      sessionId: sessionId.slice(0, 8),
      model: config.model,
      voice: config.voice
    });
    res.json({ mode: "api_key", wsUrl, config });
  } catch (err) {
    console.error("[gemini-live] token error:", err);
    res.status(500).json({ error: "Failed to generate Gemini Live session" });
  }
});



geminiLiveRouter.post("/gemini-live/tool", async (req, res) => {

  const startedAt = Date.now();

  try {

    const body = req.body as ToolCallBody;

    const sessionId = String(body.sessionId || "").trim() || "gemini-voice";

    const calls = body.toolCall?.functionCalls || [];



    if (!calls.length) {

      geminiLog("tool rejected — no functionCalls", {

        sessionId: sessionId.slice(0, 8)

      });

      res.status(400).json({ error: "toolCall.functionCalls is required" });

      return;

    }



    const names = calls.map((c) => c.name || "?").join(", ");

    geminiLog("tool batch", {

      sessionId: sessionId.slice(0, 8),

      count: calls.length,

      tools: names

    });



    const functionResponses = [];

    for (const call of calls) {

      const name = String(call.name || "").trim();

      const id = String(call.id || name || "tool");

      const args =

        call.args && typeof call.args === "object"

          ? (call.args as Record<string, unknown>)

          : {};



      const toolStarted = Date.now();

      const result = name

        ? await executeChatTool(name, args, sessionId)

        : { error: "missing tool name" };



      const hasError =

        result &&

        typeof result === "object" &&

        "error" in result &&

        Boolean((result as { error?: string }).error);



      geminiLog(`tool done: ${name || "(unnamed)"}`, {

        ms: Date.now() - toolStarted,

        ok: !hasError,

        error: hasError ? (result as { error?: string }).error : undefined

      });



      functionResponses.push({

        id,

        name,

        response: { result }

      });

    }



    geminiLog("tool batch complete", {

      sessionId: sessionId.slice(0, 8),

      ms: Date.now() - startedAt

    });



    res.json({ functionResponses });

  } catch (err) {

    const detail = err instanceof Error ? err.message : String(err);

    console.error("[gemini-live] tool error:", err);

    geminiLog("tool batch failed", { error: detail, ms: Date.now() - startedAt });

    res.status(500).json({ error: "Tool execution failed" });

  }

});



/** Browser-reported Gemini Live events (visible in Fly logs). */

geminiLiveRouter.post("/gemini-live/client-log", (req, res) => {

  const sessionId = String(req.body?.sessionId || "").trim() || "gemini-voice";

  const event = String(req.body?.event || "unknown").trim();

  const detail = req.body?.detail;

  const extra =

    detail && typeof detail === "object" && !Array.isArray(detail)

      ? (detail as Record<string, unknown>)

      : detail !== undefined

        ? { detail }

        : undefined;



  geminiLog(`client:${event}`, {

    sessionId: sessionId.slice(0, 8),

    ...extra

  });



  res.status(204).end();

});

const GEMINI_TTS_MODEL =
  process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview";

function buildGeminiTtsPrompt(spokenText: string): string {
  return `Synthesize speech. Do not read the director's notes aloud. Speak only the transcript below.

### DIRECTOR'S NOTES
Style: ${GEMINI_VOICE_DELIVERY}

#### TRANSCRIPT
${spokenText}`;
}

geminiLiveRouter.post("/gemini-live/speak", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    res.status(400).json({ error: "text required" });
    return;
  }

  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "GEMINI_API_KEY is not configured" });
    return;
  }

  try {
    const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const response = await client.models.generateContent({
      model: GEMINI_TTS_MODEL,
      contents: [{ role: "user", parts: [{ text: buildGeminiTtsPrompt(text) }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: GEMINI_LIVE_VOICE }
          }
        }
      }
    });

    const part = response.candidates?.[0]?.content?.parts?.[0];
    const audioData = part?.inlineData?.data;
    const mimeType = part?.inlineData?.mimeType || "audio/wav";

    if (!audioData) {
      res.status(502).json({ error: "No audio generated" });
      return;
    }

    const audioBuffer = Buffer.from(audioData, "base64");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "no-store");
    res.send(audioBuffer);
  } catch (err) {
    console.error("[gemini-speak]", err);
    res.status(500).json({ error: "TTS failed" });
  }
});

