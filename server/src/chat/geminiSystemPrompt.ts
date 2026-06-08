import { buildLeanChatContext, formatLeanContextNote } from "./context";
import { getMemoryFeedForMessage } from "../memory/memoryFeed";
import { buildGeminiLiveTools } from "./geminiTools";
import { GEMINI_LIVE_MODEL, GEMINI_LIVE_VOICE, GEMINI_VOICE_DELIVERY } from "../config/gemini";
import { TOTALLY_OUTDOORS_KB } from "../config/systemPrompt";

const LIVE_PROMPT_MAX_CHARS = 5800;

const LIVE_IDENTITY = `You are JARVIS, Joe Stewart's personal AI operator — confident, dry, precise, brief.
Joe runs a multimillion-dollar landscaping business in Ohio. Address him as "sir" occasionally.
You are in a real-time voice session: keep answers short for speech. Use tools when needed; results come from the server.
Speak with the voice character defined in the direction above — always.`;

const LIVE_TOOL_RULES = `Critical tool rules:
1. You have tools — call them now when needed; never promise to look later.
2. Call only tools that serve this question (weather → get_weather, not read_emails).
3. After a tool returns, answer directly in plain speech — no raw dumps or "according to the search".`;

function formatTopMemoriesForLive(
  memories: Array<{ key: string; value: string }>
): string {
  if (!memories.length) return "Top memories: none loaded.";
  const lines = memories.map((m) => `- ${m.key}: ${m.value}`);
  return `Top memories (highest relevance):\n${lines.join("\n")}`;
}

function formatOperatorPreferencesForLive(
  memories: Array<{ key: string; value: string }>
): string {
  if (!memories.length) return "";
  const lines = memories.map((m) => `- ${m.key}: ${m.value}`);
  return `Joe's communication preferences:\n${lines.join("\n")}`;
}

function parseDomainHeadlineTexts(domainHeadlines: string): string[] {
  if (!domainHeadlines?.trim()) return [];
  return domainHeadlines
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("===") && line.includes(":"))
    .map((line) => {
      const colon = line.indexOf(":");
      const label = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      return value ? `${label}: ${value}` : line;
    })
    .filter(Boolean);
}

function formatDomainHeadlinesCompact(domainHeadlines: string): string {
  const headlines = parseDomainHeadlineTexts(domainHeadlines).slice(-3);
  if (!headlines.length) return "";
  return `Intel: ${headlines.join(". ")}.`;
}

function formatLiveContextNote(
  leanNote: string,
  domainHeadlines: string
): string {
  const intel = formatDomainHeadlinesCompact(domainHeadlines);
  return intel ? `${leanNote}\n${intel}` : leanNote;
}

function clampLivePrompt(text: string): string {
  if (text.length <= LIVE_PROMPT_MAX_CHARS) return text;
  console.warn(
    `[gemini-live] system prompt exceeded ${LIVE_PROMPT_MAX_CHARS} chars (${text.length}) — truncating; TOTALLY_OUTDOORS_KB or other context may be cut`
  );
  return `${text.slice(0, LIVE_PROMPT_MAX_CHARS - 24)}\n[context truncated]`;
}

/** Lean system instruction for Gemini Live setup (<5800 chars). */
export async function buildGeminiLiveSystemPrompt(
  sessionId?: string
): Promise<string> {
  const sid = sessionId?.trim() || "gemini-voice";
  const lean = buildLeanChatContext(sid);
  const feed = await getMemoryFeedForMessage("", sid);
  const topTen = feed.top_memories.slice(0, 10);
  const topTenIds = new Set(topTen.map((m) => m.id));
  const operatorPreferences = feed.top_memories.filter(
    (m) => m.category === "operator_preferences" && !topTenIds.has(m.id)
  );

  const deliveryBlock = [
    "### VOICE DIRECTION (non-negotiable)",
    "Do not read these notes aloud.",
    `Style: ${GEMINI_VOICE_DELIVERY}`,
    "Apply this style to every single response.",
    "###"
  ].join("\n");

  const promptParts = [
    deliveryBlock,
    "",
    LIVE_IDENTITY,
    "",
    TOTALLY_OUTDOORS_KB,
    "",
    LIVE_TOOL_RULES,
    "",
    formatLiveContextNote(formatLeanContextNote(lean), feed.domain_headlines),
    "",
    formatTopMemoriesForLive(topTen)
  ];

  const operatorBlock = formatOperatorPreferencesForLive(operatorPreferences);
  if (operatorBlock) {
    promptParts.push("", operatorBlock);
  }

  return clampLivePrompt(promptParts.join("\n"));
}

export async function buildGeminiSessionConfig(sessionId?: string) {
  const systemPrompt = await buildGeminiLiveSystemPrompt(sessionId);
  return {
    systemPrompt,
    tools: buildGeminiLiveTools(),
    model: GEMINI_LIVE_MODEL,
    voice: GEMINI_LIVE_VOICE
  };
}
