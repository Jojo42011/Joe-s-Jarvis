import { getDb } from './schema';

export function insertConversation(role: string, content: string): void {
  const db = getDb();
  db.prepare('INSERT INTO conversations (role, content) VALUES (?, ?)').run(role, content);
}

/** Working memory: the last N conversation turns, oldest → newest. */
export function getRecentConversation(limit = 8): { role: string; content: string }[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT role, content FROM conversations ORDER BY id DESC LIMIT ?'
  ).all(limit) as { role: string; content: string }[];
  return rows.reverse();
}

export function getSystemState(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSystemState(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO system_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

export function logExecution(action: string, detail?: string): void {
  const db = getDb();
  db.prepare('INSERT INTO execution_log (action, detail) VALUES (?, ?)').run(action, detail ?? null);
}

/**
 * execution_log exists in two shapes and both are live.
 *
 * A fresh database gets the schema in db/schema.ts — (action, detail,
 * created_at). Joe's production volume instead carries a table from a much
 * earlier build — (type, action, item_id, summary, result, timestamp) — and
 * `CREATE TABLE IF NOT EXISTS` never reshapes an existing table, so the columns
 * a query can rely on differ per deployment. Rather than assume either shape (or
 * bolt more columns onto a table whose rows mean something else), resolve the
 * timestamp and detail columns from the table itself.
 */
let logShape: { ts: string; detail: string | null } | null = null;

function executionLogShape(): { ts: string; detail: string | null } {
  if (logShape) return logShape;
  const db = getDb();
  const names = new Set(
    (db.prepare('PRAGMA table_info(execution_log)').all() as { name: string }[]).map((c) => c.name),
  );
  // `detail` is what this build writes; legacy rows carry their text in
  // `summary`. On Joe's volume BOTH exist — `detail` was added so inserts work,
  // but it is null for every pre-existing row — so coalesce rather than picking
  // one, otherwise the empty new column hides the history that is actually there.
  const hasDetail = names.has('detail');
  const hasSummary = names.has('summary');
  logShape = {
    ts: names.has('created_at') ? 'created_at' : names.has('timestamp') ? 'timestamp' : 'rowid',
    detail: hasDetail && hasSummary ? 'COALESCE(detail, summary)'
          : hasDetail ? 'detail'
          : hasSummary ? 'summary'
          : null,
  };
  return logShape;
}

export type LastExecution = { action?: string; detail?: string; at?: string };

/** The most recent thing Jarvis did, or null when nothing is logged yet. */
export function getLastExecution(): LastExecution | null {
  try {
    const db = getDb();
    const { ts, detail } = executionLogShape();
    const row = db.prepare(
      `SELECT action, ${detail ? detail : 'NULL'} AS detail, ${ts} AS at
       FROM execution_log ORDER BY ${ts} DESC LIMIT 1`,
    ).get() as LastExecution | undefined;
    return row ?? null;
  } catch (err) {
    // A dashboard must not 500 because a log table is an unexpected shape.
    console.error('[queries] getLastExecution failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
