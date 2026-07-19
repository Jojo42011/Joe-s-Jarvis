/**
 * Milestone billing — Totally Outdoors' cash-flow engine.
 *
 * The flow: a project gets a value → the 50/50 milestone schedule exists
 * (auto-ensured, idempotent) → when a build-stage move makes a milestone come
 * due, this module immediately prepares the invoice: sequential invoice
 * number, Stripe payment link (when configured), and a polished customer
 * email. By default the email waits for Joe's approval (CRM button or telling
 * Jarvis "send it"); set INVOICE_AUTO_SEND=1 to send the moment it comes due.
 *
 * The email is a deterministic template, not LLM output — amounts, links, and
 * payment terms are compliance-sensitive, and the platform's rule is a
 * deterministic guardrail around anything money-shaped.
 */

import { getDb } from '../db/schema';
import { MILESTONES, BUILD_STAGES, buildStageIndex, logActivity } from './leadShared';
import { createPaymentLink, isStripeConfigured } from './stripe';
import { sendNewEmail } from './google/gmail';
import { GOOGLE_ACCOUNTS } from '../config/google';
import { anyGoogleAccountConnected } from '../db/google';
import { sendSms } from './sms';
import { getSystemState, setSystemState } from '../db/queries';

const AUTO_SEND = process.env.INVOICE_AUTO_SEND === '1';

const COMPANY = {
  name: 'Totally Outdoors LLC',
  phone: '330-231-4080',
  email: 'totallyoutdoors@gmail.com',
  address: '2855 State Route 83, Millersburg, OH 44654',
};

interface LeadRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  project_value_cents: number | null;
  build_stage: string | null;
}

interface PaymentRow {
  id: number;
  lead_id: number;
  label: string | null;
  amount_cents: number;
  status: string | null;
  invoice_no: string | null;
  invoice_sent_at: string | null;
  invoice_draft: string | null;
  payment_url: string | null;
  stripe_session_id: string | null;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Sequential invoice numbers: TO-<year>-<seq>, counter kept in system_state. */
export function nextInvoiceNumber(): string {
  const year = new Date().getFullYear();
  const key = `invoice_seq_${year}`;
  const current = parseInt(getSystemState(key) || '0', 10) + 1;
  setSystemState(key, String(current));
  return `TO-${year}-${String(current).padStart(3, '0')}`;
}

/**
 * Make sure the milestone payment rows exist for a lead with a project value.
 * Idempotent — matches the manual "Generate 50/50 schedule" endpoint exactly
 * (last milestone takes the rounding remainder), never duplicates by label.
 */
export function ensureMilestoneSchedule(leadId: number): { created: number } {
  const db = getDb();
  const lead = db.prepare('SELECT id, project_value_cents FROM leads WHERE id = ?').get(leadId) as
    | { id: number; project_value_cents: number | null } | undefined;
  const total = lead?.project_value_cents || 0;
  if (!lead || total <= 0) return { created: 0 };

  const existing = db.prepare('SELECT label FROM lead_payments WHERE lead_id = ?').all(leadId) as { label: string }[];
  const have = new Set(existing.map((e) => e.label));
  let created = 0;
  let allocated = 0;
  for (let i = 0; i < MILESTONES.length; i++) {
    const m = MILESTONES[i];
    const amount = i === MILESTONES.length - 1 ? total - allocated : Math.round(total * (m.pct / 100));
    allocated += amount;
    if (have.has(m.label)) continue;
    db.prepare(`
      INSERT INTO lead_payments (lead_id, label, amount_cents, method, status, paid_at)
      VALUES (?, ?, ?, 'other', 'pending', NULL)
    `).run(leadId, m.label, amount);
    created++;
  }
  if (created) logActivity(leadId, 'note', { direction: 'system', body: `Milestone schedule generated (${created} payment(s))` });
  return { created };
}

/** The polished customer-facing invoice email. Deterministic on purpose. */
export function buildInvoiceEmail(lead: LeadRow, payment: PaymentRow, payUrl: string | null): { subject: string; body: string } {
  const first = (lead.name || '').trim().split(/\s+/)[0] || 'there';
  const stageLabel = BUILD_STAGES.find((s) => s.key === lead.build_stage)?.label || 'your project';
  const subject = `Invoice ${payment.invoice_no} — ${payment.label} — ${COMPANY.name}`;
  const lines = [
    `Hi ${first},`,
    '',
    `Great progress on your project — we've reached the ${stageLabel} milestone, which means your ${payment.label?.toLowerCase() || 'payment'} of ${money(payment.amount_cents)} is now due.`,
    '',
    `Invoice number: ${payment.invoice_no}`,
    `Amount due: ${money(payment.amount_cents)}`,
    ...(payUrl
      ? ['', `You can pay securely online here:`, payUrl]
      : ['', `We accept check, cash, or card — just reply to this email or call the office and we'll take care of it.`]),
    '',
    `Questions about this invoice or the work? Call us anytime at ${COMPANY.phone} — we're happy to walk through it.`,
    '',
    `Thank you for trusting us with your outdoor space.`,
    '',
    COMPANY.name,
    COMPANY.address,
    COMPANY.phone,
  ];
  return { subject, body: lines.join('\n') };
}

/** Prepare one pending milestone: invoice number + Stripe link + drafted email. */
async function prepareInvoice(lead: LeadRow, payment: PaymentRow): Promise<PaymentRow> {
  const db = getDb();

  if (!payment.invoice_no) {
    payment.invoice_no = nextInvoiceNumber();
    db.prepare('UPDATE lead_payments SET invoice_no = ? WHERE id = ?').run(payment.invoice_no, payment.id);
  }

  if (!payment.payment_url && isStripeConfigured()) {
    try {
      const session = await createPaymentLink({
        leadId: lead.id,
        paymentId: payment.id,
        label: `${payment.label} — ${lead.name}`,
        amountCents: payment.amount_cents,
      });
      payment.stripe_session_id = session.id;
      payment.payment_url = session.url;
      db.prepare('UPDATE lead_payments SET stripe_session_id = ?, payment_url = ? WHERE id = ?')
        .run(session.id, session.url, payment.id);
    } catch (err) {
      console.error('[Billing] Stripe link failed (invoice continues without it):', err instanceof Error ? err.message : err);
    }
  }

  const email = buildInvoiceEmail(lead, payment, payment.payment_url);
  payment.invoice_draft = `Subject: ${email.subject}\n\n${email.body}`;
  db.prepare('UPDATE lead_payments SET invoice_draft = ? WHERE id = ?').run(payment.invoice_draft, payment.id);
  return payment;
}

/** Send a prepared milestone invoice to the customer by email. */
export async function sendMilestoneInvoice(paymentId: number): Promise<{ ok: boolean; error?: string; to?: string; invoice_no?: string }> {
  const db = getDb();
  const payment = db.prepare('SELECT * FROM lead_payments WHERE id = ?').get(paymentId) as PaymentRow | undefined;
  if (!payment) return { ok: false, error: `No payment #${paymentId}` };
  if (payment.status === 'paid') return { ok: false, error: 'Already paid — nothing to invoice' };
  const lead = db.prepare('SELECT id, name, email, phone, project_value_cents, build_stage FROM leads WHERE id = ?')
    .get(payment.lead_id) as LeadRow | undefined;
  if (!lead) return { ok: false, error: 'Lead not found' };
  if (!lead.email?.trim()) return { ok: false, error: `${lead.name} has no email on file — add one to the lead first` };
  if (!anyGoogleAccountConnected()) return { ok: false, error: 'Gmail is not connected — connect it in Integrations first' };

  const prepared = await prepareInvoice(lead, payment);
  const email = buildInvoiceEmail(lead, prepared, prepared.payment_url);
  const from = GOOGLE_ACCOUNTS[0]?.email;
  if (!from) return { ok: false, error: 'No sending mailbox configured' };

  await sendNewEmail(from, { to: lead.email.trim(), subject: email.subject, body: email.body });
  db.prepare('UPDATE lead_payments SET invoice_sent_at = CURRENT_TIMESTAMP WHERE id = ?').run(paymentId);
  logActivity(lead.id, 'email', {
    direction: 'out',
    subject: email.subject,
    body: email.body,
    meta: { invoice_no: prepared.invoice_no, payment_id: paymentId, automated: true },
  });
  return { ok: true, to: lead.email.trim(), invoice_no: prepared.invoice_no || undefined };
}

/**
 * The stage-gate billing trigger. Called whenever a lead's build stage moves.
 * Ensures the schedule exists, prepares every milestone that is now due and
 * still pending, and either auto-sends (INVOICE_AUTO_SEND=1) or parks the
 * drafted invoice for Joe's approval and texts him.
 */
export async function triggerStageInvoices(leadId: number, newStageKey: string): Promise<void> {
  try {
    const db = getDb();
    const lead = db.prepare('SELECT id, name, email, phone, project_value_cents, build_stage FROM leads WHERE id = ?')
      .get(leadId) as LeadRow | undefined;
    if (!lead) return;

    ensureMilestoneSchedule(leadId);

    const stageIdx = buildStageIndex(newStageKey);
    const pending = db.prepare("SELECT * FROM lead_payments WHERE lead_id = ? AND status = 'pending'").all(leadId) as PaymentRow[];
    const due = MILESTONES
      .filter((m) => buildStageIndex(m.dueAtStage) <= stageIdx)
      .map((m) => pending.find((p) => p.label === m.label))
      .filter((p): p is PaymentRow => !!p);

    for (const payment of due) {
      const prepared = await prepareInvoice({ ...lead, build_stage: newStageKey }, payment);

      if (AUTO_SEND && lead.email?.trim() && anyGoogleAccountConnected()) {
        const sent = await sendMilestoneInvoice(prepared.id);
        if (sent.ok) {
          sendSms(`💵 Invoice ${sent.invoice_no} (${payment.label}, ${money(payment.amount_cents)}) auto-sent to ${lead.name}.`, 'Billing');
          continue;
        }
        console.error('[Billing] auto-send failed, falling back to draft:', sent.error);
      }

      const linkNote = prepared.payment_url ? ` Pay link ready: ${prepared.payment_url}` : '';
      sendSms(
        `💵 ${lead.name} hit ${BUILD_STAGES.find((s) => s.key === newStageKey)?.label || newStageKey} — invoice ${prepared.invoice_no} (${payment.label}, ${money(payment.amount_cents)}) is drafted and ready to send.${linkNote}`,
        'Billing'
      );
      logActivity(leadId, 'note', {
        direction: 'system',
        body: `Invoice ${prepared.invoice_no} drafted for ${payment.label} (${money(payment.amount_cents)}) — awaiting send approval.`,
      });
    }
  } catch (err) {
    console.error('[Billing] stage trigger error:', err instanceof Error ? err.message : err);
  }
}

export interface OutstandingInvoice {
  payment_id: number; lead_id: number; lead_name: string; label: string | null;
  amount_cents: number; invoice_no: string | null; invoice_sent_at: string | null; payment_url: string | null;
}

/** Outstanding (pending) milestone invoices across all projects — Jarvis's view. */
export function listOutstandingInvoices(): OutstandingInvoice[] {
  return getDb().prepare(`
    SELECT p.id AS payment_id, p.lead_id, l.name AS lead_name, p.label, p.amount_cents,
           p.invoice_no, p.invoice_sent_at, p.payment_url
    FROM lead_payments p JOIN leads l ON l.id = p.lead_id
    WHERE p.status = 'pending'
    ORDER BY p.created_at ASC
  `).all() as OutstandingInvoice[];
}
