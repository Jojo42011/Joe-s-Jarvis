import { Readable } from "node:stream";

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

const apiKey = process.env.ELEVENLABS_API_KEY;
const defaultVoiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const defaultModel = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";

function prepareText(text: string) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Text is required for ElevenLabs speech synthesis");
  }

  return cleanText;
}

function buildElevenLabsUrl(stream: boolean) {
  const endpoint = stream ? "stream" : "";
  const url = new URL(
    `${ELEVENLABS_TTS_URL}/${encodeURIComponent(defaultVoiceId)}${endpoint ? `/${endpoint}` : ""}`
  );
  url.searchParams.set("output_format", "mp3_44100_128");
  url.searchParams.set("optimize_streaming_latency", "3");
  return url;
}

async function requestElevenLabsSpeech(text: string, stream: boolean, signal?: AbortSignal) {
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not configured");
  }

  const response = await fetch(buildElevenLabsUrl(stream), {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
    },
    body: JSON.stringify({
      text: prepareText(text),
      model_id: defaultModel,
      voice_settings: {
        stability: 0.62,
        similarity_boost: 0.82,
        style: 0.18,
        use_speaker_boost: true
      }
    }),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${errorText}`);
  }

  if (!response.body) {
    throw new Error("ElevenLabs TTS returned no audio stream");
  }

  return response;
}

export async function synthesizeElevenLabsSpeech(text: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await requestElevenLabsSpeech(text, false, controller.signal);
    const audio = Buffer.from(await response.arrayBuffer());

    return {
      audio,
      contentType: response.headers.get("content-type") || "audio/mpeg",
      provider: "elevenlabs",
      voice: defaultVoiceId,
      model: defaultModel
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function streamElevenLabsSpeech(text: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const response = await requestElevenLabsSpeech(text, true, controller.signal);
  clearTimeout(timeout);

  return {
    stream: Readable.fromWeb(response.body as never),
    contentType: response.headers.get("content-type") || "audio/mpeg",
    provider: "elevenlabs",
    voice: defaultVoiceId,
    model: defaultModel
  };
}
