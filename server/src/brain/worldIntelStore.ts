import { db } from "../db";

export type WorldIntelRelevance = "HIGH" | "MEDIUM" | "LOW";

export type WorldIntelRow = {
  id: number;
  query: string;
  resultsJson: string | null;
  summary: string | null;
  relevance: WorldIntelRelevance | null;
  briefed: boolean;
  fetchedAt: string;
};

type WorldIntelDbRow = {
  id: number;
  query: string;
  results_json: string | null;
  summary: string | null;
  relevance: string | null;
  briefed: number;
  fetched_at: string;
};

function mapRow(row: WorldIntelDbRow): WorldIntelRow {
  const rel = row.relevance?.toUpperCase();
  const relevance =
    rel === "HIGH" || rel === "MEDIUM" || rel === "LOW" ? (rel as WorldIntelRelevance) : null;
  return {
    id: row.id,
    query: row.query,
    resultsJson: row.results_json,
    summary: row.summary,
    relevance,
    briefed: Boolean(row.briefed),
    fetchedAt: row.fetched_at
  };
}

export function insertWorldIntel(input: {
  query: string;
  resultsJson: string;
  summary?: string | null;
  relevance?: WorldIntelRelevance | null;
}): number {
  const result = db
    .prepare(
      `
    INSERT INTO world_intel (query, results_json, summary, relevance, briefed, fetched_at)
    VALUES (@query, @results_json, @summary, @relevance, 0, datetime('now'))
  `
    )
    .run({
      query: input.query,
      results_json: input.resultsJson,
      summary: input.summary ?? null,
      relevance: input.relevance ?? null
    });
  return Number(result.lastInsertRowid);
}

export function getWorldIntelPendingJudgment(limit = 50): WorldIntelRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, query, results_json, summary, relevance, briefed, fetched_at
    FROM world_intel
    WHERE (relevance IS NULL OR summary IS NULL OR summary = '')
    ORDER BY id ASC
    LIMIT @limit
  `
    )
    .all({ limit }) as WorldIntelDbRow[];
  return rows.map(mapRow);
}

export function updateWorldIntelJudgment(
  id: number,
  relevance: WorldIntelRelevance,
  summary: string
) {
  db.prepare(
    `
    UPDATE world_intel
    SET relevance = @relevance, summary = @summary
    WHERE id = @id
  `
  ).run({ id, relevance, summary });
}

export function getHighUnbriefedWorldIntel(): WorldIntelRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, query, results_json, summary, relevance, briefed, fetched_at
    FROM world_intel
    WHERE relevance = 'HIGH' AND briefed = 0
    ORDER BY id DESC
  `
    )
    .all() as WorldIntelDbRow[];
  return rows.map(mapRow);
}

export function getMediumUnbriefedWorldIntel(limit = 10): WorldIntelRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, query, results_json, summary, relevance, briefed, fetched_at
    FROM world_intel
    WHERE relevance = 'MEDIUM' AND briefed = 0
    ORDER BY id DESC
    LIMIT @limit
  `
    )
    .all({ limit }) as WorldIntelDbRow[];
  return rows.map(mapRow);
}

export function markWorldIntelBriefed(ids: number[]) {
  if (!ids.length) return;
  const stmt = db.prepare(`UPDATE world_intel SET briefed = 1 WHERE id = @id`);
  for (const id of ids) {
    stmt.run({ id });
  }
}

export function getWorldIntelSinceHours(hours = 48): WorldIntelRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, query, results_json, summary, relevance, briefed, fetched_at
    FROM world_intel
    WHERE datetime(fetched_at) >= datetime('now', @offset)
    ORDER BY
      CASE relevance
        WHEN 'HIGH' THEN 0
        WHEN 'MEDIUM' THEN 1
        WHEN 'LOW' THEN 2
        ELSE 3
      END,
      id DESC
  `
    )
    .all({ offset: `-${hours} hours` }) as WorldIntelDbRow[];
  return rows.map(mapRow);
}

export function getWorldIntelById(id: number): WorldIntelRow | null {
  const row = db
    .prepare(
      `
    SELECT id, query, results_json, summary, relevance, briefed, fetched_at
    FROM world_intel WHERE id = @id
  `
    )
    .get({ id }) as WorldIntelDbRow | undefined;
  return row ? mapRow(row) : null;
}

export function formatWorldIntelBriefingSpeech(items: WorldIntelRow[]): string {
  const bullets = items
    .map((i) => i.summary?.trim())
    .filter((s): s is string => Boolean(s));
  if (!bullets.length) return "";
  return `Sir, a few things from the outside world worth noting: ${bullets.join(". ")}.`;
}
