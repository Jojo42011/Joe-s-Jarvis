/**
 * Home / sweep / pipeline / spend / hire / search.
 *
 * Every figure here comes from an uncapped query over the real tables. Where a
 * number cannot be proven, the payload says so explicitly (`unconfirmed: true`)
 * rather than sending a plausible 0 — a dashboard that invents activity costs
 * trust in every other number on the platform.
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { getLastExecution } from '../db/queries';
import { PIPELINE, BUILD_STAGES, STAGE_WEIGHT } from '../services/leadShared';
import { emailCountsByAccount, listEmailItems, listUpcomingEvents, anyGoogleAccountConnected } from '../db/google';
import { listOutstandingInvoices } from '../services/invoicing';
import { listOrders } from '../services/materials';
import { googleConfigured } from '../config/google';

const router = Router();

const TZ = 'America/New_York';


function todayISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

interface LeadLite {
  id: number; name: string; phone: string | null; email: string | null;
  source: string | null; pipeline: string | null; build_stage: string | null;
  project_value_cents: number | null; created_at: string; message: string | null;
}

function allLeads(): LeadLite[] {
  return getDb().prepare(`
    SELECT id, name, phone, email, source, pipeline, build_stage,
           project_value_cents, created_at, message
    FROM leads ORDER BY created_at DESC
  `).all() as LeadLite[];
}

// ── Home ───────────────────────────────────────────────────────────────────

router.get('/home', (_req: Request, res: Response) => {
  const db = getDb();
  const leads = allLeads();
  const open = leads.filter((l) => l.pipeline !== 'lost' && l.pipeline !== 'completed');

  // Agents: "live" means it can actually run right now, not that it's configured.
  const brainLive = !!process.env.ANTHROPIC_API_KEY?.trim();
  const phoneLive = !!process.env.VAPI_API_KEY?.trim();

  const lastCall = db.prepare(
    'SELECT customer_name, number, started_at, summary FROM vapi_calls ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1'
  ).get() as { customer_name?: string; number?: string; started_at?: string; summary?: string } | undefined;

  // Resolved against the table's real columns — this deployment's execution_log
  // predates the current schema and has neither `detail` nor `created_at`.
  const lastExec = getLastExecution();

  const callCount = (db.prepare('SELECT COUNT(*) c FROM vapi_calls').get() as { c: number }).c;

  // Waiting on Joe: email drafts only (content + SEO approval queues don't exist).
  const drafts = anyGoogleAccountConnected()
    ? listEmailItems({ pendingDraftsOnly: true, limit: 50 })
    : [];

  const invoices = listOutstandingInvoices();
  const unsentInvoices = invoices.filter((i) => !i.invoice_sent_at);

  // Materials that a project has already passed the stage for.
  const openOrders = listOrders({ openOnly: true });
  const lateOrders = openOrders.filter((o) => {
    if (!o.needed_by_stage || o.status === 'ordered') return false;
    const leadStage = leads.find((l) => l.id === o.lead_id)?.build_stage;
    if (!leadStage) return false;
    const need = BUILD_STAGES.findIndex((s) => s.key === o.needed_by_stage);
    const at = BUILD_STAGES.findIndex((s) => s.key === leadStage);
    return need >= 0 && at >= 0 && need <= at;
  });

  const today = todayISO();
  const events = anyGoogleAccountConnected() ? listUpcomingEvents(undefined, 40) : [];
  const todaysEvents = events.filter((e) => String(e.start_time || '').slice(0, 10) === today);

  const weighted = open.reduce(
    (sum, l) => sum + (l.project_value_cents || 0) * (STAGE_WEIGHT[l.pipeline || 'new'] ?? 0.05), 0
  );
  const valuedLeads = open.filter((l) => (l.project_value_cents || 0) > 0).length;

  res.json({
    agents: [
      {
        name: 'Jarvis', role: 'Chief of staff', live: brainLive,
        headline: lastExec?.action
          ? `${lastExec.action}${lastExec.detail ? ` — ${String(lastExec.detail).slice(0, 90)}` : ''}`
          : 'Ready. Nothing logged yet today.',
        detail: brainLive ? null : 'ANTHROPIC_API_KEY is not set, so the brain cannot answer.',
      },
      {
        name: 'Sofia', role: 'Phone receptionist', live: phoneLive,
        headline: lastCall
          ? `Last call: ${lastCall.customer_name || lastCall.number || 'unknown caller'}`
          : (callCount ? `${callCount} calls on file` : 'No calls recorded yet.'),
        detail: phoneLive ? null : 'VAPI_API_KEY is not set, so calls are not being synced.',
      },
    ],
    waiting: {
      emailDrafts: drafts.map((d) => ({
        id: d.id, from: d.from_addr, subject: d.subject, account: d.account_email,
      })),
      unsentInvoices: unsentInvoices.map((i) => ({
        payment_id: i.payment_id, lead: i.lead_name, label: i.label,
        amount_cents: i.amount_cents, invoice_no: i.invoice_no,
      })),
      lateMaterials: lateOrders.map((o) => ({
        id: o.id, po: o.po_number, lead: o.lead_name, status: o.status, stage: o.needed_by_stage,
      })),
    },
    appointments: {
      connected: anyGoogleAccountConnected(),
      today: todaysEvents.map((e) => ({
        summary: e.summary, start: e.start_time, location: e.location,
      })),
    },
    pipeline: {
      openLeads: open.length,
      weightedCents: Math.round(weighted),
      // If no open lead carries a value, the forecast is unprovable — say so.
      weightedUnconfirmed: valuedLeads === 0,
      valuedLeads,
    },
    recentLeads: leads.slice(0, 8).map((l) => ({
      id: l.id, name: l.name, phone: l.phone, source: l.source,
      pipeline: l.pipeline, created_at: l.created_at,
      message: l.message ? String(l.message).slice(0, 120) : null,
    })),
    inbox: anyGoogleAccountConnected()
      ? { connected: true, accounts: emailCountsByAccount() }
      : { connected: false, accounts: [], reason: googleConfigured()
          ? 'No mailbox has authorized yet — connect one in Integrations.'
          : 'Google is not configured.' },
    generatedAt: new Date().toISOString(),
  });
});

// ── What you missed ────────────────────────────────────────────────────────

router.get('/sweep', (req: Request, res: Response) => {
  const db = getDb();
  const days = Math.max(1, Math.min(Number(req.query.days) || Number(process.env.SWEEP_DAYS) || 7, 90));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const leads = db.prepare(`
    SELECT id, name, phone, source, pipeline, created_at, message
    FROM leads WHERE created_at >= ? ORDER BY created_at DESC
  `).all(since) as { id: number; name: string; phone: string; source: string | null; pipeline: string | null; created_at: string; message: string | null }[];

  const calls = db.prepare(`
    SELECT id, customer_name, number, direction, duration_sec, started_at, summary, booked
    FROM vapi_calls WHERE COALESCE(started_at, created_at) >= ? ORDER BY COALESCE(started_at, created_at) DESC
  `).all(since) as { id: string; customer_name: string | null; number: string | null; direction: string | null; duration_sec: number | null; started_at: string | null; summary: string | null; booked: number }[];

  const otherCalls = db.prepare(`
    SELECT id, name, phone, category, message, created_at
    FROM other_calls WHERE created_at >= ? ORDER BY created_at DESC
  `).all(since) as { id: number; name: string; phone: string; category: string; message: string | null; created_at: string }[];

  const emails = anyGoogleAccountConnected()
    ? listEmailItems({ limit: 200 }).filter((e) => String(e.received_at || '') >= since)
    : [];

  // "Nobody acted on" — a lead still sitting at 'new' with no activity logged.
  const actedLeadIds = new Set(
    (db.prepare(`SELECT DISTINCT lead_id FROM lead_activities WHERE created_at >= ?`).all(since) as { lead_id: number }[])
      .map((r) => r.lead_id)
  );
  const untouchedLeads = leads.filter((l) => (l.pipeline === 'new' || !l.pipeline) && !actedLeadIds.has(l.id));
  const unrepliedEmails = emails.filter((e) => e.needs_reply && e.draft_status !== 'sent');

  res.json({
    windowDays: days,
    since,
    counts: { leads: leads.length, calls: calls.length, otherCalls: otherCalls.length, emails: emails.length },
    unactioned: {
      leads: untouchedLeads.map((l) => ({ id: l.id, name: l.name, phone: l.phone, source: l.source, created_at: l.created_at, message: l.message })),
      emails: unrepliedEmails.map((e) => ({ id: e.id, from: e.from_addr, subject: e.subject, received_at: e.received_at, account: e.account_email })),
    },
    leads, calls, otherCalls,
    emails: emails.map((e) => ({ id: e.id, from: e.from_addr, subject: e.subject, received_at: e.received_at, priority: e.priority, category: e.category })),
    emailsConnected: anyGoogleAccountConnected(),
  });
});

// ── Pipeline ───────────────────────────────────────────────────────────────

router.get('/pipeline', (_req: Request, res: Response) => {
  const leads = allLeads();
  const stages = PIPELINE.map((stage) => {
    const rows = leads.filter((l) => (l.pipeline || 'new') === stage);
    const valueCents = rows.reduce((s, l) => s + (l.project_value_cents || 0), 0);
    const weight = STAGE_WEIGHT[stage] ?? 0;
    return {
      stage, weight, count: rows.length, valueCents,
      weightedCents: Math.round(valueCents * weight),
      valuedCount: rows.filter((l) => (l.project_value_cents || 0) > 0).length,
      leads: rows.map((l) => ({
        id: l.id, name: l.name, project_value_cents: l.project_value_cents,
        created_at: l.created_at, source: l.source,
      })),
    };
  });
  const openStages = stages.filter((s) => s.stage !== 'lost' && s.stage !== 'completed');
  res.json({
    stages,
    totalWeightedCents: openStages.reduce((s, x) => s + x.weightedCents, 0),
    totalOpenCents: openStages.reduce((s, x) => s + x.valueCents, 0),
    // How much of the forecast rests on leads that actually carry a value.
    valuedLeads: openStages.reduce((s, x) => s + x.valuedCount, 0),
    openLeads: openStages.reduce((s, x) => s + x.count, 0),
  });
});

// ── Wasted spend ───────────────────────────────────────────────────────────

router.get('/spend', (_req: Request, res: Response) => {
  const db = getDb();
  const items = db.prepare('SELECT * FROM spend_items ORDER BY active DESC, cost_cents DESC').all() as {
    id: number; name: string; kind: string; cost_cents: number; cycle: string;
    purpose: string | null; lead_source: string | null; last_used: string | null;
    cancel_url: string | null; active: number;
  }[];

  const annual = (i: { cost_cents: number; cycle: string }) =>
    i.cycle === 'yearly' ? i.cost_cents : i.cycle === 'one_time' ? 0 : i.cost_cents * 12;

  const leadsBySource = db.prepare(
    'SELECT source, COUNT(*) c FROM leads WHERE source IS NOT NULL GROUP BY source'
  ).all() as { source: string; c: number }[];
  const sourceMap = new Map(leadsBySource.map((r) => [r.source.toLowerCase(), r.c]));

  res.json({
    items: items.map((i) => {
      const leads = i.lead_source ? sourceMap.get(i.lead_source.toLowerCase()) ?? 0 : null;
      const annualCents = annual(i);
      return {
        ...i,
        annualCents,
        leads,
        // Cost per lead is only meaningful if it claims to generate leads AND
        // some arrived; otherwise it is unprovable, not zero.
        costPerLeadCents: i.lead_source && leads ? Math.round(annualCents / leads) : null,
        costPerLeadUnconfirmed: !!i.lead_source && !leads,
      };
    }),
    annualTotalCents: items.filter((i) => i.active).reduce((s, i) => s + annual(i), 0),
    monthlyTotalCents: Math.round(items.filter((i) => i.active).reduce((s, i) => s + annual(i), 0) / 12),
  });
});

router.post('/spend', (req: Request, res: Response) => {
  const b = req.body as { name?: string; kind?: string; cost_cents?: number; cycle?: string;
                          purpose?: string; lead_source?: string; cancel_url?: string };
  if (!b.name?.trim()) { res.status(400).json({ ok: false, error: 'name required' }); return; }
  const info = getDb().prepare(`
    INSERT INTO spend_items (name, kind, cost_cents, cycle, purpose, lead_source, cancel_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(b.name.trim(), b.kind || 'subscription', Math.max(0, Math.round(Number(b.cost_cents) || 0)),
         b.cycle || 'monthly', b.purpose?.trim() || null, b.lead_source?.trim() || null, b.cancel_url?.trim() || null);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.patch('/spend/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const b = req.body as { active?: boolean; cost_cents?: number; last_used?: string };
  const sets: string[] = []; const vals: unknown[] = [];
  if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
  if (b.cost_cents !== undefined) { sets.push('cost_cents = ?'); vals.push(Math.round(Number(b.cost_cents) || 0)); }
  if (b.last_used !== undefined) { sets.push('last_used = ?'); vals.push(b.last_used); }
  if (!sets.length) { res.status(400).json({ ok: false, error: 'nothing to update' }); return; }
  sets.push('updated_at = CURRENT_TIMESTAMP');
  getDb().prepare(`UPDATE spend_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  res.json({ ok: true });
});

router.delete('/spend/:id', (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM spend_items WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── Hire a new agent (a proposal is a spec, not an agent) ──────────────────

router.get('/hire', (_req: Request, res: Response) => {
  res.json({
    proposals: getDb().prepare('SELECT * FROM agent_proposals ORDER BY created_at DESC').all(),
  });
});

router.post('/hire', async (req: Request, res: Response) => {
  const ask = String((req.body as { ask?: string })?.ask || '').trim();
  if (!ask) { res.status(400).json({ ok: false, error: 'Describe the gap in your own words first.' }); return; }

  // Draft a spec from Joe's words. If the brain is unavailable the ask is still
  // filed verbatim — losing what he typed would be the worse failure.
  let spec: string | null = null;
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const { ANTHROPIC_FAST_MODEL } = await import('../config/models');
      const client = new Anthropic({ apiKey: key });
      const r = await client.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 700,
        system:
          'You write short, concrete build specs for a landscaping company\'s internal AI ops platform ' +
          '(Totally Outdoors LLC, Millersburg Ohio). Given the owner\'s description of a gap, write a spec: ' +
          'what the agent would do, what data/integrations it needs, what it must never do, and how you would ' +
          'know it works. Plain English, no fluff, under 250 words. This is a PROPOSAL for a human to build — ' +
          'never imply it builds or deploys itself.',
        messages: [{ role: 'user', content: ask }],
      });
      const block = r.content.find((b) => b.type === 'text');
      spec = block && block.type === 'text' ? block.text : null;
    }
  } catch (err) {
    console.error('[Hire] spec draft failed (ask still filed):', err instanceof Error ? err.message : err);
  }

  const info = getDb().prepare('INSERT INTO agent_proposals (ask, spec) VALUES (?, ?)').run(ask, spec);
  res.json({ ok: true, id: Number(info.lastInsertRowid), spec, specFailed: !spec });
});

router.patch('/hire/:id', (req: Request, res: Response) => {
  const status = String((req.body as { status?: string })?.status || '');
  if (!['proposed', 'approved', 'declined', 'built'].includes(status)) {
    res.status(400).json({ ok: false, error: 'bad status' }); return;
  }
  getDb().prepare('UPDATE agent_proposals SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, Number(req.params.id));
  res.json({ ok: true });
});

// ── Nav counts (no keys for subsystems that do not exist) ──────────────────

router.get('/nav-counts', (_req: Request, res: Response) => {
  const db = getDb();
  const drafts = anyGoogleAccountConnected() ? listEmailItems({ pendingDraftsOnly: true, limit: 200 }).length : 0;
  const openLeads = (db.prepare(
    "SELECT COUNT(*) c FROM leads WHERE pipeline NOT IN ('completed','lost') OR pipeline IS NULL"
  ).get() as { c: number }).c;
  res.json({ approve: drafts, crm: openLeads, money: listOutstandingInvoices().length });
});

// ── Search (⌘K palette) ────────────────────────────────────────────────────

router.get('/search', (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) { res.json({ results: [] }); return; }
  const like = `%${q}%`;
  const db = getDb();

  const leads = db.prepare(`
    SELECT id, name, phone, pipeline FROM leads
    WHERE lower(name) LIKE ? OR phone LIKE ? OR lower(COALESCE(email,'')) LIKE ?
    ORDER BY created_at DESC LIMIT 6
  `).all(like, like, like) as { id: number; name: string; phone: string; pipeline: string | null }[];

  const calls = db.prepare(`
    SELECT id, customer_name, number FROM vapi_calls
    WHERE lower(COALESCE(customer_name,'')) LIKE ? OR COALESCE(number,'') LIKE ?
    ORDER BY COALESCE(started_at, created_at) DESC LIMIT 4
  `).all(like, like) as { id: string; customer_name: string | null; number: string | null }[];

  res.json({
    results: [
      ...leads.map((l) => ({ kind: 'lead', key: String(l.id), title: l.name, sub: `${l.phone || 'no phone'} · ${l.pipeline || 'new'}` })),
      ...calls.map((c) => ({ kind: 'call', key: c.id, title: c.customer_name || c.number || 'Unknown caller', sub: 'Call' })),
    ],
  });
});

export default router;
