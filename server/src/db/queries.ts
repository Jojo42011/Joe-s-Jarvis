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
