/**
 * Single, shared "a lead just arrived" pipeline — used by every lead-creation
 * site (the manual/website POST /leads route AND the phone line's Vapi webhook) so
 * dedupe-by-phone and the automated confirmation only have to be right once.
 *
 * GHL-style intake automation: the moment a lead lands, they get an automatic
 * SMS + email confirmation (best-effort — silently skipped, never thrown, if
 * there's no phone/email or the relevant integration isn't connected).
 */

import { getDb } from '../db/schema';
import { findLeadByPhone } from './leadDedupe';
import { logActivity } from './leadShared';
import { sendSms } from './sms';
import { sendNewEmail } from './google/gmail';

export interface LeadIntakeInput {
  name: string;
  phone: string;
  email?: string;
  address?: string;
  project_type?: string;
  budget?: string;
  timeline?: string;
  notes?: string;
  message?: string;
  source: string;
}

export interface LeadIntakeResult {
  leadId: number;
  merged: boolean;
}

const CONFIRMATION_SUBJECT = 'Thanks for reaching out to Totally Outdoors LLC';

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

function confirmationEmailBody(name: string): string {
  return `Hi ${firstName(name)},\n\n` +
    `Thanks for reaching out to Totally Outdoors LLC! We've received your information and someone from our team will be in touch shortly to talk through your project.\n\n` +
    `If you'd like to get a head start, feel free to reply to this email with photos of your yard or any questions you have.\n\n` +
    `Talk soon,\nTotally Outdoors LLC`;
}

function looksReal(v: string | null | undefined): boolean {
  return !!v && !!v.trim() && !/not provided|unknown/i.test(v.trim());
}

/** Best-effort SMS + email confirmation to the lead. Never throws — logged and skipped on failure. */
async function sendConfirmation(leadId: number, name: string, email: string | undefined, phone: string): Promise<void> {
  const db = getDb();

  if (looksReal(email)) {
    const account = db.prepare('SELECT email FROM google_accounts ORDER BY id LIMIT 1').get() as { email?: string } | undefined;
    if (account?.email) {
      try {
        await sendNewEmail(account.email, { to: email!.trim(), subject: CONFIRMATION_SUBJECT, body: confirmationEmailBody(name) });
        logActivity(leadId, 'email', { direction: 'out', subject: CONFIRMATION_SUBJECT, body: confirmationEmailBody(name), meta: { from: account.email, automated: true } });
      } catch (err) {
        console.error('[CRM] confirmation email failed:', err instanceof Error ? err.message : err);
      }
    } else {
      console.log('[CRM] skipping confirmation email — no Gmail account connected');
    }
  }

  // SMS confirmation is manual-only (Joe sends it himself from the CRM drawer) —
  // just flag it on the timeline so nothing gets silently missed.
  if (looksReal(phone)) {
    logActivity(leadId, 'note', { direction: 'system', body: 'Confirmation text not sent automatically — send from the CRM when ready.' });
  }

  try {
    db.prepare('UPDATE leads SET confirmation_sent_at = CURRENT_TIMESTAMP WHERE id = ?').run(leadId);
  } catch (err) {
    console.error('[CRM] stamping confirmation_sent_at failed:', err);
  }
}

/** Create a lead (or merge into an existing one by phone) and fire the confirmation. */
export async function createLead(input: LeadIntakeInput): Promise<LeadIntakeResult> {
  const db = getDb();
  const name = input.name.trim();
  const phone = input.phone.trim();
  const source = input.source;

  const existingId = findLeadByPhone(phone);
  if (existingId) {
    const patch: Record<string, string> = {};
    const existing = db.prepare('SELECT * FROM leads WHERE id = ?').get(existingId) as Record<string, string | null>;
    const fill = (col: string, val?: string) => {
      const cur = existing[col];
      if (val && val.trim() && (!cur || !String(cur).trim() || /^(sofia|not provided|unknown)$/i.test(String(cur).trim()))) {
        patch[col] = val.trim();
      }
    };
    fill('name', name); fill('email', input.email); fill('address', input.address);
    fill('project_type', input.project_type); fill('budget', input.budget); fill('timeline', input.timeline);
    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE leads SET ${sets} WHERE id = ?`).run(...Object.values(patch), existingId);
    }
    logActivity(existingId, 'note', { direction: 'in', body: `Reached out again via ${source}${input.message?.trim() ? `: ${input.message.trim()}` : ''}` });
    if (source !== 'manual') {
      sendSms(`Repeat lead (already in CRM):\nName: ${name}\nPhone: ${phone}`, 'Jarvis');
    }
    return { leadId: existingId, merged: true };
  }

  const result = db.prepare(`
    INSERT INTO leads (name, phone, email, address, project_type, budget, timeline, source, notes, message, pipeline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
  `).run(
    name, phone,
    input.email?.trim() ?? null, input.address?.trim() ?? null,
    input.project_type?.trim() ?? null, input.budget?.trim() ?? null, input.timeline?.trim() ?? null,
    source, input.notes?.trim() ?? null, input.message?.trim() ?? null,
  );

  const leadId = Number(result.lastInsertRowid);
  logActivity(leadId, 'stage', { direction: 'system', body: `Lead created (source: ${source})` });

  await sendConfirmation(leadId, name, input.email, phone);

  return { leadId, merged: false };
}
