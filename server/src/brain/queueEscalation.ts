import { db } from "../db/index";
import type { PriorityQueueItem } from "../db/queries";
import { getQueue, getQueueItemById } from "../db/queries";
import { getOhioDateKey } from "../utils/temporal";

export const RESURFACE_RULES = {
  NOW: {
    first_resurface_hours: 2,
    repeat_resurface_hours: 4,
    max_briefs_before_escalate: 3,
    auto_handle_days: 3
  },
  TODAY: {
    first_resurface_hours: 6,
    repeat_resurface_hours: 12,
    max_briefs_before_escalate: 3,
    auto_handle_days: 5
  },
  THIS_WEEK: {
    first_resurface_hours: 24,
    repeat_resurface_hours: 72,
    max_briefs_before_escalate: 4,
    auto_handle_days: 7
  },
  LOW: {
    first_resurface_hours: 72,
    repeat_resurface_hours: 168,
    max_briefs_before_escalate: 2,
    auto_handle_days: 14
  }
} as const;

export type QueueUrgencyKey = keyof typeof RESURFACE_RULES;

type QueueRow = {
  id: number;
  type: string;
  source_id: string | null;
  summary: string | null;
  action_needed: string | null;
  urgency: string | null;
  handled: number;
  raw_data: string | null;
  timestamp: string;
  status: string;
  first_briefed_at: string | null;
  last_briefed_at: string | null;
  brief_count: number;
  resurface_at: string | null;
  handled_reason: string | null;
  handled_at: string | null;
};

const QUEUE_SELECT = `
  id, type, source_id, summary, action_needed, urgency, handled, raw_data, timestamp,
  status, first_briefed_at, last_briefed_at, brief_count, resurface_at, handled_reason, handled_at
`;

function normalizeUrgency(urgency: string | null): QueueUrgencyKey {
  const u = (urgency || "THIS_WEEK").toUpperCase();
  if (u === "NOW" || u === "TODAY" || u === "THIS_WEEK" || u === "LOW") return u;
  if (u === "NONE") return "LOW";
  return "THIS_WEEK";
}

function mapRow(row: QueueRow): PriorityQueueItem {
  return {
    id: row.id,
    type: row.type,
    sourceId: row.source_id,
    summary: row.summary,
    actionNeeded: row.action_needed,
    urgency: row.urgency,
    handled: Boolean(row.handled),
    rawData: row.raw_data,
    timestamp: row.timestamp,
    status: row.status || "open",
    firstBriefedAt: row.first_briefed_at,
    lastBriefedAt: row.last_briefed_at,
    briefCount: row.brief_count ?? 0,
    resurfaceAt: row.resurface_at,
    handledReason: row.handled_reason,
    handledAt: row.handled_at
  };
}

export type ActionListItem = {
  id: number;
  summary: string | null;
  urgency: string | null;
  brief_count: number;
  source_id: string | null;
  type: string;
  action_needed: string | null;
  last_briefed_at: string | null;
  resurface_at?: string | null;
  handled_at?: string | null;
};

function mapActionListItem(item: PriorityQueueItem): ActionListItem {
  return {
    id: item.id,
    summary: item.summary,
    urgency: item.urgency,
    brief_count: item.briefCount ?? 0,
    source_id: item.sourceId,
    type: item.type,
    action_needed: item.actionNeeded,
    last_briefed_at: item.lastBriefedAt ?? null,
    resurface_at: item.resurfaceAt ?? null,
    handled_at: item.handledAt ?? null
  };
}

export function getHandledTodayOhio(limit = 10): PriorityQueueItem[] {
  const today = getOhioDateKey();
  const rows = db
    .prepare(
      `
    SELECT ${QUEUE_SELECT}
    FROM priority_queue
    WHERE handled = 1
    ORDER BY COALESCE(handled_at, timestamp) DESC
    LIMIT @limit
  `
    )
    .all({ limit: Math.min(Math.max(limit, 1), 50) }) as QueueRow[];

  return rows
    .map(mapRow)
    .filter((item) => {
      const at = item.handledAt || item.timestamp;
      if (!at) return false;
      const d = new Date(at);
      return !Number.isNaN(d.getTime()) && getOhioDateKey(d) === today;
    })
    .slice(0, limit);
}

export function getActionListPayload() {
  return {
    needs_attention: getQueueForBriefing().map(mapActionListItem),
    being_monitored: getQueueBeingMonitored().map(mapActionListItem),
    handled_today: getHandledTodayOhio(10).map(mapActionListItem)
  };
}

export function calculateResurfaceAt(
  urgency: string | null,
  lastBriefedAt: Date | null,
  briefCount: number
): Date {
  const rules = RESURFACE_RULES[normalizeUrgency(urgency)];
  const now = new Date();

  if (briefCount === 0) return now;

  const base = lastBriefedAt && !Number.isNaN(lastBriefedAt.getTime()) ? lastBriefedAt : now;
  const hours =
    briefCount === 1 ? rules.first_resurface_hours : rules.repeat_resurface_hours;

  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

export function getQueueForBriefing(): PriorityQueueItem[] {
  const rows = db
    .prepare(
      `
    SELECT ${QUEUE_SELECT}
    FROM priority_queue
    WHERE handled = 0
      AND status != 'handled'
      AND (
        status = 'open'
        OR (
          status = 'briefed'
          AND (resurface_at IS NULL OR datetime(resurface_at) <= datetime('now'))
        )
      )
    ORDER BY
      CASE urgency
        WHEN 'NOW' THEN 0
        WHEN 'TODAY' THEN 1
        WHEN 'THIS_WEEK' THEN 2
        ELSE 3
      END,
      resurface_at ASC
  `
    )
    .all() as QueueRow[];

  return rows.map(mapRow);
}

export function getQueueBeingMonitored(): PriorityQueueItem[] {
  const rows = db
    .prepare(
      `
    SELECT ${QUEUE_SELECT}
    FROM priority_queue
    WHERE handled = 0
      AND status = 'briefed'
      AND resurface_at IS NOT NULL
      AND datetime(resurface_at) > datetime('now')
    ORDER BY resurface_at ASC
  `
    )
    .all() as QueueRow[];

  return rows.map(mapRow);
}

export function markQueueItemBriefed(id: number): void {
  const item = getQueueItemById(id);
  if (!item) return;

  const nextBriefCount = (item.briefCount ?? 0) + 1;
  const lastBriefed = new Date();
  const resurfaceAt = calculateResurfaceAt(item.urgency, lastBriefed, nextBriefCount);

  db.prepare(
    `
    UPDATE priority_queue SET
      status = 'briefed',
      first_briefed_at = COALESCE(first_briefed_at, datetime('now')),
      last_briefed_at = datetime('now'),
      brief_count = @brief_count,
      resurface_at = @resurface_at,
      handled = 0
    WHERE id = @id
  `
  ).run({
    id,
    brief_count: nextBriefCount,
    resurface_at: resurfaceAt.toISOString()
  });
}

export function markQueueItemHandled(id: number, reason: string): void {
  db.prepare(
    `
    UPDATE priority_queue SET
      status = 'handled',
      handled = 1,
      handled_reason = @reason,
      handled_at = datetime('now')
    WHERE id = @id
  `
  ).run({ id, reason });
}

export function snoozeQueueItem(id: number, hours: number): { resurfacesAt: string } | null {
  const item = getQueueItemById(id);
  if (!item) return null;

  const safeHours = Math.min(Math.max(Math.round(hours), 1), 24 * 14);
  const resurfaceAt = new Date(Date.now() + safeHours * 60 * 60 * 1000).toISOString();

  db.prepare(
    `
    UPDATE priority_queue SET
      status = 'briefed',
      resurface_at = @resurface_at,
      handled = 0
    WHERE id = @id
  `
  ).run({ id, resurface_at: resurfaceAt });

  return { resurfacesAt: resurfaceAt };
}

export function escalateQueueItemUrgency(id: number): { newUrgency: string } | null {
  const item = getQueueItemById(id);
  if (!item) return null;

  const current = normalizeUrgency(item.urgency);
  let next: QueueUrgencyKey = current;
  if (current === "THIS_WEEK" || current === "LOW") next = "TODAY";
  else if (current === "TODAY") next = "NOW";

  let summary = item.summary || "";
  if (next === "NOW" && current === "NOW" && !summary.startsWith("[ESCALATED]")) {
    summary = `[ESCALATED] ${summary}`;
  }

  const lastBriefed = item.lastBriefedAt ? new Date(item.lastBriefedAt) : null;
  const resurfaceAt = calculateResurfaceAt(next, lastBriefed, item.briefCount ?? 0);

  db.prepare(
    `
    UPDATE priority_queue SET
      urgency = @urgency,
      summary = @summary,
      resurface_at = @resurface_at
    WHERE id = @id
  `
  ).run({
    id,
    urgency: next,
    summary: summary.slice(0, 500),
    resurface_at: resurfaceAt.toISOString()
  });

  return { newUrgency: next };
}

export function findQueueItemByDescription(description: string): PriorityQueueItem | null {
  const needle = description.trim().toLowerCase();
  if (!needle) return null;

  const open = getQueue(false);
  const match =
    open.find((q) => (q.summary || "").toLowerCase().includes(needle)) ||
    open.find((q) => needle.includes((q.summary || "").toLowerCase().slice(0, 40)));
  return match || null;
}

export function getQueueStatusPayload() {
  const needs_attention = getQueueForBriefing();
  const being_monitored = getQueueBeingMonitored();
  const total_open = getQueue(false).length;

  const mapItem = (q: PriorityQueueItem) => ({
    id: q.id,
    type: q.type,
    sourceId: q.sourceId,
    urgency: q.urgency,
    summary: q.summary,
    actionNeeded: q.actionNeeded,
    status: q.status,
    briefCount: q.briefCount,
    resurfaceAt: q.resurfaceAt,
    handled: q.handled
  });

  return {
    needs_attention: needs_attention.map(mapItem),
    being_monitored: being_monitored.map(mapItem),
    total_open,
    total_monitored: being_monitored.length
  };
}

export async function escalateStaleItems(): Promise<void> {
  const openRows = db
    .prepare(
      `
    SELECT ${QUEUE_SELECT}
    FROM priority_queue
    WHERE handled = 0 AND status != 'handled'
  `
    )
    .all() as QueueRow[];

  const now = Date.now();

  for (const row of openRows) {
    const item = mapRow(row);
    const rules = RESURFACE_RULES[normalizeUrgency(item.urgency)];
    const createdMs = Date.parse(item.timestamp);
    const ageDays =
      Number.isFinite(createdMs) ? (now - createdMs) / (24 * 60 * 60 * 1000) : 0;

    if (ageDays >= rules.auto_handle_days) {
      markQueueItemHandled(item.id, "timeout_7d");
      continue;
    }

    if (item.status !== "briefed" || (item.briefCount ?? 0) < rules.max_briefs_before_escalate) {
      continue;
    }

    const current = normalizeUrgency(item.urgency);
    if (current === "NOW") {
      if (!(item.summary || "").startsWith("[ESCALATED]")) {
        db.prepare(`UPDATE priority_queue SET summary = @summary WHERE id = @id`).run({
          id: item.id,
          summary: `[ESCALATED] ${item.summary || "Queue item"}`.slice(0, 500)
        });
      }
      const resurfaceAt = calculateResurfaceAt(
        "NOW",
        item.lastBriefedAt ? new Date(item.lastBriefedAt) : null,
        item.briefCount ?? 0
      );
      db.prepare(`UPDATE priority_queue SET resurface_at = @resurface_at WHERE id = @id`).run({
        id: item.id,
        resurface_at: resurfaceAt.toISOString()
      });
      continue;
    }

    escalateQueueItemUrgency(item.id);
  }
}

const HANDLED_PHRASES =
  /\b(took care of it|took care of that|handled it|already dealt with|already handled|already done|dealt with it|deal with it|not an issue|ignore that|forget it|not important|already handled that|that's handled|that is handled|that's done|that is done|it's done|its done|i handled|we handled|got it handled|already took care|took care of the|handled the|done with it|done with that|moved on from|not a problem anymore|resolved|that's resolved|already resolved|sorted it|sorted that|all set on that|taken care of)\b/i;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "need",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "up",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "and",
  "but",
  "if",
  "or",
  "because",
  "as",
  "until",
  "while",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "they",
  "them",
  "their",
  "it",
  "its",
  "email",
  "mail",
  "message",
  "jarvis",
  "joe",
  "sir"
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function markEmailQueueItemsFromKeywords(message: string): number {
  const keywords = extractKeywords(message);
  if (keywords.length < 1) return 0;

  const open = getQueue(false).filter((item) => item.type === "email");
  let marked = 0;

  for (const item of open) {
    const summary = (item.summary || "").toLowerCase();
    if (!summary) continue;
    const hits = keywords.filter((kw) => summary.includes(kw));
    if (hits.length >= 2 || (hits.length >= 1 && keywords.length === 1)) {
      markQueueItemHandled(item.id, "joe_context");
      marked += 1;
    }
  }

  return marked;
}

export function inferHandledFromContext(message: string, _sessionId: string): void {
  const text = message.trim();
  if (!text) return;

  if (HANDLED_PHRASES.test(text)) {
    const recent = getQueueBeingMonitored().slice(0, 5);
    for (const item of recent) {
      markQueueItemHandled(item.id, "joe_context");
    }
    markEmailQueueItemsFromKeywords(text);
    return;
  }

  const open = getQueue(false);
  const lower = text.toLowerCase();
  for (const item of open.slice(0, 40)) {
    const summary = (item.summary || "").toLowerCase();
    if (summary.length < 8) continue;
    const token = summary.slice(0, Math.min(48, summary.length));
    if (lower.includes(token)) {
      markQueueItemBriefed(item.id);
    }
  }
}

/** Manual cleanup for stale low-priority queue items (POST /api/queue/cleanup). */
export function cleanupStaleQueueItems(): {
  cleaned: number;
  staleOpen: number;
  staleBriefed: number;
} {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const staleOpenRows = db
    .prepare(
      `
    SELECT id FROM priority_queue
    WHERE handled = 0
      AND status = 'open'
      AND datetime(timestamp) < datetime(@since)
      AND UPPER(COALESCE(urgency, 'THIS_WEEK')) IN ('LOW', 'THIS_WEEK', 'NONE')
      AND brief_count = 0
  `
    )
    .all({ since: sevenDaysAgo }) as Array<{ id: number }>;

  const staleBriefedRows = db
    .prepare(
      `
    SELECT id FROM priority_queue
    WHERE handled = 0
      AND status = 'briefed'
      AND last_briefed_at IS NOT NULL
      AND datetime(last_briefed_at) < datetime(@since)
  `
    )
    .all({ since: fourteenDaysAgo }) as Array<{ id: number }>;

  const ids = new Set<number>();
  for (const row of staleOpenRows) ids.add(row.id);
  for (const row of staleBriefedRows) ids.add(row.id);

  for (const id of ids) {
    markQueueItemHandled(id, "stale_cleanup");
  }

  return {
    cleaned: ids.size,
    staleOpen: staleOpenRows.length,
    staleBriefed: staleBriefedRows.length
  };
}
