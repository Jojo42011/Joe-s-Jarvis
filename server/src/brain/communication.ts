import Anthropic from "@anthropic-ai/sdk";
import {
  getCallsSince,
  getExecutionLogSince,
  getLastBriefingTime,
  getMemoriesCreatedSince,
  getQueue,
  getSystemState,
  getUnacknowledgedNotes,
  logExecution,
  markNotesSeenInRundown,
  setLastBriefingTime,
  setSystemState,
  type ExecutionLogEntry,
  type PriorityQueueItem
} from "../db/queries";
import { buildDynamicSystemPrompt } from "../config/systemPrompt";
import { formatBriefingTimePhrase } from "../utils/temporal";
import { findWorkingModel } from "../services/claude";
import { generateActivationBriefing, generateExecutionLogSummary } from "../services/claude";
import type {
  CommunicationDecision,
  CommunicationTrigger,
  ExecutionResult,
  PerceptionPayload
} from "./types";
import { Judgment, JARVIS_SPEECH_OUTPUT_RULES } from "./judgment";
import {
  formatWorldIntelBriefingSpeech,
  getHighUnbriefedWorldIntel,
  getWorldIntelSinceHours,
  markWorldIntelBriefed,
  type WorldIntelRow
} from "./worldIntelStore";
import { filterBriefingDataForSession } from "../routes/chat/spokenSessionTracker";
import { formatNotesBriefingSnippet } from "../services/notes";

const BRIEFING_HOURS = 24;
const DATA_WINDOW_MS = BRIEFING_HOURS * 60 * 60 * 1000;

const SPOKEN_FALLBACK = "One moment, sir.";

/** Final safety net before TTS — never throws. */
export function sanitizeSpeech(speech: unknown): string {
  try {
    let text = String(speech ?? "").trim();
    if (!text) return SPOKEN_FALLBACK;

    if (/^\s*[\[{]/.test(text) || (text.includes('"speech"') && text.includes("{"))) {
      try {
        const jsonText = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
        const start = jsonText.indexOf("{");
        const end = jsonText.lastIndexOf("}");
        const slice =
          start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText;
        const parsed = JSON.parse(slice) as Record<string, unknown>;
        const fromSpeech = parsed?.speech;
        if (typeof fromSpeech === "string" && fromSpeech.trim()) {
          text = fromSpeech.trim();
        }
      } catch {
        const m = text.match(/"speech"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (m?.[1]) {
          text = m[1]
            .replace(/\\n/g, " ")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\")
            .trim();
        }
      }
    }

    text = text.replace(/```[\s\S]*?```/g, " ");
    text = text.replace(/`[^`]*`/g, " ");
    text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
    text = text.replace(/__(.+?)__/g, "$1");
    text = text.replace(/(?<=\s|^)#+\s*/gm, "");
    text = text.replace(/\[[^\]]*\]\([^)]*\)/g, " ");

    for (let i = 0; i < 6; i += 1) {
      const next = text
        .replace(/\{[^{}]*\}/g, " ")
        .replace(/\[[^\[\]]*\]/g, " ");
      if (next === text) break;
      text = next;
    }

    text = text.replace(/\[(Claude|Gmail|Brave|ReAct)\][^\]]*/gi, " ");
    text = text.replace(/\[[^\]]+\]/g, " ");
    text = text.replace(/\boperator-briefing\b/gi, " ");
    text = text.replace(/\bcircuit\.(open|closed|rate_limit)\b/gi, " ");
    text = text.replace(/\bcircuit\b/gi, " ");
    text = text.replace(/\b[a-f0-9]{12,}\b/gi, " ");
    text = text.replace(/https?:\/\/\S+/gi, " ");
    text = text.replace(/\bwww\.\S+/gi, " ");
    text = text.replace(/\bnull\b/gi, " ");
    text = text.replace(/\bundefined\b/gi, " ");
    text = text.replace(/[{}[\]]/g, " ");
    text = text.replace(/\n+/g, ". ");
    text = text.replace(/\s+/g, " ").trim();

    if (!text || /^[\s,.:;!?-]+$/.test(text)) return SPOKEN_FALLBACK;
    return text;
  } catch {
    return SPOKEN_FALLBACK;
  }
}

function spoken(text: unknown): string {
  return sanitizeSpeech(text);
}

const briefingAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export type BriefingQueueItem = {
  id: number;
  type: string;
  urgency: string;
  summary: string;
  actionNeeded: string;
  escalationReason: string | null;
};

export type BriefingData = {
  hoursElapsed: number;
  periodHours: number;
  emailsReceived: number;
  emailsAutoHandled: number;
  emailsQueued: number;
  emailsHandled: number;
  emailsArchived: number;
  queueCount: number;
  queueItems: BriefingQueueItem[];
  callsCount: number;
  priorityCalls: Array<{ id: number; from: string; reason: string; outcome: string }>;
  worldIntel: Array<{ query: string; summary: string }>;
  worldIntelCount: number;
  weather: { summary: string; query: string } | null;
  memoryPromotions: Array<{ category: string; key: string; value: string }>;
  recentNotes: Array<{ id: number; content: string; source: string }>;
  executionSummary: string;
  isEmpty: boolean;
};

export type GeneratedBriefing = {
  speech: string;
  briefingData: BriefingData;
};

function parseBriefedIds(): string[] {
  const raw = getSystemState("last_briefed_items");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function filterUnbriefed(results: ExecutionResult[], briefedIds: string[]): ExecutionResult[] {
  return results.filter((r) => r.success && !briefedIds.includes(r.itemId));
}

function parseQueueEscalation(rawData: string | null): string | null {
  if (!rawData) return null;
  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>;
    const judgment =
      parsed.judgment && typeof parsed.judgment === "object"
        ? (parsed.judgment as Record<string, unknown>)
        : parsed;
    const reason = String(
      judgment.escalation_reason || judgment.escalationReason || judgment.reason || ""
    ).trim();
    return reason || null;
  } catch {
    return null;
  }
}

function isWeatherIntelRow(row: WorldIntelRow): boolean {
  const q = row.query.toLowerCase();
  return (
    /\bweather\b|\bforecast\b|\bholmes county\b|\bohio\b.*\bweather\b|\btemperature\b|\bcrew\b.*\bfield\b/i.test(
      q
    ) || /\bconditions\b/.test(q)
  );
}

export function buildFallbackBriefingSpeech(data: BriefingData): string {
  if (data.isEmpty) {
    const h = Math.round(data.hoursElapsed) || BRIEFING_HOURS;
    const when = formatBriefingTimePhrase(h);
    return `All systems nominal sir. No activity to report ${when.toLowerCase()}. Standing by.`;
  }

  const parts: string[] = ["Sir,"];
  const when = formatBriefingTimePhrase(data.hoursElapsed);

  if (data.weather?.summary) {
    parts.push(`field conditions: ${data.weather.summary.slice(0, 120)}.`);
  }

  if (data.emailsAutoHandled > 0) {
    parts.push(
      `${when} you had ${data.emailsAutoHandled} email${data.emailsAutoHandled === 1 ? "" : "s"} handled autonomously.`
    );
  }

  if (data.queueCount > 0) {
    parts.push(`${data.queueCount} item${data.queueCount === 1 ? "" : "s"} need your judgment.`);
  } else if (data.worldIntel.length) {
    parts.push(`outside intel: ${data.worldIntel[0].summary.slice(0, 80)}.`);
  }

  if (data.memoryPromotions.length) {
    parts.push(`I stored ${data.memoryPromotions.length} new operational fact${data.memoryPromotions.length === 1 ? "" : "s"}.`);
  }

  if (data.recentNotes.length) {
    parts.push(formatNotesBriefingSnippet(data.recentNotes));
  }

  if (data.queueCount > 0) {
    parts.push(`${data.queueCount} item${data.queueCount === 1 ? "" : "s"} need your attention sir.`);
  } else {
    parts.push("All clear sir, operations running smoothly.");
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function shouldDeliverBriefing(): boolean {
  const lastBriefing = getLastBriefingTime();
  if (!lastBriefing) return true;
  const hoursElapsed = (Date.now() - new Date(lastBriefing).getTime()) / (1000 * 60 * 60);
  return hoursElapsed >= BRIEFING_HOURS;
}

export function compileBriefingData(sessionId?: string): BriefingData {
  const base = compileBriefingDataBase();
  if (!sessionId) return base;
  return filterBriefingDataForSession(base, sessionId).data;
}

export function compileBriefingDataForSession(sessionId: string): {
  data: BriefingData;
  includedKeys: string[];
} {
  return filterBriefingDataForSession(compileBriefingDataBase(), sessionId);
}

function compileBriefingDataBase(): BriefingData {
  const lastDelivered = getLastBriefingTime();
  const hoursElapsed = lastDelivered
    ? (Date.now() - new Date(lastDelivered).getTime()) / (1000 * 60 * 60)
    : BRIEFING_HOURS;

  const since = new Date(Date.now() - DATA_WINDOW_MS);
  const logs = getExecutionLogSince(since, 200);

  const emailLogs = logs.filter((l) => l.type === "email");
  const emailsReceived = emailLogs.length;
  const autoHandleActions = new Set([
    "draft_and_send",
    "send_reply",
    "email.send_reply",
    "archive",
    "email.archive"
  ]);
  const emailsAutoHandled = emailLogs.filter(
    (l) => l.result === "success" && autoHandleActions.has(l.action)
  ).length;
  const emailsArchived = emailLogs.filter(
    (l) => l.result === "success" && (l.action === "archive" || l.action === "email.archive")
  ).length;
  const emailsHandled = emailsAutoHandled;

  const openQueue = getQueue(false);
  const queueItems: BriefingQueueItem[] = openQueue.map((q) => mapQueueForBriefing(q));

  const calls = getCallsSince(since, 80);
  const priorityCalls = calls
    .filter((c) => c.priorityLevel === "HIGH" || c.outcome === "FORWARDED")
    .slice(0, 5)
    .map((c) => ({
      id: c.id,
      from: c.from,
      reason: c.reason || c.outcome,
      outcome: c.outcome
    }));

  const worldRows = getWorldIntelSinceHours(BRIEFING_HOURS).filter(
    (w) => w.relevance === "HIGH" && !w.briefed && w.summary
  );
  const worldIntel = worldRows.slice(0, 3).map((w) => ({
    query: w.query,
    summary: w.summary || ""
  }));

  const weatherCandidates = getWorldIntelSinceHours(BRIEFING_HOURS)
    .filter((w) => isWeatherIntelRow(w) && w.summary)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  const weather = weatherCandidates[0]
    ? { summary: weatherCandidates[0].summary || "", query: weatherCandidates[0].query }
    : null;

  const memories = getMemoriesCreatedSince(since, 15);
  const memoryPromotions = memories.map((m) => ({
    category: m.category,
    key: m.key,
    value: m.value.slice(0, 200)
  }));

  const unackNotes = getUnacknowledgedNotes(24);
  const recentNotes = unackNotes.map((n) => ({
    id: n.id,
    content: n.content,
    source: n.source
  }));

  const executionSummary = buildExecutionSummaryLine(logs, emailsHandled, emailsArchived, memories.length);

  const isEmpty =
    emailsReceived === 0 &&
    emailsAutoHandled === 0 &&
    openQueue.length === 0 &&
    calls.length === 0 &&
    worldIntel.length === 0 &&
    !weather &&
    memoryPromotions.length === 0 &&
    recentNotes.length === 0 &&
    logs.length === 0;

  return {
    hoursElapsed: Math.round(hoursElapsed * 10) / 10,
    periodHours: BRIEFING_HOURS,
    emailsReceived,
    emailsAutoHandled,
    emailsQueued: openQueue.length,
    emailsHandled,
    emailsArchived,
    queueCount: openQueue.length,
    queueItems,
    callsCount: calls.length,
    priorityCalls,
    worldIntel,
    worldIntelCount: worldIntel.length,
    weather,
    memoryPromotions,
    recentNotes,
    executionSummary,
    isEmpty
  };
}

function mapQueueForBriefing(q: PriorityQueueItem): BriefingQueueItem {
  const escalation = parseQueueEscalation(q.rawData);
  return {
    id: q.id,
    type: q.type,
    urgency: q.urgency || "TODAY",
    summary: q.summary || "Queue item",
    actionNeeded: q.actionNeeded || escalation || "Needs your decision",
    escalationReason: escalation
  };
}

function buildExecutionSummaryLine(
  logs: ExecutionLogEntry[],
  emailsHandled: number,
  emailsArchived: number,
  memoriesPromoted: number
): string {
  if (!logs.length) return "No autonomous actions logged in this window.";
  const parts: string[] = [];
  if (emailsHandled) parts.push(`handled ${emailsHandled} email${emailsHandled === 1 ? "" : "s"}`);
  if (emailsArchived) parts.push(`archived ${emailsArchived} spam`);
  if (memoriesPromoted) parts.push(`promoted ${memoriesPromoted} memor${memoriesPromoted === 1 ? "y" : "ies"}`);
  const brave = logs.filter((l) => l.action === "brave.search").length;
  if (brave) parts.push(`${brave} live search${brave === 1 ? "" : "es"}`);
  if (!parts.length) return `${logs.length} actions logged.`;
  return parts.join(", ");
}

export async function generateBriefing(data: BriefingData): Promise<GeneratedBriefing> {
  const hoursLabel = Math.round(data.hoursElapsed) || BRIEFING_HOURS;

  if (data.isEmpty) {
    return {
      speech: spoken(buildFallbackBriefingSpeech(data)),
      briefingData: data
    };
  }

  if (!briefingAnthropic) {
    return { speech: spoken(buildFallbackBriefingSpeech(data)), briefingData: data };
  }

  const model = await findWorkingModel();
  if (!model) {
    return { speech: spoken(buildFallbackBriefingSpeech(data)), briefingData: data };
  }

  const system = `${await buildDynamicSystemPrompt()}

You are JARVIS delivering a full operational brief to Joe Stewart.
Reference time naturally — say "this morning", "two days ago", "yesterday" — never raw timestamps.`;

  const userPrompt = `Joe Stewart just activated you.
It has been ${hoursLabel} hours since your last briefing. Deliver a complete operational brief.

DATA FROM LAST ${data.periodHours} HOURS:
${JSON.stringify(data, null, 2)}

BRIEFING RULES:
- Lead with the most important thing first
- Weather + crew impact always included if weather data is available
- Email handling summary — what you did autonomously
- Queue items — what needs Joe's decision and why
- World intel — only HIGH items, business relevant
- What you permanently learned (memory promotions)
- End with: "X items need your attention sir." or "All clear sir, operations running smoothly."

TONE: Sharp, confident, no fluff. JARVIS voice.
Address Joe as "sir" once at the start.
Target length: 45-75 words spoken.
This is a briefing not a report.
Never say "in the last 24 hours" repeatedly.
Use natural time references: "this morning you had 3 emails handled", "two days ago JARVIS flagged a diesel price spike".
Vary phrasing. Sound like a person, not a system.
Return plain speech text only — no JSON, no markdown.

${JARVIS_SPEECH_OUTPUT_RULES}`;

  try {
    const response = await briefingAnthropic.messages.create({
      model,
      max_tokens: 220,
      temperature: 0.35,
      system,
      messages: [{ role: "user", content: userPrompt }]
    });
    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "";
    const speech = spoken(text || buildFallbackBriefingSpeech(data));
    return { speech, briefingData: data };
  } catch (error) {
    console.warn("[communication] generateBriefing failed:", error);
    return { speech: spoken(buildFallbackBriefingSpeech(data)), briefingData: data };
  }
}

export async function deliverBriefingIfDue(): Promise<GeneratedBriefing | null> {
  if (!shouldDeliverBriefing()) return null;

  const data = compileBriefingData();
  const brief = await generateBriefing(data);

  const summaryPayload = {
    speech: brief.speech,
    hoursElapsed: data.hoursElapsed,
    emailsHandled: data.emailsHandled,
    queueCount: data.queueCount,
    worldIntelCount: data.worldIntelCount
  };
  setLastBriefingTime(JSON.stringify(summaryPayload));

  if (data.worldIntel.length) {
    const ids = getWorldIntelSinceHours(BRIEFING_HOURS)
      .filter((w) => w.relevance === "HIGH" && !w.briefed)
      .slice(0, 3)
      .map((w) => w.id);
    markWorldIntelBriefed(ids);
  }

  if (data.recentNotes.length) {
    markNotesSeenInRundown(data.recentNotes.map((n) => n.id));
  }

  logExecution({
    type: "morning_brief",
    action: "briefing_delivered",
    summary: `Brief delivered. Emails handled: ${data.emailsHandled}, Queue: ${data.queueCount}, Intel: ${data.worldIntelCount}`,
    result: "success"
  });

  return brief;
}

export class Communication {
  private judgment = new Judgment();

  async decide(
    execResults: ExecutionResult[],
    context: PerceptionPayload,
    trigger: CommunicationTrigger
  ): Promise<CommunicationDecision> {
    const briefedIds = parseBriefedIds();
    const freshResults = filterUnbriefed(execResults, briefedIds);

    if (trigger === "cycle") {
      const urgent = execResults.filter((r) => r.notifyJoe && r.notifyUrgency === "now");
      if (!urgent.length) {
        return { shouldSpeak: false, message: null, uiPanel: null, uiData: null, briefedItemIds: [] };
      }
      const message = spoken(
        await generateActivationBriefing({
          executions: urgent,
          context,
          mode: "critical"
        })
      );
      return {
        shouldSpeak: true,
        message,
        uiPanel: "rundown",
        uiData: [{ executions: urgent }],
        briefedItemIds: urgent.map((u) => u.itemId)
      };
    }

    if (trigger === "critical") {
      const message = spoken(
        await generateActivationBriefing({
          executions: execResults,
          context,
          mode: "critical"
        })
      );
      return {
        shouldSpeak: true,
        message,
        uiPanel: "rundown",
        uiData: [{ executions: execResults }],
        briefedItemIds: execResults.map((r) => r.itemId)
      };
    }

    // joe_activated — 24-hour full brief takes priority when due
    const fullBrief = await deliverBriefingIfDue();
    if (fullBrief) {
      const panelItems = fullBrief.briefingData.queueItems.map((q) => ({
        urgency: q.urgency,
        type: q.type,
        summary: q.summary,
        actionNeeded: q.escalationReason || q.actionNeeded
      }));

      return {
        shouldSpeak: true,
        message: spoken(fullBrief.speech),
        uiPanel: "rundown",
        uiData: [{ queueItems: panelItems, briefingData: fullBrief.briefingData }],
        briefedItemIds: [],
        intent: "morning_brief"
      };
    }

    const since = context.joeLastActive || new Date(Date.now() - 24 * 60 * 60 * 1000);
    const handledSince = getExecutionLogSince(since);
    const highWorldIntel = getHighUnbriefedWorldIntel();
    const shouldBrief = this.judgment.shouldBriefOnActivation(context, handledSince.length);

    if (!shouldBrief && !context.criticalAlertActive && !highWorldIntel.length) {
      return {
        shouldSpeak: true,
        message: spoken("All clear sir. What do you need?"),
        uiPanel: null,
        uiData: null,
        briefedItemIds: []
      };
    }

    const toBrief = filterUnbriefed(
      handledSince.map((row) => ({
        success: row.result === "success",
        summary: row.summary,
        itemId: row.itemId || "",
        itemType: row.type,
        action: row.action,
        notifyJoe: true,
        notifyUrgency: "next_briefing" as const
      })),
      briefedIds
    );

    if (!toBrief.length && !context.criticalAlertActive && !highWorldIntel.length) {
      return {
        shouldSpeak: true,
        message: spoken("All clear sir. What do you need?"),
        uiPanel: null,
        uiData: null,
        briefedItemIds: []
      };
    }

    let message = "";
    if (highWorldIntel.length) {
      message = spoken(formatWorldIntelBriefingSpeech(highWorldIntel));
      markWorldIntelBriefed(highWorldIntel.map((w) => w.id));
    }

    if (toBrief.length || context.criticalAlertActive) {
      const opsBrief = spoken(await this.generateOpsBriefingSince(since, context, toBrief));
      message = message ? spoken(`${message} ${opsBrief}`) : opsBrief;
    } else if (!message) {
      message = spoken("All clear sir. What do you need?");
    } else {
      message = spoken(message);
    }

    const newBriefed = [...briefedIds, ...toBrief.map((t) => t.itemId)].filter(Boolean);

    return {
      shouldSpeak: true,
      message,
      uiPanel: toBrief.length ? "rundown" : null,
      uiData: toBrief.length ? [{ executions: toBrief }] : null,
      briefedItemIds: newBriefed
    };
  }

  async generateOpsBriefingSince(
    since: Date,
    context: PerceptionPayload,
    executions: ExecutionResult[] = []
  ): Promise<string> {
    const logs = getExecutionLogSince(since);
    const briefedIds = parseBriefedIds();
    const freshLogs = logs.filter((l) => !briefedIds.includes(l.itemId || ""));

    return spoken(
      await generateActivationBriefing({
        executions:
          executions.length > 0
            ? executions
            : freshLogs.map((l) => ({
                success: l.result === "success",
                summary: l.summary,
                itemId: l.itemId || "",
                itemType: l.type,
                action: l.action,
                notifyJoe: true,
                notifyUrgency: "next_briefing" as const
              })),
        context,
        mode: "activation"
      })
    );
  }

  recordBriefing(briefedItemIds: string[]) {
    setSystemState("last_briefing_time", new Date().toISOString());
    if (briefedItemIds.length) {
      const existing = parseBriefedIds();
      const merged = [...new Set([...existing, ...briefedItemIds])];
      setSystemState("last_briefed_items", JSON.stringify(merged));
    }
    setSystemState("last_spoke_at", new Date().toISOString());
  }

  async summarizeExecutionLogToday(): Promise<string> {
    const logs = getExecutionLogSince(new Date(Date.now() - 24 * 60 * 60 * 1000), 80).filter((l) => {
      const d = new Date(l.timestamp);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    });
    if (!logs.length) return spoken("Nothing handled autonomously today yet, sir.");
    return spoken(await generateExecutionLogSummary(logs));
  }
}
