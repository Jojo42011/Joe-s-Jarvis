import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { sendSms, sendSmsTo } from '../services/sms';
import { sendNewEmail } from '../services/google/gmail';
import { dedupeLeads } from '../services/leadDedupe';
import {
  PIPELINE, SOURCES, TIERS, PERMIT_STATUSES, DESIGN_STATUSES, SUB_TRADES,
  BUILD_STAGES, MILESTONES, DEFAULT_INSPECTIONS, buildStageIndex, logActivity,
} from '../services/leadShared';
import { createLead } from '../services/leadIntake';
import { createPaymentLink, isStripeConfigured } from '../services/stripe';
import { triggerStageInvoices, sendMilestoneInvoice, listOutstandingInvoices } from '../services/invoicing';
import {
  addSupplier, listSuppliers, createOrder, listOrders, getOrder, updateOrderStatus,
  sendPurchaseOrder, priceHistory, checkMaterialReadiness, SUPPLIER_CATEGORIES,
} from '../services/materials';

const router = Router();

export { PIPELINE, SOURCES, logActivity };

interface LeadBody {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  project_type?: string;
  budget?: string;
  timeline?: string;
  source?: string;
  pipeline?: string;
  notes?: string;
  message?: string;
}

interface VapiLead {
  name: string;
  phone: string;
  project_type?: string;
  budget?: string;
  address?: string;
}

async function fireVapiCall(lead: VapiLead): Promise<void> {
  const apiKey = process.env.VAPI_API_KEY;
  const assistantId = process.env.VAPI_SALES_AGENT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

  if (!apiKey || !assistantId || !phoneNumberId) {
    throw new Error('Vapi credentials not configured');
  }

  const response = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assistantId,
      phoneNumberId,
      customer: {
        number: lead.phone,
        name: lead.name,
      },
      assistantOverrides: {
        variableValues: {
          name: lead.name,
          project_type: lead.project_type,
          budget: lead.budget,
          address: lead.address,
        },
      },
    }),
  });

  const responseText = await response.text();
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = responseText;
  }

  console.log('[Jarvis] Vapi response:', response.status, responseBody);

  if (!response.ok) {
    throw new Error(`Vapi returned ${response.status}: ${responseText}`);
  }
}

// ── Leads: list + stats (revenue included so the CRM header is one fetch) ──
router.get('/leads', (_req: Request, res: Response) => {
  const db = getDb();
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(called), 0) AS called,
      COALESCE(SUM(booked), 0) AS booked
    FROM leads
  `).get() as Record<string, number>;
  const money = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS collected_cents,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_cents ELSE 0 END), 0) AS pending_cents
    FROM lead_payments
  `).get() as Record<string, number>;
  // Every source that actually feeds leads in, counted — including legacy/off-enum
  // values (e.g. an old 'sofia_call' row) so nothing silently drops off the chart.
  const bySourceRows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source, COUNT(*) AS count
    FROM leads GROUP BY 1 ORDER BY count DESC
  `).all() as { source: string; count: number }[];

  // Financial pulse: projected value across active builds vs collected vs outstanding.
  const pulse = db.prepare(`
    SELECT COALESCE(SUM(project_value_cents), 0) AS projected_cents
    FROM leads WHERE build_stage IS NOT NULL AND build_stage != 'completed' AND pipeline != 'lost'
  `).get() as { projected_cents: number };

  // Morning alerts: milestone draws that are DUE at (or before) the project's
  // current build stage but still pending, plus subs awaiting confirmation.
  const alerts: { leadId: number; name: string; kind: string; text: string }[] = [];
  const activeBuilds = db.prepare(`
    SELECT id, name, build_stage FROM leads
    WHERE build_stage IS NOT NULL AND build_stage != 'completed' AND pipeline != 'lost'
  `).all() as { id: number; name: string; build_stage: string }[];
  const pendingByLead = db.prepare('SELECT label FROM lead_payments WHERE lead_id = ? AND status = ?');
  for (const b of activeBuilds) {
    const stageIdx = buildStageIndex(b.build_stage);
    const pending = pendingByLead.all(b.id, 'pending') as { label: string }[];
    for (const m of MILESTONES) {
      if (buildStageIndex(m.dueAtStage) <= stageIdx && pending.some((p) => p.label === m.label)) {
        alerts.push({ leadId: b.id, name: b.name, kind: 'payment', text: `Collect ${m.label} from ${b.name}` });
      }
    }
  }
  const unconfirmed = db.prepare(`
    SELECT ls.lead_id, l.name AS lead_name, s.name AS sub_name, ls.stage, ls.scheduled_for
    FROM lead_subs ls JOIN leads l ON l.id = ls.lead_id JOIN subs s ON s.id = ls.sub_id
    WHERE ls.status = 'notified'
  `).all() as { lead_id: number; lead_name: string; sub_name: string; stage: string | null; scheduled_for: string | null }[];
  for (const u of unconfirmed) {
    alerts.push({ leadId: u.lead_id, name: u.lead_name, kind: 'sub', text: `${u.sub_name} hasn't confirmed ${u.stage || 'their'} schedule${u.scheduled_for ? ` for ${u.scheduled_for}` : ''} (${u.lead_name})` });
  }

  res.json({
    stats: { ...stats, ...money, projected_cents: pulse.projected_cents },
    leads, alerts,
    pipeline: PIPELINE, sources: SOURCES, buildStages: BUILD_STAGES, tiers: TIERS,
    permitStatuses: PERMIT_STATUSES, designStatuses: DESIGN_STATUSES, subTrades: SUB_TRADES,
    bySource: bySourceRows,
  });
});

// Full lead detail: the lead + its activity timeline + payments.
router.get('/leads/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) { res.status(404).json({ error: 'lead not found' }); return; }
  const activities = db.prepare('SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(id);
  const payments = db.prepare('SELECT * FROM lead_payments WHERE lead_id = ? ORDER BY created_at DESC, id DESC').all(id);
  const files = db.prepare('SELECT id, kind, name, mime, created_at FROM lead_files WHERE lead_id = ? ORDER BY created_at DESC, id DESC').all(id);
  const subs = db.prepare(`
    SELECT ls.id, ls.sub_id, ls.stage, ls.scheduled_for, ls.status, s.name, s.trade, s.phone
    FROM lead_subs ls JOIN subs s ON s.id = ls.sub_id
    WHERE ls.lead_id = ? ORDER BY ls.created_at DESC
  `).all(id);
  const estimate = db.prepare('SELECT * FROM lead_estimate_items WHERE lead_id = ? ORDER BY id').all(id);
  res.json({ lead, activities, payments, files, subs, estimate });
});

// Merge duplicate-phone leads on demand (also runs automatically at startup).
router.post('/leads/dedupe', (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, ...dedupeLeads() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'dedupe failed' });
  }
});

// Gmail accounts the CRM can send email from (connected via Integrations).
router.get('/crm/email-accounts', (_req: Request, res: Response) => {
  try {
    const rows = getDb().prepare('SELECT email, label FROM google_accounts ORDER BY id').all();
    res.json({ accounts: rows });
  } catch {
    res.json({ accounts: [] });
  }
});

router.post('/leads', async (req: Request, res: Response) => {
  const body = req.body as LeadBody;
  const { name, phone, email, address, project_type, budget, timeline, notes, message } = body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!phone || typeof phone !== 'string' || !phone.trim()) {
    res.status(400).json({ error: 'phone is required' });
    return;
  }

  // Sofia's intake flow is the historical caller of this endpoint and sends no
  // source — tag those 'sofia'. The CRM UI and other agents pass theirs explicitly.
  const source = body.source && (SOURCES as readonly string[]).includes(body.source) ? body.source : 'sofia';
  // Only Sofia's own voice intake auto-calls back — every other source (manual entry,
  // website, ads, referral, social) is a human-reviewed lead, not a live phone call.
  const skipAutoCall = source !== 'sofia';

  const db = getDb();

  const { leadId, merged } = await createLead({
    name, phone, email, address, project_type, budget, timeline, notes, message, source,
  });

  if (merged) {
    res.json({ success: true, leadId, merged: true });
    return;
  }

  if (skipAutoCall) {
    res.json({ success: true, leadId });
    return;
  }

  const trimmedName = name.trim();
  const trimmedPhone = phone.trim();
  const trimmedAddress = address?.trim();
  const trimmedBudget = budget?.trim();
  const trimmedTimeline = timeline?.trim();
  const smsMessage =
    `New lead from Sofia:\nName: ${trimmedName}\nPhone: ${trimmedPhone}\n` +
    `Address: ${trimmedAddress || 'not provided'}\nBudget: ${trimmedBudget || 'not provided'}\n` +
    `Timeline: ${trimmedTimeline || 'not provided'}`;

  console.log('[Jarvis] SMS notification firing', { leadId });
  sendSms(smsMessage, 'Jarvis');

  const vapiLead: VapiLead = {
    name: name.trim(),
    phone: phone.trim(),
    project_type: project_type?.trim(),
    budget: budget?.trim(),
    address: address?.trim(),
  };

  try {
    await fireVapiCall(vapiLead);
    db.prepare("UPDATE leads SET called = 1, pipeline = 'contacted' WHERE id = ?").run(leadId);
    logActivity(leadId, 'call', { direction: 'out', body: 'Sofia auto-called this lead' });
    res.json({ success: true, leadId });
  } catch (err) {
    console.error('[Jarvis] Vapi call failed:', err);
    res.json({ success: true, leadId });
  }
});

router.patch('/leads/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }

  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!lead) { res.status(404).json({ error: 'lead not found' }); return; }

  const body = req.body as Partial<LeadBody> & { called?: number; booked?: number };
  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name?.trim() ?? null); }
  if (body.phone !== undefined) { updates.push('phone = ?'); values.push(body.phone?.trim() ?? null); }
  if (body.email !== undefined) { updates.push('email = ?'); values.push(body.email?.trim() ?? null); }
  if (body.address !== undefined) { updates.push('address = ?'); values.push(body.address?.trim() ?? null); }
  if (body.project_type !== undefined) { updates.push('project_type = ?'); values.push(body.project_type?.trim() ?? null); }
  if (body.budget !== undefined) { updates.push('budget = ?'); values.push(body.budget?.trim() ?? null); }
  if (body.timeline !== undefined) { updates.push('timeline = ?'); values.push(body.timeline?.trim() ?? null); }
  if (body.notes !== undefined) { updates.push('notes = ?'); values.push(body.notes?.trim() ?? null); }
  if (body.source !== undefined && (SOURCES as readonly string[]).includes(String(body.source))) {
    updates.push('source = ?'); values.push(body.source);
  }
  if (body.called !== undefined) { updates.push('called = ?'); values.push(body.called ? 1 : 0); }
  if (body.booked !== undefined) { updates.push('booked = ?'); values.push(body.booked ? 1 : 0); }

  // ── Blueprint fields ──
  const b2 = req.body as {
    tier?: string; scope?: Record<string, boolean>; jurisdiction?: string;
    permit_status?: string; build_stage?: string | null; project_value?: number | string;
    referred_by?: string; inspections?: unknown; design_status?: string;
  };
  if (b2.tier !== undefined && (TIERS as readonly string[]).includes(String(b2.tier))) {
    updates.push('tier = ?'); values.push(b2.tier);
  }
  if (b2.scope !== undefined && b2.scope && typeof b2.scope === 'object') {
    updates.push('scope = ?'); values.push(JSON.stringify(b2.scope));
  }
  if (b2.jurisdiction !== undefined) { updates.push('jurisdiction = ?'); values.push(String(b2.jurisdiction).trim() || null); }
  if (b2.referred_by !== undefined) { updates.push('referred_by = ?'); values.push(String(b2.referred_by).trim() || null); }
  if (b2.permit_status !== undefined && (PERMIT_STATUSES as readonly string[]).includes(String(b2.permit_status))) {
    updates.push('permit_status = ?'); values.push(b2.permit_status);
    if (b2.permit_status !== lead.permit_status) {
      logActivity(id, 'note', { direction: 'system', body: `Permit status: ${lead.permit_status || 'none'} → ${b2.permit_status}` });
    }
  }
  if (b2.design_status !== undefined && (DESIGN_STATUSES as readonly string[]).includes(String(b2.design_status))) {
    updates.push('design_status = ?'); values.push(b2.design_status);
  }
  if (b2.project_value !== undefined) {
    const cents = Math.round(Number(String(b2.project_value).replace(/[$,\s]/g, '')) * 100);
    updates.push('project_value_cents = ?'); values.push(Number.isFinite(cents) && cents > 0 ? cents : null);
  }
  if (b2.inspections !== undefined && Array.isArray(b2.inspections)) {
    updates.push('inspections = ?'); values.push(JSON.stringify(b2.inspections));
  }

  // Build-stage moves are the Stage-Gate Trigger: log the move, then fire the
  // billing engine (auto-prepares/sends any milestone invoice that just came
  // due — invoice number, Stripe link, drafted email) and the materials
  // readiness check (flags POs that should precede this stage but aren't
  // ordered). Both run after the row update commits, fire-and-forget.
  if (b2.build_stage !== undefined) {
    const newStage = b2.build_stage === null || b2.build_stage === '' ? null : String(b2.build_stage);
    if (newStage === null || BUILD_STAGES.some((s) => s.key === newStage)) {
      updates.push('build_stage = ?'); values.push(newStage);
      if (newStage && newStage !== lead.build_stage) {
        const label = BUILD_STAGES.find((s) => s.key === newStage)?.label || newStage;
        logActivity(id, 'stage', { direction: 'system', body: `Build stage → ${label}` });
        // Entering construction seeds the default inspection checklist once.
        if (!lead.inspections) { updates.push('inspections = ?'); values.push(JSON.stringify(DEFAULT_INSPECTIONS)); }
        setImmediate(() => {
          triggerStageInvoices(id, newStage).catch((err) => console.error('[Billing] stage trigger failed:', err));
          checkMaterialReadiness(id, newStage);
        });
      }
    }
  }

  // Pipeline stage moves keep the legacy flags in sync and land on the timeline.
  if (body.pipeline !== undefined && (PIPELINE as readonly string[]).includes(String(body.pipeline))) {
    updates.push('pipeline = ?'); values.push(body.pipeline);
    if (body.pipeline !== 'new' && body.pipeline !== 'lost') { updates.push('called = 1'); }
    if (['booked', 'in_progress', 'completed'].includes(String(body.pipeline))) { updates.push('booked = 1'); }
    if (body.pipeline !== lead.pipeline) {
      logActivity(id, 'stage', { direction: 'system', body: `Stage: ${lead.pipeline || 'new'} → ${body.pipeline}` });
    }
  } else {
    // Legacy flag flips still show up on the timeline.
    if (body.called && !lead.called) logActivity(id, 'call', { direction: 'system', body: 'Marked as called' });
    if (body.booked && !lead.booked) logActivity(id, 'stage', { direction: 'system', body: 'Marked as booked' });
  }

  if (updates.length === 0) { res.json({ ok: true }); return; }

  values.push(id);
  db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.delete('/leads/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }

  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) { res.status(404).json({ error: 'lead not found' }); return; }

  db.prepare('DELETE FROM lead_activities WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM lead_payments WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM lead_files WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM lead_subs WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM lead_estimate_items WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── Outreach: text the lead ──
router.post('/leads/:id/sms', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'invalid id' }); return; }
  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as { phone?: string } | undefined;
  if (!lead) { res.status(404).json({ ok: false, error: 'lead not found' }); return; }
  const message = String((req.body || {}).message || '').trim();
  if (!message) { res.status(400).json({ ok: false, error: 'message required' }); return; }
  if (!lead.phone || !lead.phone.trim() || /not provided/i.test(lead.phone)) {
    res.status(400).json({ ok: false, error: 'lead has no phone number' });
    return;
  }
  try {
    await sendSmsTo(lead.phone, message);
    logActivity(id, 'sms', { direction: 'out', body: message });
    db.prepare("UPDATE leads SET called = 1, pipeline = CASE WHEN pipeline = 'new' THEN 'contacted' ELSE pipeline END WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'SMS failed' });
  }
});

// ── Outreach: email the lead (from a connected Gmail account) ──
router.post('/leads/:id/email', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'invalid id' }); return; }
  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as { email?: string } | undefined;
  if (!lead) { res.status(404).json({ ok: false, error: 'lead not found' }); return; }
  const b = (req.body || {}) as { from?: string; subject?: string; body?: string };
  const subject = String(b.subject || '').trim();
  const emailBody = String(b.body || '').trim();
  if (!subject || !emailBody) { res.status(400).json({ ok: false, error: 'subject and body required' }); return; }
  if (!lead.email || !lead.email.trim()) { res.status(400).json({ ok: false, error: 'lead has no email address' }); return; }

  // Pick the sending mailbox: requested one, or the first connected account.
  let from = String(b.from || '').trim();
  if (!from) {
    const first = db.prepare('SELECT email FROM google_accounts ORDER BY id LIMIT 1').get() as { email?: string } | undefined;
    from = first?.email || '';
  }
  if (!from) { res.status(400).json({ ok: false, error: 'no Gmail account connected — connect one in Integrations' }); return; }

  try {
    const sent = await sendNewEmail(from, { to: lead.email, subject, body: emailBody });
    logActivity(id, 'email', { direction: 'out', subject, body: emailBody, meta: { from, gmailId: sent.id } });
    db.prepare("UPDATE leads SET pipeline = CASE WHEN pipeline = 'new' THEN 'contacted' ELSE pipeline END WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'email failed' });
  }
});

// ── Notes on the timeline ──
router.post('/leads/:id/notes', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'invalid id' }); return; }
  const lead = getDb().prepare('SELECT id FROM leads WHERE id = ?').get(id);
  if (!lead) { res.status(404).json({ ok: false, error: 'lead not found' }); return; }
  const note = String((req.body || {}).note || '').trim();
  if (!note) { res.status(400).json({ ok: false, error: 'note required' }); return; }
  logActivity(id, 'note', { direction: 'system', body: note });
  res.json({ ok: true });
});

// ── Payments ──
router.post('/leads/:id/payments', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'invalid id' }); return; }
  const db = getDb();
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
  if (!lead) { res.status(404).json({ ok: false, error: 'lead not found' }); return; }
  const b = (req.body || {}) as { label?: string; amount?: number | string; method?: string; status?: string };
  const amount = Math.round(Number(String(b.amount ?? '').replace(/[$,\s]/g, '')) * 100);
  if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ ok: false, error: 'valid amount required' }); return; }
  const status = b.status === 'pending' ? 'pending' : 'paid';
  const r = db.prepare(`
    INSERT INTO lead_payments (lead_id, label, amount_cents, method, status, paid_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'paid' THEN CURRENT_TIMESTAMP ELSE NULL END)
  `).run(id, String(b.label || 'Payment').trim(), amount, String(b.method || 'other').trim(), status, status);
  logActivity(id, 'payment', {
    direction: 'in',
    body: `${status === 'paid' ? 'Received' : 'Scheduled'}: ${String(b.label || 'Payment').trim()} — $${(amount / 100).toLocaleString()}`,
  });
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

// Real Stripe Checkout link for a payment row — degrades to a clear error if
// STRIPE_SECRET_KEY isn't set (Payments tab falls back to manual entry).
router.post('/leads/:id/payments/:pid/link', async (req: Request, res: Response) => {
  const id = Number(req.params.id), pid = Number(req.params.pid);
  if (!Number.isFinite(id) || !Number.isFinite(pid)) { res.status(400).json({ ok: false, error: 'invalid id' }); return; }
  if (!isStripeConfigured()) { res.status(400).json({ ok: false, error: 'Stripe not connected — add STRIPE_SECRET_KEY in Integrations' }); return; }
  const db = getDb();
  const lead = db.prepare('SELECT name FROM leads WHERE id = ?').get(id) as { name?: string } | undefined;
  if (!lead) { res.status(404).json({ ok: false, error: 'lead not found' }); return; }
  const payment = db.prepare('SELECT * FROM lead_payments WHERE id = ? AND lead_id = ?').get(pid, id) as { label?: string; amount_cents?: number } | undefined;
  if (!payment) { res.status(404).json({ ok: false, error: 'payment not found' }); return; }
  try {
    const session = await createPaymentLink({
      leadId: id, paymentId: pid,
      label: payment.label || 'Payment', amountCents: payment.amount_cents || 0,
      customerName: lead.name,
    });
    db.prepare('UPDATE lead_payments SET stripe_session_id = ?, payment_url = ? WHERE id = ?').run(session.id, session.url, pid);
    logActivity(id, 'note', { direction: 'system', body: `Payment link created for ${payment.label} — $${((payment.amount_cents || 0) / 100).toLocaleString()}` });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Stripe request failed' });
  }
});

router.post('/leads/:id/payments/:pid/toggle', (req: Request, res: Response) => {
  const id = Number(req.params.id), pid = Number(req.params.pid);
  const db = getDb();
  const p = db.prepare('SELECT * FROM lead_payments WHERE id = ? AND lead_id = ?').get(pid, id) as { status?: string } | undefined;
  if (!p) { res.status(404).json({ ok: false, error: 'payment not found' }); return; }
  const next = p.status === 'paid' ? 'pending' : 'paid';
  db.prepare("UPDATE lead_payments SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?").run(next, next, pid);
  res.json({ ok: true, status: next });
});

router.delete('/leads/:id/payments/:pid', (req: Request, res: Response) => {
  const id = Number(req.params.id), pid = Number(req.params.pid);
  getDb().prepare('DELETE FROM lead_payments WHERE id = ? AND lead_id = ?').run(pid, id);
  res.json({ ok: true });
});

// ── Milestones: generate Joe's 10/25/30/30/5 schedule from the project value ──
router.post('/leads/:id/milestones/generate', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'invalid id' }); return; }
  const db = getDb();
  const lead = db.prepare('SELECT id, project_value_cents FROM leads WHERE id = ?').get(id) as { id: number; project_value_cents: number | null } | undefined;
  if (!lead) { res.status(404).json({ ok: false, error: 'lead not found' }); return; }
  const total = lead.project_value_cents || 0;
  if (total <= 0) { res.status(400).json({ ok: false, error: 'set a project value first' }); return; }
  const existing = db.prepare('SELECT label FROM lead_payments WHERE lead_id = ?').all(id) as { label: string }[];
  const have = new Set(existing.map((e) => e.label));
  let created = 0;
  let allocated = 0;
  for (let i = 0; i < MILESTONES.length; i++) {
    const m = MILESTONES[i];
    // Last milestone takes the remainder so rounding never loses a cent.
    const amount = i === MILESTONES.length - 1 ? total - allocated : Math.round(total * (m.pct / 100));
    allocated += amount;
    if (have.has(m.label)) continue; // idempotent — regenerate never duplicates
    db.prepare(`
      INSERT INTO lead_payments (lead_id, label, amount_cents, method, status, paid_at)
      VALUES (?, ?, ?, 'other', 'pending', NULL)
    `).run(id, m.label, amount);
    created++;
  }
  if (created) {
    logActivity(id, 'payment', { direction: 'system', body: `Milestone schedule generated (10/25/30/30/5 of $${(total / 100).toLocaleString()}) — ${created} draw(s) added` });
  }
  res.json({ ok: true, created });
});

// ── Digital Project Vault: files & photos per lead ──
const FILE_KINDS = ['inspiration', 'design', 'contract', 'permit', 'field'];
router.post('/leads/:id/files', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'invalid id' }); return; }
  const db = getDb();
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
  if (!lead) { res.status(404).json({ ok: false, error: 'lead not found' }); return; }
  const b = (req.body || {}) as { kind?: string; name?: string; mime?: string; data?: string };
  const data = String(b.data || '');
  if (!data) { res.status(400).json({ ok: false, error: 'file data required' }); return; }
  if (data.length > 8_000_000) { res.status(400).json({ ok: false, error: 'file too large (max ~6MB)' }); return; }
  const kind = FILE_KINDS.includes(String(b.kind)) ? String(b.kind) : 'field';
  const r = db.prepare('INSERT INTO lead_files (lead_id, kind, name, mime, data) VALUES (?, ?, ?, ?, ?)')
    .run(id, kind, String(b.name || 'file').slice(0, 200), String(b.mime || 'application/octet-stream'), data);
  logActivity(id, 'note', { direction: 'system', body: `File added to vault (${kind}): ${b.name || 'file'}` });
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.get('/crm/files/:fid', (req: Request, res: Response) => {
  const fid = Number(req.params.fid);
  const row = getDb().prepare('SELECT mime, name, data FROM lead_files WHERE id = ?').get(fid) as { mime: string; name: string; data: string } | undefined;
  if (!row) { res.status(404).end(); return; }
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(row.name || 'file').replace(/[^\w.\- ]/g, '_')}"`);
  res.send(Buffer.from(row.data, 'base64'));
});

router.delete('/leads/:id/files/:fid', (req: Request, res: Response) => {
  const id = Number(req.params.id), fid = Number(req.params.fid);
  getDb().prepare('DELETE FROM lead_files WHERE id = ? AND lead_id = ?').run(fid, id);
  res.json({ ok: true });
});

// ── Subcontractors: address book + per-project stage assignments ──
router.get('/crm/subs', (_req: Request, res: Response) => {
  res.json({ subs: getDb().prepare('SELECT * FROM subs ORDER BY trade, name').all(), trades: SUB_TRADES });
});

router.post('/crm/subs', (req: Request, res: Response) => {
  const b = (req.body || {}) as { name?: string; trade?: string; phone?: string };
  if (!b.name || !String(b.name).trim()) { res.status(400).json({ ok: false, error: 'name required' }); return; }
  const trade = (SUB_TRADES as readonly string[]).includes(String(b.trade)) ? String(b.trade) : 'other';
  const r = getDb().prepare('INSERT INTO subs (name, trade, phone) VALUES (?, ?, ?)')
    .run(String(b.name).trim(), trade, String(b.phone || '').trim() || null);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.delete('/crm/subs/:sid', (req: Request, res: Response) => {
  const sid = Number(req.params.sid);
  getDb().prepare('DELETE FROM lead_subs WHERE sub_id = ?').run(sid);
  getDb().prepare('DELETE FROM subs WHERE id = ?').run(sid);
  res.json({ ok: true });
});

router.post('/leads/:id/subs', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const b = (req.body || {}) as { sub_id?: number; stage?: string; scheduled_for?: string };
  const db = getDb();
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
  const sub = db.prepare('SELECT id, name FROM subs WHERE id = ?').get(Number(b.sub_id)) as { id: number; name: string } | undefined;
  if (!lead || !sub) { res.status(404).json({ ok: false, error: 'lead or sub not found' }); return; }
  const stage = BUILD_STAGES.some((s) => s.key === String(b.stage)) ? String(b.stage) : null;
  const r = db.prepare('INSERT INTO lead_subs (lead_id, sub_id, stage, scheduled_for) VALUES (?, ?, ?, ?)')
    .run(id, sub.id, stage, String(b.scheduled_for || '').trim() || null);
  logActivity(id, 'note', { direction: 'system', body: `${sub.name} assigned to ${stage || 'project'}${b.scheduled_for ? ` for ${b.scheduled_for}` : ''}` });
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

// Send the schedule-confirmation text to a sub (manual trigger — Joe taps it).
router.post('/leads/:id/subs/:aid/notify', async (req: Request, res: Response) => {
  const id = Number(req.params.id), aid = Number(req.params.aid);
  const db = getDb();
  const row = db.prepare(`
    SELECT ls.id, ls.stage, ls.scheduled_for, s.name AS sub_name, s.phone, l.name AS lead_name, l.address
    FROM lead_subs ls JOIN subs s ON s.id = ls.sub_id JOIN leads l ON l.id = ls.lead_id
    WHERE ls.id = ? AND ls.lead_id = ?
  `).get(aid, id) as { id: number; stage: string | null; scheduled_for: string | null; sub_name: string; phone: string | null; lead_name: string; address: string | null } | undefined;
  if (!row) { res.status(404).json({ ok: false, error: 'assignment not found' }); return; }
  if (!row.phone) { res.status(400).json({ ok: false, error: `${row.sub_name} has no phone on file` }); return; }
  const stageLabel = BUILD_STAGES.find((s) => s.key === row.stage)?.label || 'work';
  const msg = `Hi ${row.sub_name}, Totally Outdoors LLC has you scheduled for ${stageLabel} at the ${row.lead_name} project${row.address ? ` (${row.address})` : ''}${row.scheduled_for ? ` on ${row.scheduled_for}` : ''}. Reply YES to confirm or call Joe to reschedule.`;
  try {
    await sendSmsTo(row.phone, msg, 'CRM subs');
    db.prepare("UPDATE lead_subs SET status = 'notified' WHERE id = ?").run(aid);
    logActivity(id, 'sms', { direction: 'out', body: `To ${row.sub_name} (sub): ${msg}` });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'SMS failed' });
  }
});

// Mark a sub's schedule confirmed (their YES comes back on Joe's phone —
// inbound SMS isn't wired into the app, so confirmation is recorded here).
router.post('/leads/:id/subs/:aid/confirm', (req: Request, res: Response) => {
  const id = Number(req.params.id), aid = Number(req.params.aid);
  const db = getDb();
  db.prepare("UPDATE lead_subs SET status = 'confirmed' WHERE id = ? AND lead_id = ?").run(aid, id);
  const row = db.prepare('SELECT s.name FROM lead_subs ls JOIN subs s ON s.id = ls.sub_id WHERE ls.id = ?').get(aid) as { name: string } | undefined;
  if (row) logActivity(id, 'note', { direction: 'in', body: `${row.name} confirmed their schedule` });
  res.json({ ok: true });
});

router.delete('/leads/:id/subs/:aid', (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM lead_subs WHERE id = ? AND lead_id = ?').run(Number(req.params.aid), Number(req.params.id));
  res.json({ ok: true });
});

// ── Estimator: JobTread-style line items that roll up to the project value ──
router.post('/leads/:id/estimate', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getDb();
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
  if (!lead) { res.status(404).json({ ok: false, error: 'lead not found' }); return; }
  const b = (req.body || {}) as { label?: string; qty?: number | string; unit?: string; unit_cost?: number | string; markup_pct?: number | string };
  const label = String(b.label || '').trim();
  if (!label) { res.status(400).json({ ok: false, error: 'label required' }); return; }
  const qty = Number(b.qty) > 0 ? Number(b.qty) : 1;
  const unitCost = Math.round(Number(String(b.unit_cost ?? '0').replace(/[$,\s]/g, '')) * 100);
  const markup = Number(b.markup_pct) >= 0 ? Number(b.markup_pct) : 0;
  if (!Number.isFinite(unitCost) || unitCost < 0) { res.status(400).json({ ok: false, error: 'valid unit cost required' }); return; }
  const r = db.prepare('INSERT INTO lead_estimate_items (lead_id, label, qty, unit, unit_cost_cents, markup_pct) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, label, qty, String(b.unit || '').trim() || null, unitCost, markup);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.delete('/leads/:id/estimate/:eid', (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM lead_estimate_items WHERE id = ? AND lead_id = ?').run(Number(req.params.eid), Number(req.params.id));
  res.json({ ok: true });
});

// ── Other calls: the non-prospect bucket (vendors, clients, spam, misdials) ──
router.get('/crm/other-calls', (_req: Request, res: Response) => {
  const db = getDb();
  const calls = db.prepare('SELECT * FROM other_calls ORDER BY created_at DESC, id DESC LIMIT 100').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) AS count FROM other_calls GROUP BY category ORDER BY count DESC').all();
  res.json({ calls, byCategory });
});

// Wrongly filed? One tap turns an other_call back into a real lead.
router.post('/crm/other-calls/:cid/promote', async (req: Request, res: Response) => {
  const cid = Number(req.params.cid);
  const db = getDb();
  const row = db.prepare('SELECT * FROM other_calls WHERE id = ?').get(cid) as { name?: string; phone?: string; message?: string } | undefined;
  if (!row) { res.status(404).json({ ok: false, error: 'call not found' }); return; }
  try {
    const { leadId, merged } = await createLead({
      name: row.name || 'Unknown', phone: row.phone || 'Unknown',
      message: row.message || undefined, source: 'sofia',
    });
    db.prepare('DELETE FROM other_calls WHERE id = ?').run(cid);
    res.json({ ok: true, leadId, merged });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'promote failed' });
  }
});

router.delete('/crm/other-calls/:cid', (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM other_calls WHERE id = ?').run(Number(req.params.cid));
  res.json({ ok: true });
});

// Manual junk sweep (also runs once automatically at boot).
router.post('/crm/cleanup', async (_req: Request, res: Response) => {
  try {
    const { cleanupJunkLeads } = await import('../services/crmCleanup');
    res.json({ ok: true, ...(await cleanupJunkLeads()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'cleanup failed' });
  }
});

// ── Map view: pins for active builds + leads. Sofia rarely captures a street
// address, so leads with only a city (from the jurisdiction field or her
// "City: X" call note) get an approximate city-center pin instead of nothing.
const JUNK_CITY = /^(unknown|not provided|n\/a|none|null|-*)$/i;

function mapCityFor(lead: { jurisdiction?: string | null; message?: string | null }): string | null {
  const j = (lead.jurisdiction || '').trim();
  if (j && !JUNK_CITY.test(j)) return j;
  const m = /City:\s*([^|]+)\s*$/i.exec(lead.message || '');
  const city = (m?.[1] || '').trim();
  return city && !JUNK_CITY.test(city) ? city : null;
}

router.get('/crm/map', async (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, address, jurisdiction, message, build_stage, pipeline, project_value_cents, lat, lng, geocoded_addr
    FROM leads
    WHERE pipeline != 'lost'
    ORDER BY (build_stage IS NULL), created_at DESC
    LIMIT 80
  `).all() as { id: number; name: string; address: string | null; jurisdiction: string | null; message: string | null; build_stage: string | null; pipeline: string; project_value_cents: number | null; lat: number | null; lng: number | null; geocoded_addr: string | null }[];

  // Effective location per lead: real street address, else city-center (approx).
  const withLoc = rows.map((r) => {
    const realAddr = (r.address || '').trim();
    const hasAddr = !!realAddr && !/not provided|unknown/i.test(realAddr);
    const city = hasAddr ? null : mapCityFor(r);
    return { ...r, effAddress: hasAddr ? realAddr : (city ? `${city}` : null), approx: !hasAddr && !!city };
  }).filter((r) => r.effAddress);

  const { geocodeMissing } = await import('../services/geocode');
  await geocodeMissing(withLoc.map((r) => ({ id: r.id, address: r.effAddress, lat: r.lat, lng: r.lng, geocoded_addr: r.geocoded_addr })));

  // Re-read the coordinates that may have just been cached.
  const fresh = withLoc.length ? db.prepare(`
    SELECT id, lat, lng FROM leads WHERE id IN (${withLoc.map(() => '?').join(',')})
  `).all(...withLoc.map((r) => r.id)) as { id: number; lat: number | null; lng: number | null }[] : [];
  const coords = new Map(fresh.map((f) => [f.id, f]));

  const pins = withLoc
    .map((r) => ({ ...r, lat: coords.get(r.id)?.lat ?? null, lng: coords.get(r.id)?.lng ?? null }))
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({
      id: r.id, name: r.name, address: r.approx ? `${r.effAddress} (city only)` : r.address,
      // Approximate pins get a small deterministic offset so several leads in
      // the same city don't stack into one invisible pile at the city center.
      lat: r.approx ? (r.lat as number) + (((r.id * 7) % 21) - 10) * 0.0012 : r.lat,
      lng: r.approx ? (r.lng as number) + (((r.id * 13) % 21) - 10) * 0.0012 : r.lng,
      approx: r.approx,
      buildStage: r.build_stage,
      stageLabel: BUILD_STAGES.find((s) => s.key === r.build_stage)?.label || null,
      pipeline: r.pipeline, valueCents: r.project_value_cents || 0,
    }));
  const pending = withLoc.filter((r) => coords.get(r.id)?.lat == null).length;
  res.json({ pins, pending });
});

// Apply the estimate total (with markups) as the project value, ready for
// milestone generation.
router.post('/leads/:id/estimate/apply', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getDb();
  const items = db.prepare('SELECT qty, unit_cost_cents, markup_pct FROM lead_estimate_items WHERE lead_id = ?').all(id) as { qty: number; unit_cost_cents: number; markup_pct: number }[];
  if (!items.length) { res.status(400).json({ ok: false, error: 'no estimate items yet' }); return; }
  const total = items.reduce((sum, it) => sum + Math.round(it.qty * it.unit_cost_cents * (1 + (it.markup_pct || 0) / 100)), 0);
  db.prepare('UPDATE leads SET project_value_cents = ? WHERE id = ?').run(total, id);
  logActivity(id, 'note', { direction: 'system', body: `Estimate applied as project value: $${(total / 100).toLocaleString()}` });
  res.json({ ok: true, total_cents: total });
});

// ── Supply chain: suppliers + purchase orders ───────────────────────────────

router.get('/suppliers', (_req: Request, res: Response) => {
  res.json({ suppliers: listSuppliers(), categories: SUPPLIER_CATEGORIES });
});

router.post('/suppliers', (req: Request, res: Response) => {
  const b = req.body as { name?: string; category?: string; contact_name?: string; phone?: string; email?: string; notes?: string };
  if (!b.name?.trim()) { res.status(400).json({ ok: false, error: 'name required' }); return; }
  const id = addSupplier({ name: b.name, category: b.category, contact_name: b.contact_name, phone: b.phone, email: b.email, notes: b.notes });
  res.json({ ok: true, id });
});

router.get('/materials/orders', (req: Request, res: Response) => {
  const leadId = req.query.lead_id ? Number(req.query.lead_id) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;
  const openOnly = req.query.open === '1';
  res.json({ orders: listOrders({ leadId, status, openOnly }) });
});

router.post('/leads/:id/materials', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'invalid id' }); return; }
  const b = req.body as {
    items?: { label: string; qty?: number; unit?: string; unit_price_cents?: number }[];
    from_estimate?: boolean; supplier_id?: number; needed_by?: string; needed_by_stage?: string; notes?: string;
  };
  try {
    const result = createOrder({
      leadId: id,
      supplierId: b.supplier_id ?? null,
      items: (b.items || []).map((it) => ({ label: it.label, qty: it.qty || 1, unit: it.unit || null, unit_price_cents: it.unit_price_cents || 0 })),
      fromEstimate: !!b.from_estimate,
      neededBy: b.needed_by ?? null,
      neededByStage: b.needed_by_stage ?? null,
      notes: b.notes ?? null,
    });
    res.json({ ok: true, ...result, order: getOrder(result.orderId) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'order failed' });
  }
});

router.patch('/materials/orders/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const status = String((req.body as { status?: string })?.status || '');
  const result = updateOrderStatus(id, status);
  if (!result.ok) { res.status(400).json(result); return; }
  res.json({ ok: true, order: getOrder(id) });
});

router.post('/materials/orders/:id/send', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await sendPurchaseOrder(id).catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : 'send failed' }));
  res.status(result.ok ? 200 : 400).json(result);
});

router.get('/materials/prices', (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) { res.status(400).json({ ok: false, error: 'q required' }); return; }
  res.json({ history: priceHistory(q) });
});

// ── Milestone invoicing ─────────────────────────────────────────────────────

router.get('/invoices/outstanding', (_req: Request, res: Response) => {
  res.json({ invoices: listOutstandingInvoices() });
});

router.post('/leads/:id/payments/:pid/send-invoice', async (req: Request, res: Response) => {
  const pid = Number(req.params.pid);
  const result = await sendMilestoneInvoice(pid).catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : 'send failed' }));
  res.status(result.ok ? 200 : 400).json(result);
});

export default router;
