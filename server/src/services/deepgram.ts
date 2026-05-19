import { Readable } from "node:stream";

const DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak";

const apiKey = process.env.DEEPGRAM_API_KEY;
const defaultVoice = process.env.DEEPGRAM_VOICE || "aura-orion-en";

function prepareText(text: string) {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Text is required for speech synthesis");
  }

  return cleanText;
}

function buildDeepgramUrl() {
  const url = new URL(DEEPGRAM_TTS_URL);
  url.searchParams.set("model", defaultVoice);
  url.searchParams.set("encoding", "mp3");
  return url;
}

async function requestDeepgramSpeech(text: string, signal?: AbortSignal) {
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is not configured");
  }

  const cleanText = prepareText(text);
  const url = buildDeepgramUrl();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
    },
    body: JSON.stringify({ text: cleanText }),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepgram TTS failed: ${response.status} ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Deepgram TTS returned no audio stream");
  }

  return response;
}

export async function synthesizeSpeech(text: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await requestDeepgramSpeech(text, controller.signal);
    const audio = Buffer.from(await response.arrayBuffer());

    return {
      audio,
      contentType: response.headers.get("content-type") || "audio/mpeg",
      voice: defaultVoice
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function streamSpeech(text: string, signal?: AbortSignal) {
  const response = await requestDeepgramSpeech(text, signal);

  return {
    stream: Readable.fromWeb(response.body as never),
    contentType: response.headers.get("content-type") || "audio/mpeg",
    voice: defaultVoice
  };
}
