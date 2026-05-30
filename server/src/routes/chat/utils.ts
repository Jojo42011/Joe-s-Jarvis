import type { Request } from "express";
import Anthropic from "@anthropic-ai/sdk";
import type { ConversationState } from "../../db/queries";
import { sanitizeSpeech } from "../../brain/communication";
import type { IntentResponse, JarvisUiPayload, ToolPayload } from "./types";

export const CHECKING_SPEECH_PATTERN =
  /\b(checking|look(?:ing)? up|searching|fetching|stand by|standby|one moment|let me check|i'll check|i will check|pulling that up)\b/i;

export const chatAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export function claudeWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

import { formatCurrentTimeForPrompt } from "../../utils/temporal";

export function getOhioDateTimeString(): string {
  return formatCurrentTimeForPrompt().replace(/^Current time: /, "");
}

export function buildDateTimePromptPrefix(): string {
  return `${formatCurrentTimeForPrompt()}\n`;
}
export function parseTemperatureF(text: string): number | null {
  const m =
    text.match(/(-?\d+(?:\.\d+)?)\s*°?\s*F\b/i) ||
    text.match(/Temperature:\s*(-?\d+(?:\.\d+)?)/i) ||
    text.match(/\b(-?\d+(?:\.\d+)?)\s*degrees?\s*f/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function looksLikeJsonBlob(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("{") && (t.includes('"speech"') || t.includes('"intent"'))) return true;
  if (t.startsWith("```") && t.includes("{")) return true;
  return /^[\s\S]*\{[\s\S]*"speech"[\s\S]*\}[\s\S]*$/.test(t);
}

function coerceSpeechField(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/** Pull spoken text from model output — never pass raw JSON to the client. */
export function extractSpeechFromModelOutput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parsed = parseJsonObject(trimmed);
  if (parsed) {
    const fromSpeech = coerceSpeechField(parsed.speech);
    if (fromSpeech) return fromSpeech;
    const alt =
      coerceSpeechField(parsed.response) ||
      coerceSpeechField(parsed.message) ||
      coerceSpeechField(parsed.answer);
    if (alt) return alt;
  }

  const speechMatch = trimmed.match(/"speech"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (speechMatch?.[1]) {
    try {
      return JSON.parse(`"${speechMatch[1]}"`) as string;
    } catch {
      return speechMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }

  if (!looksLikeJsonBlob(trimmed)) {
    return trimmed;
  }

  return null;
}

export function sanitizeSpeechForClient(
  speech: string,
  fallback = "Standing by, sir."
): string {
  let current = speech.trim();
  if (!current) return fallback;

  for (let depth = 0; depth < 4; depth += 1) {
    const extracted = extractSpeechFromModelOutput(current);
    if (!extracted) break;
    if (extracted === current) break;
    current = extracted;
  }

  if (looksLikeJsonBlob(current)) return fallback;
  const cleaned = sanitizeSpeech(current);
  return cleaned && cleaned !== "One moment, sir." ? cleaned : fallback;
}

function intentFromParsed(parsed: Record<string, unknown>): IntentResponse {
  const speech = sanitizeSpeechForClient(
    coerceSpeechField(parsed.speech) ||
      coerceSpeechField(parsed.response) ||
      coerceSpeechField(parsed.message) ||
      "Standing by, sir."
  );
  const ui =
    parsed.ui && typeof parsed.ui === "object" && !Array.isArray(parsed.ui)
      ? (parsed.ui as Partial<JarvisUiPayload>)
      : {};
  const tool =
    parsed.tool && typeof parsed.tool === "object" && !Array.isArray(parsed.tool)
      ? (parsed.tool as Partial<ToolPayload>)
      : {};

  return {
    speech,
    intent: typeof parsed.intent === "string" ? parsed.intent : "general.chat",
    entities:
      parsed.entities && typeof parsed.entities === "object"
        ? (parsed.entities as Record<string, unknown>)
        : {},
    ui: {
      panel: ui.panel ?? null,
      data: Array.isArray(ui.data) ? ui.data : [],
      action: ui.action ?? null
    },
    tool: {
      name: typeof tool.name === "string" ? tool.name : null,
      args: tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>) : {}
    }
  };
}

export function normalizeJarvisResponse(response: string): IntentResponse {
  const plainFallback: IntentResponse = {
    speech: sanitizeSpeechForClient(response),
    intent: "general.chat",
    entities: {},
    ui: { panel: null, data: [], action: null },
    tool: { name: null, args: {} }
  };

  const parsed = parseJsonObject(response);
  if (parsed) {
    return intentFromParsed(parsed);
  }

  const extracted = extractSpeechFromModelOutput(response);
  if (extracted) {
    return { ...plainFallback, speech: extracted };
  }

  return plainFallback;
}

export function normalizeText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9@.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAskAboutPastActions(message: string) {
  const t = normalizeText(message);
  return (
    /\b(what have you done|what did you do|what have you handled|what did you handle|what s going on|whats going on)\b/.test(
      t
    ) || /\b(going on|what happened)\b/.test(t)
  );
}

export function isSendVerification(message: string) {
  const t = normalizeText(message);
  return (
    /\b(did you send|have you sent|actually send|sure you sent|really send|send it out|sent it out)\b/.test(
      t
    ) || (/\b(sent|send)\b/.test(t) && /\b(sure|actually|did|see|verify)\b/.test(t))
  );
}

export function isSendCommand(message: string) {
  const t = normalizeText(message);
  return (
    /\b(send|reply to|respond to|email)\b/.test(t) &&
    !/\b(did you|have you|sure|actually)\b/.test(t)
  );
}

export function getSessionId(req: Request) {
  const body = (req.body || {}) as { sessionId?: string };
  const fromBody = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const raw = fromBody || req.header("x-session-id") || "default";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "default";
}

export const ACTIVATION_MESSAGE = "__JARVIS_ACTIVATE__";

export function simpleStringHash(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
export function resolveItemFromState(
  state: ConversationState,
  args: Record<string, unknown>,
  entities: Record<string, unknown>
) {
  const items = Array.isArray(state.activeItems) ? state.activeItems : [];
  if (!items.length) return null;

  const requestedId = String(args.id || args.messageId || entities.id || "").trim();
  if (requestedId) {
    const foundById = items.find(
      (item) =>
        item &&
        typeof item === "object" &&
        "id" in item &&
        String((item as { id?: unknown }).id) === requestedId
    );
    if (foundById) return foundById;
  }

  const ref = normalizeText(
    args.emailRef ||
      args.reference ||
      args.recipient ||
      args.sender ||
      args.query ||
      entities.emailRef ||
      entities.reference ||
      entities.recipient ||
      entities.sender ||
      ""
  );

  const ordinalMap: Record<string, number> = {
    first: 0,
    "1st": 0,
    one: 0,
    second: 1,
    "2nd": 1,
    two: 1,
    third: 2,
    "3rd": 2,
    three: 2,
    fourth: 3,
    "4th": 3,
    four: 3,
    fifth: 4,
    "5th": 4,
    five: 4
  };

  const explicitIndex =
    typeof args.index === "number"
      ? args.index
      : typeof entities.index === "number"
        ? entities.index
        : undefined;

  if (typeof explicitIndex === "number") {
    return items[Math.max(0, Math.min(items.length - 1, explicitIndex))] || null;
  }

  const ordinal = Object.entries(ordinalMap).find(([key]) => ref.includes(key));
  if (ordinal) {
    return items[ordinal[1]] || null;
  }

  if (ref) {
    const parts = ref.split(" ").filter((part) => part.length > 1);
    const matched = items.find((item) => {
      const haystack = normalizeText(JSON.stringify(item));
      return haystack.includes(ref) || parts.every((part) => haystack.includes(part));
    });
    if (matched) return matched;
  }

  return state.selectedItem || items[0] || null;
}

export function detectCorrectionSignal(message: string): boolean {
  const t = message.toLowerCase();
  return (
    /that's not how/i.test(message) ||
    /don't say|dont say/.test(t) ||
    /not how i/.test(t) ||
    /wouldn't do that|would not do that/.test(t) ||
    /i wouldn't do that/.test(t) ||
    /next time just|next time,?\s+just/.test(t) ||
    /that's not what i meant|not what i meant/.test(t) ||
    /\balways\b.+\b(just|use|say|do)\b/.test(t) ||
    /\bnever\b.+\b(say|do|use|call)\b/.test(t)
  );
}

