/**
 * CRM junk filter — shared call-classification rules plus the one-time
 * cleanup sweep that re-classifies existing leads and moves non-prospects
 * out of the pipeline into other_calls (nothing is deleted outright; every
 * moved row keeps its data and can be promoted back from the CRM).
 *
 * Runs once at boot (guarded by a system_state flag) and on demand via
 * POST /api/crm/cleanup. Requires ANTHROPIC_API_KEY; without it, it no-ops.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '../config/anthropic';
import { getDb } from '../db/schema';
import { getSystemState, setSystemState } from '../db/queries';
import { safeJsonParse } from '../utils/safeJson';
import { ANTHROPIC_FAST_MODEL } from '../config/models';

export const CALL_CATEGORIES = ['prospect', 'client', 'vendor', 'spam', 'other'] as const;
export type CallCategory = (typeof CALL_CATEGORIES)[number];

// Shared with the Vapi webhook's extraction prompt so live calls and the
// cleanup sweep classify identically.
export const CLASSIFY_RULES =
  '"category" must be exactly one of:\n' +
  '- "prospect": a homeowner or property owner (or their representative) interested in outdoor work — landscaping, hardscaping, a patio or retaining wall, lawn care, excavating, drainage, a pond, snow plowing, pricing, or booking an estimate. When unsure, choose prospect.\n' +
  '- "client": an existing client, or someone calling about a project already underway.\n' +
  '- "vendor": a subcontractor, supplier, distributor, or delivery about materials/work FOR the business.\n' +
  '- "spam": telemarketing/robocalls — loans, financing offers TO the business, tax relief, credit cards, insurance, marketing/SEO/web-design pitches, donations, surveys, anything unrelated to buying landscaping, hardscaping, excavating, lawn care, or snow plowing work.\n' +
  '- "other": misdials, job applicants, no-info hangups, or calls where the "caller" is just the business\'s own assistant with no real person captured.';

const CLEANUP_FLAG = 'crm_junk_cleanup_v1';
const BATCH_SIZE = 25;

interface CandidateLead { id: number; name: string | null; phone: string | null; message: string | null }

async function classifyBatch(client: Anthropic, batch: CandidateLead[]): Promise<Map<number, CallCategory>> {
  const listing = batch.map((l) => ({ id: l.id, name: l.name || '', phone: l.phone || '', notes: l.message || '' }));
  const response = await client.messages.create({
    model: ANTHROPIC_FAST_MODEL,
    max_tokens: 2048,
    system:
      'You classify phone-call records for Totally Outdoors LLC, a landscaping, hardscaping, and excavating company in Millersburg, Ohio. ' +
      'For EACH record, assign a category.\n' + CLASSIFY_RULES + '\n' +
      'Return JSON only: {"classifications": [{"id": <number>, "category": "<category>"}, ...]} — one entry per input record. No prose, no code fences.',
    messages: [{ role: 'user', content: JSON.stringify(listing) }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  const parsed = safeJsonParse<{ classifications?: { id?: unknown; category?: unknown }[] }>(
    textBlock && textBlock.type === 'text' ? textBlock.text : '',
  );
  const out = new Map<number, CallCategory>();
  for (const c of parsed?.classifications ?? []) {
    const id = Number(c.id);
    const cat = String(c.category);
    if (Number.isFinite(id) && (CALL_CATEGORIES as readonly string[]).includes(cat)) {
      out.set(id, cat as CallCategory);
    }
  }
  return out;
}

/**
 * Re-classify untouched sofia leads and move non-prospects to other_calls.
 * Conservative by design: only leads with no pipeline progress, no money, no
 * build stage are candidates, and anything unclassified stays a lead.
 */
export async function cleanupJunkLeads(): Promise<{ examined: number; moved: number; note?: string }> {
  const apiKey = anthropicApiKey();
  if (!apiKey) return { examined: 0, moved: 0, note: 'ANTHROPIC_API_KEY not configured — cleanup skipped' };

  const db = getDb();
  const candidates = db.prepare(`
    SELECT l.id, l.name, l.phone, l.message FROM leads l
    WHERE l.pipeline = 'new' AND l.called = 0 AND l.booked = 0
      AND l.build_stage IS NULL AND l.project_value_cents IS NULL
      AND (l.source IN ('sofia', 'sofia_call') OR l.source IS NULL)
      AND NOT EXISTS (SELECT 1 FROM lead_payments p WHERE p.lead_id = l.id)
  `).all() as CandidateLead[];

  if (!candidates.length) return { examined: 0, moved: 0 };

  const client = new Anthropic({ apiKey });
  let moved = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    let verdicts: Map<number, CallCategory>;
    try {
      verdicts = await classifyBatch(client, batch);
    } catch (err) {
      console.error('[CRM cleanup] classification batch failed (leads kept):', err instanceof Error ? err.message : err);
      continue;
    }
    for (const lead of batch) {
      const category = verdicts.get(lead.id);
      if (!category || category === 'prospect') continue; // unsure = keep as lead
      db.prepare(`
        INSERT INTO other_calls (name, phone, category, message, original_lead_id, created_at)
        SELECT name, phone, ?, message, id, created_at FROM leads WHERE id = ?
      `).run(category, lead.id);
      db.prepare('DELETE FROM lead_activities WHERE lead_id = ?').run(lead.id);
      db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
      moved++;
    }
  }

  if (moved) console.log(`[CRM cleanup] moved ${moved} non-prospect call(s) out of the lead pipeline (of ${candidates.length} examined)`);
  return { examined: candidates.length, moved };
}

/** Boot hook: run the sweep exactly once per deploy generation. */
export function scheduleJunkCleanup(): void {
  if (getSystemState(CLEANUP_FLAG)) return;
  // Give the server a couple of minutes to settle before the API-heavy sweep.
  setTimeout(() => {
    cleanupJunkLeads()
      .then((r) => {
        if (r.note) { console.log('[CRM cleanup]', r.note); return; } // retry next boot once a key exists
        setSystemState(CLEANUP_FLAG, new Date().toISOString());
        console.log(`[CRM cleanup] one-time sweep done — ${r.moved}/${r.examined} moved to Other Calls`);
      })
      .catch((err) => console.error('[CRM cleanup] sweep error:', err));
  }, 2 * 60 * 1000);
}
