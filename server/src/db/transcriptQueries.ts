import Anthropic from "@anthropic-ai/sdk";
import { db } from "./index";
import { findWorkingModel } from "../services/claude";
import { formatRelativeAge } from "../utils/temporal";

export type TranscriptRow = {
  id: number;
  title: string | null;
  date: string;
  durationSeconds: number;
  rawTranscript: string;
  summary: string | null;
  actionItems: string | null;
  createdAt: string;
};

type TranscriptDbRow = {
  id: number;
  title: string | null;
  date: string;
  duration_seconds: number;
  raw_transcript: string;
  summary: string | null;
  action_items: string | null;
  created_at: string;
};

function mapTranscript(row: TranscriptDbRow): TranscriptRow {
  return {
    id: row.id,
     title: row.title,
    date: row.date,
    durationSeconds: row.duration_seconds,
    rawTranscript: row.raw_transcript,
    summary: row.summary,
    actionItems: row.action_items,
    createdAt: row.created_at
  };
}

export function saveTranscript(input: {
  title?: string | null;
  date: string;
  durationSeconds: number;
  rawTranscript: string;
  summary?: string | null;
  actionItems?: string | null;
}): TranscriptRow {
  const result = db
    .prepare(
      `
    INSERT INTO transcripts (title, date, duration_seconds, raw_transcript, summary, action_items, created_at)
    VALUES (@title, @date, @durationSeconds, @rawTranscript, @summary, @actionItems, datetime('now'))
  `
    )
    .run({
      title: input.title?.slice(0, 300) || null,
      date: input.date,
      durationSeconds: input.durationSeconds,
      rawTranscript: input.rawTranscript.slice(0, 500_000),
      summary: input.summary?.slice(0, 8000) || null,
      actionItems: input.actionItems?.slice(0, 8000) || null
    });

  const row = db
    .prepare(`SELECT * FROM transcripts WHERE id = @id`)
    .get({ id: Number(result.lastInsertRowid) }) as TranscriptDbRow;

  return mapTranscript(row);
}

export function listTranscripts(limit = 40): TranscriptRow[] {
  const rows = db
    .prepare(`SELECT * FROM transcripts ORDER BY created_at DESC LIMIT @limit`)
    .all({ limit }) as TranscriptDbRow[];
  return rows.map(mapTranscript);
}

export function getTranscriptById(id: number): TranscriptRow | null {
  const row = db.prepare(`SELECT * FROM transcripts WHERE id = @id`).get({ id }) as
    | TranscriptDbRow
    | undefined;
  return row ? mapTranscript(row) : null;
}

const OHIO_TZ = "America/New_York";

function ohioWeekdayIndex(at: Date): number {
  const wd = at.toLocaleDateString("en-US", { timeZone: OHIO_TZ, weekday: "short" });
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? -1;
}

function parseWeekdayHint(message: string): number | null {
  const t = message.toLowerCase();
  const days = [
    ["sunday", 0],
    ["monday", 1],
    ["tuesday", 2],
    ["wednesday", 3],
    ["thursday", 4],
    ["friday", 5],
    ["saturday", 6]
  ] as const;
  for (const [name, idx] of days) {
    if (t.includes(name)) return idx;
  }
  return null;
}

export function searchTranscriptsByMessage(message: string, limit = 5): TranscriptRow[] {
  const weekday = parseWeekdayHint(message);
  const rows = listTranscripts(80);
  if (weekday === null) return rows.slice(0, limit);

  const now = new Date();
  const todayIdx = ohioWeekdayIndex(now);
  let diff = todayIdx - weekday;
  if (diff <= 0) diff += 7;

  const target = new Date(now.getTime() - diff * 86_400_000);
  const targetKey = target.toLocaleDateString("en-CA", { timeZone: OHIO_TZ });

  return rows.filter((r) => r.date.startsWith(targetKey)).slice(0, limit);
}

const summarizeAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export type TranscriptSummary = {
  title: string;
  summary: string;
  actionItems: string;
  peopleMentioned: string[];
};

export async function summarizeTranscript(rawTranscript: string): Promise<TranscriptSummary | null> {
  const trimmed = rawTranscript.trim();
  if (!trimmed) return null;

  if (!summarizeAnthropic) {
    return {
      title: "Job site recording",
      summary: trimmed.slice(0, 400),
      actionItems: "",
      peopleMentioned: []
    };
  }

  const model = await findWorkingModel();
  if (!model) {
    return {
      title: "Job site recording",
      summary: trimmed.slice(0, 400),
      actionItems: "",
      peopleMentioned: []
    };
  }

  try {
    const response = await summarizeAnthropic.messages.create({
      model,
      max_tokens: 500,
      temperature: 0.2,
      system:
        "Summarize field/meeting transcripts for a landscaping operator. Return JSON only with keys: title, summary, actionItems (bullet string), peopleMentioned (string array).",
      messages: [
        {
          role: "user",
          content: `Transcript:\n${trimmed.slice(0, 120_000)}\n\nReturn JSON only.`
        }
      ]
    });

    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        title: "Job site recording",
        summary: trimmed.slice(0, 400),
        actionItems: "",
        peopleMentioned: []
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<TranscriptSummary>;
    return {
      title: String(parsed.title || "Job site recording").slice(0, 200),
      summary: String(parsed.summary || trimmed.slice(0, 400)).slice(0, 2000),
      actionItems: String(parsed.actionItems || "").slice(0, 2000),
      peopleMentioned: Array.isArray(parsed.peopleMentioned)
        ? parsed.peopleMentioned.map(String).slice(0, 20)
        : []
    };
  } catch {
    return {
      title: "Job site recording",
      summary: trimmed.slice(0, 400),
      actionItems: "",
      peopleMentioned: []
    };
  }
}

export function formatTranscriptForSpeech(row: TranscriptRow): string {
  const when = formatRelativeAge(row.createdAt);
  const mins = Math.max(1, Math.round(row.durationSeconds / 60));
  const brief = row.summary?.slice(0, 160) || "Recording captured.";
  return `${when}: ${row.title || "Recording"} — ${mins} minute${mins === 1 ? "" : "s"}. ${brief}`;
}
