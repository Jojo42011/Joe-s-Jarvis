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

// ── Totally Outdoors (landscaping) project pipeline + 50/50 milestones ──
// Adapted from the pool-construction blueprint. Stage/trade/milestone lists
// below are the proposed landscaping defaults — Joe should confirm.

export const TIERS = ['standard', 'luxury'] as const;
export const PERMIT_STATUSES = ['none', 'draft', 'submitted', 'approved'] as const;
export const DESIGN_STATUSES = ['none', 'agreement_sent', 'paid', 'delivered'] as const;
export const SUB_TRADES = ['excavation', 'hardscape', 'landscaping', 'irrigation', 'lighting', 'masonry', 'planting', 'snow_removal', 'other'] as const;

// Physical build stages for a landscaping/hardscaping project, in order.
// A lead enters this track once the contract is signed. (Proposed sequence —
// Joe should confirm it matches how Totally Outdoors actually runs jobs.)
export const BUILD_STAGES = [
  { key: 'quoted',              label: 'Quoted' },
  { key: 'design_approved',     label: 'Design Approved' },
  { key: 'site_prep',           label: 'Site Prep & Excavation' },
  { key: 'hardscape_install',   label: 'Hardscape Install' },
  { key: 'planting_irrigation', label: 'Planting & Irrigation' },
  { key: 'cleanup_walkthrough', label: 'Cleanup & Walkthrough' },
  { key: 'completed',           label: 'Completed / Sign-off' },
] as const;

// 50/50 default — confirm Joe's actual billing practice; recurring services
// (mowing/plowing) are invoiced per-service and out of scope for v1.
// Keyed to the build stage where each payment comes DUE — the stage-gate check
// fires when a project moves into (or past) that stage with it still pending.
export const MILESTONES = [
  { pct: 50, label: 'Deposit (50%)',       dueAtStage: 'design_approved' },
  { pct: 50, label: 'Final payment (50%)', dueAtStage: 'completed' },
] as const;

// Most landscaping work needs no municipal inspection. Kept as a single
// optional entry (e.g. retaining walls over code height, structures needing a
// permit) so the inspections feature stays mechanically working — Joe should
// confirm what Holmes County / Millersburg actually requires.
export const DEFAULT_INSPECTIONS = [
  { key: 'permit_required_work', label: 'Permit-Required Work (e.g. retaining wall over code height)', done: false, date: null as string | null },
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
