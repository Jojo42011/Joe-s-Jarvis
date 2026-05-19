import type { Server } from "node:http";
import WebSocket, { WebSocketServer, type RawData } from "ws";

const apiKey = process.env.DEEPGRAM_API_KEY;

function buildDeepgramListenUrl() {
  const params = new URLSearchParams({
    model: "nova-2",
    language: "en-US",
    smart_format: "true",
    interim_results: "true",
    // Longer pauses so breaths/micro-pauses don't finalize early; client commits after 3s silence
    endpointing: process.env.DEEPGRAM_ENDPOINTING_MS || "1000",
    utterance_end_ms: process.env.DEEPGRAM_UTTERANCE_END_MS || "3000",
    vad_events: "true",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1"
  });

  return `wss://api.deepgram.com/v1/listen?${params}`;
}

function getRawDataByteLength(data: RawData) {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.reduce((total, chunk) => total + chunk.byteLength, 0);
}

export function attachDeepgramSttProxy(server: Server) {
  const wss = new WebSocketServer({
    server,
    path: "/api/deepgram/listen"
  });

  wss.on("connection", (client) => {
    console.log("Deepgram STT proxy: Browser connected");

    if (!apiKey) {
      client.close(1011, "DEEPGRAM_API_KEY is not configured");
      return;
    }

    const upstream = new WebSocket(buildDeepgramListenUrl(), {
      headers: {
        Authorization: `Token ${apiKey}`
      }
    });

    upstream.on("open", () => {
      console.log("Deepgram STT proxy: Deepgram upstream connected");
      client.send(JSON.stringify({ type: "ProxyReady" }));
    });

    client.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
      }
    });

    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });

    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };

    client.on("close", closeBoth);
    client.on("error", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("error", (error) => {
      console.error("Deepgram STT upstream error:", error);
      closeBoth();
    });
  });
}
