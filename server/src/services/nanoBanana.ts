import { logServiceError } from "../utils/logError";

const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

const DEFAULT_FINISH_PROMPT =
  "Finished professional landscaping: lush lawn, clean edges, realistic photo quality.";

const REFERENCE_TRANSFORM_PREFIX =
  "Transform this into a finished professional landscaping photograph.";

export type NanoBananaResult = {
  imageBase64: string;
  mimeType: string;
};

type GeminiRequestPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

type GeminiResponsePart = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiResponsePart[] };
  }>;
  error?: { message?: string };
};

let lastGeminiImageError: string | null = null;

function getGeminiApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key || null;
}

/** Last Gemini image API failure reason (for operator speech + debugging). */
export function getLastGeminiImageError(): string | null {
  return lastGeminiImageError;
}

export function isNanoBananaConfigured(): boolean {
  return Boolean(getGeminiApiKey());
}

function normalizeImageMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m === "image/jpg") return "image/jpeg";
  if (m.startsWith("image/")) return m;
  return "image/jpeg";
}

function extractImageFromGeminiResponse(payload: GeminiGenerateResponse): NanoBananaResult | null {
  for (const candidate of payload.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      const inline = part.inlineData || part.inline_data;
      const data = inline?.data;
      if (data) {
        const mimeType =
          (part.inlineData?.mimeType ||
            part.inline_data?.mime_type ||
            "image/png") as string;
        return { imageBase64: data, mimeType };
      }
    }
  }
  return null;
}

async function callGeminiImageApi(parts: GeminiRequestPart[]): Promise<NanoBananaResult | null> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    lastGeminiImageError = "GEMINI_API_KEY not configured";
    return null;
  }

  lastGeminiImageError = null;

  try {
    console.log(
      `[GeminiImage] generateContent model=${GEMINI_IMAGE_MODEL} parts=${parts.length} hasImage=${parts.some((p) => "inline_data" in p)}`
    );
    const res = await fetch(GEMINI_GENERATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["image", "text"] }
      })
    });

    const raw = await res.text();
    let payload: GeminiGenerateResponse;
    try {
      payload = JSON.parse(raw) as GeminiGenerateResponse;
    } catch {
      throw new Error(`Gemini invalid JSON (${res.status}): ${raw.slice(0, 200)}`);
    }

    if (!res.ok) {
      const msg = payload.error?.message || raw.slice(0, 300);
      throw new Error(`Gemini HTTP ${res.status}: ${msg}`);
    }

    const image = extractImageFromGeminiResponse(payload);
    if (!image) {
      throw new Error(`Gemini response had no inline image data: ${raw.slice(0, 400)}`);
    }

    console.log(`[GeminiImage] generateContent ok mime=${image.mimeType} b64len=${image.imageBase64.length}`);
    return image;
  } catch (error) {
    lastGeminiImageError =
      error instanceof Error ? error.message : String(error);
    logServiceError("GeminiImage", "generateContent", error);
    return null;
  }
}

function buildReferencePrompt(userPrompt: string): string {
  const trimmed = userPrompt?.trim();
  if (!trimmed) return `${REFERENCE_TRANSFORM_PREFIX} ${DEFAULT_FINISH_PROMPT}`;
  if (/^transform this/i.test(trimmed)) return trimmed;
  return `${REFERENCE_TRANSFORM_PREFIX} ${trimmed}`;
}

/** Generate image — optional reference image as base64 for vision input. */
export async function generateImage(opts: {
  prompt: string;
  referenceImageBase64?: string;
  referenceImageMimeType?: string;
  imageBuffer?: Buffer;
}): Promise<NanoBananaResult | null> {
  if (!getGeminiApiKey()) return null;

  const userPrompt = opts.prompt?.trim() || DEFAULT_FINISH_PROMPT;
  const refB64 =
    opts.referenceImageBase64 ||
    (opts.imageBuffer?.length ? opts.imageBuffer.toString("base64") : undefined);
  const refMime = normalizeImageMime(opts.referenceImageMimeType || "image/jpeg");

  if (refB64) {
    const parts: GeminiRequestPart[] = [
      { inline_data: { mime_type: refMime, data: refB64 } },
      { text: buildReferencePrompt(userPrompt) }
    ];
    return callGeminiImageApi(parts);
  }

  const textPrompt = /\b(landscap|lawn|yard|patio|hardscape|outdoor)\b/i.test(userPrompt)
    ? userPrompt
    : `${userPrompt}. Professional landscaping photograph, realistic, high quality.`;

  return callGeminiImageApi([{ text: textPrompt }]);
}

/** Text-only image generation via Gemini. */
export async function generateFromPrompt(prompt: string): Promise<NanoBananaResult | null> {
  return generateImage({ prompt });
}

/** Reference image + prompt (finish-this flow). */
export async function generateFromReferenceImage(opts: {
  imageBuffer: Buffer;
  mimeType: string;
  prompt?: string;
  referenceImageBase64?: string;
  referenceImageMimeType?: string;
}): Promise<NanoBananaResult | null> {
  return generateImage({
    prompt: opts.prompt || DEFAULT_FINISH_PROMPT,
    imageBuffer: opts.imageBuffer,
    referenceImageMimeType: opts.referenceImageMimeType || opts.mimeType,
    referenceImageBase64: opts.referenceImageBase64
  });
}
