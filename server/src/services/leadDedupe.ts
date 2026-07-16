/**
 * Lead dedupe: one person = one row, keyed by phone number.
 *
 * Sofia's intake posts a fresh row every time someone calls, so the same
 * homeowner can appear 3–4 times. This merges them: the oldest row survives,
 * the best field values win (a real name beats "Sofia", anything beats blank),
 * activities/payments move to the survivor, and the dupes are deleted.
 * Runs once at startup and any time POST /api/leads/dedupe is hit.
 */

import { getDb } from '../db/schema';

const PIPELINE_ORDER = ['new', 'contacted', 'quoted', 'booked', 'in_progress', 'completed', 'lost'];

// Placeholder values Sofia's flow writes when the caller didn't give a real answer.
const JUNK = new Set(['', 'sofia', 'not provided', 'unknown', 'n/a', 'none', 'no name']);

interface LeadRow {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  project_type: string | null;
  budget: string | null;
  timeline: string | null;
  source: string | null;
  pipeline: string | null;
  notes: string | null;
  message: string | null;
  called: number;
  booked: number;
}

/** Digits only; last 10 so +1 prefixes and formatting don't split a person in two. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 7) return null; // "not provided", garbage, extensions
  return digits.slice(-10);
}

function isJunk(v: string | null | undefined): boolean {
  return !v || JUNK.has(String(v).trim().toLowerCase());
}

/** First real (non-placeholder) value across the group, else first non-empty. */
function best(rows: LeadRow[], field: keyof LeadRow): string | null {
  for (const r of rows) { const v = r[field]; if (!isJunk(v as string | null)) return v as string; }
  for (const r of rows) { const v = r[field]; if (v) return v as string; }
  return null;
}

/** Find an existing lead matching this phone (for insert-time merging). */
export function findLeadByPhone(phone: string | null | undefined): number | null {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const rows = getDb().prepare('SELECT id, phone FROM leads').all() as { id: number; phone: string | null }[];
  for (const r of rows) {
    if (normalizePhone(r.phone) === norm) return r.id;
  }
  return null;
}

/** Merge all duplicate-phone leads. Returns how many rows were folded away. */
export function dedupeLeads(): { merged: number; groups: number } {
  const db = getDb();
  const all = db.prepare('SELECT * FROM leads ORDER BY id').all() as LeadRow[];

  const byPhone = new Map<string, LeadRow[]>();
  for (const lead of all) {
    const norm = normalizePhone(lead.phone);
    if (!norm) continue; // unparseable phones are left alone — can't prove they're the same person
    const group = byPhone.get(norm);
    if (group) group.push(lead); else byPhone.set(norm, [lead]);
  }

  let merged = 0;
  let groups = 0;

  const run = db.transaction(() => {
    for (const group of byPhone.values()) {
      if (group.length < 2) continue;
      groups++;
      const keeper = group[0]; // lowest id = earliest contact, keeps the true created_at
      const dupes = group.slice(1);

      // Furthest pipeline stage wins, but a real stage beats 'lost'.
      const stages = group.map((g) => g.pipeline || 'new');
      const active = stages.filter((s) => s !== 'lost');
      let bestStage = (active.length ? active : stages)
        .sort((a, b) => PIPELINE_ORDER.indexOf(b) - PIPELINE_ORDER.indexOf(a))[0] || 'new';
      // If anyone in the group was already called, the person isn't "new".
      if (bestStage === 'new' && group.some((g) => g.called)) bestStage = 'contacted';

      db.prepare(`
        UPDATE leads SET
          name = ?, email = ?, address = ?, project_type = ?, budget = ?,
          timeline = ?, source = ?, notes = ?, message = ?, pipeline = ?,
          called = ?, booked = ?
        WHERE id = ?
      `).run(
        best(group, 'name'), best(group, 'email'), best(group, 'address'),
        best(group, 'project_type'), best(group, 'budget'), best(group, 'timeline'),
        best(group, 'source') || 'sofia', best(group, 'notes'), best(group, 'message'),
        bestStage,
        group.some((g) => g.called) ? 1 : 0,
        group.some((g) => g.booked) ? 1 : 0,
        keeper.id,
      );

      for (const d of dupes) {
        db.prepare('UPDATE lead_activities SET lead_id = ? WHERE lead_id = ?').run(keeper.id, d.id);
        db.prepare('UPDATE lead_payments SET lead_id = ? WHERE lead_id = ?').run(keeper.id, d.id);
        db.prepare('DELETE FROM leads WHERE id = ?').run(d.id);
        merged++;
      }

      db.prepare(`
        INSERT INTO lead_activities (lead_id, type, direction, body)
        VALUES (?, 'stage', 'system', ?)
      `).run(keeper.id, `Merged ${dupes.length} duplicate entr${dupes.length === 1 ? 'y' : 'ies'} (same phone number)`);
    }
  });
  run();

  if (merged) console.log(`[CRM] dedupe: folded ${merged} duplicate lead(s) across ${groups} phone number(s)`);
  return { merged, groups };
}
