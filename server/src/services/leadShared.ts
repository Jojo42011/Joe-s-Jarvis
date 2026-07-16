/**
 * Shared lead constants + the activity-timeline logger. Lives outside
 * routes/leads.ts so services (leadIntake, leadFollowUp, vapiWebhook) can use
 * them without importing a route file.
 */

import { getDb } from '../db/schema';

// CRM pipeline stages, in funnel order. `called`/`booked` flags stay in sync for
// backwards compatibility with Sofia's flow and the old stats.
export const PIPELINE = ['new', 'contacted', 'quoted', 'booked', 'in_progress', 'completed', 'lost'] as const;
export const SOURCES = ['sofia', 'ads', 'ralph', 'website', 'referral', 'manual'] as const;

// ── Arthur's Blueprint: construction pipeline + 10/25/30/30/5 milestones ──

export const TIERS = ['standard', 'luxury'] as const;
export const PERMIT_STATUSES = ['none', 'draft', 'submitted', 'approved'] as const;
export const DESIGN_STATUSES = ['none', 'agreement_sent', 'paid', 'delivered'] as const;
export const SUB_TRADES = ['excavation', 'steel', 'plumbing', 'gunite', 'hardscape', 'landscaping', 'electrical', 'plaster', 'other'] as const;

// Physical build stages, in Arthur's exact sequence (leveling first — the grade
// sets everything). A lead enters this track once the contract is signed.
export const BUILD_STAGES = [
  { key: 'permitting',           label: 'Permitting & Engineering' },
  { key: 'leveling_demo',        label: 'Yard Leveling & Demo' },
  { key: 'excavation',           label: 'Excavation' },
  { key: 'steel_plumbing',       label: 'Steel & Plumbing' },
  { key: 'gunite',               label: 'Gunite Shell' },
  { key: 'structures_hardscape', label: 'Structures & Hardscape' },
  { key: 'landscaping_lighting', label: 'Landscaping & Lighting' },
  { key: 'interior_finish',      label: 'Interior Finish & Pebble' },
  { key: 'completed',            label: 'Completed / Sign-off' },
] as const;

// Arthur's payment schedule: 10% at contract, 25% at excavation, 30% at gunite,
// 30% at landscaping/lighting, 5% retainage at interior finish. Keyed to the
// build stage where each draw comes DUE — the stage-gate check fires when a
// project moves into (or past) that stage with the draw still pending.
export const MILESTONES = [
  { pct: 10, label: 'Deposit (10%)',            dueAtStage: 'permitting' },
  { pct: 25, label: 'Excavation draw (25%)',    dueAtStage: 'excavation' },
  { pct: 30, label: 'Gunite draw (30%)',        dueAtStage: 'gunite' },
  { pct: 30, label: 'Hardscape/Landscape draw (30%)', dueAtStage: 'landscaping_lighting' },
  { pct: 5,  label: 'Final retainage (5%)',     dueAtStage: 'interior_finish' },
] as const;

// Maricopa-area municipal inspections Arthur tracks on every build.
export const DEFAULT_INSPECTIONS = [
  { key: 'pre_excavation', label: 'Pre-Excavation / Setback Check', done: false, date: null as string | null },
  { key: 'steel_plumbing', label: 'Pre-Steel / Plumbing Pressure Test', done: false, date: null as string | null },
  { key: 'pre_plaster',    label: 'Pre-Plaster Barrier Check (Gates/Alarms)', done: false, date: null as string | null },
  { key: 'final',          label: 'Final Sign-off', done: false, date: null as string | null },
];

export function buildStageIndex(key: string | null | undefined): number {
  return BUILD_STAGES.findIndex((s) => s.key === key);
}

export function logActivity(leadId: number, type: string, opts: { direction?: string; subject?: string; body?: string; meta?: unknown } = {}): void {
  try {
    getDb().prepare(`
      INSERT INTO lead_activities (lead_id, type, direction, subject, body, meta)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(leadId, type, opts.direction || 'out', opts.subject ?? null, opts.body ?? null, opts.meta ? JSON.stringify(opts.meta) : null);
  } catch (err) {
    console.error('[CRM] activity log failed:', err);
  }
}
