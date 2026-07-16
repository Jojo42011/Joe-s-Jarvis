/**
 * Automated follow-up sequence — GHL-style "nudge cold leads" automation.
 * Any lead stuck in 'new' or 'contacted' with no activity in 48h gets one
 * automatic SMS check-in, capped at 2 per lead so it never reads as spam.
 * Runs hourly; re-reads the DB each tick rather than trusting a long timer.
 */

import { getDb } from '../db/schema';
import { sendSmsTo } from './sms';
import { logActivity } from './leadShared';

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const MAX_AUTO_FOLLOW_UPS = 2;

interface StaleLead {
  id: number;
  name: string;
  phone: string;
  pipeline: string;
  created_at: string;
  last_follow_up_at: string | null;
  follow_up_count: number;
}

function followUpMessage(name: string): string {
  const first = name.trim().split(/\s+/)[0] || name.trim();
  return `Hi ${first}, just checking in from Totally Outdoors LLC — still want to talk through your pool project? Reply here or call us anytime.`;
}

function isDue(lead: StaleLead): boolean {
  if (lead.follow_up_count >= MAX_AUTO_FOLLOW_UPS) return false;
  const anchor = lead.last_follow_up_at || lead.created_at;
  const last = new Date(anchor.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - last >= STALE_AFTER_MS;
}

export async function runLeadFollowUps(): Promise<{ sent: number }> {
  const db = getDb();
  const candidates = db.prepare(`
    SELECT id, name, phone, pipeline, created_at, last_follow_up_at, follow_up_count
    FROM leads
    WHERE pipeline IN ('new', 'contacted')
      AND follow_up_count < ?
      AND phone IS NOT NULL AND TRIM(phone) != '' AND phone NOT LIKE '%not provided%'
  `).all(MAX_AUTO_FOLLOW_UPS) as StaleLead[];

  let sent = 0;
  for (const lead of candidates) {
    if (!isDue(lead)) continue;
    try {
      await sendSmsTo(lead.phone, followUpMessage(lead.name), 'CRM follow-up');
      db.prepare('UPDATE leads SET follow_up_count = follow_up_count + 1, last_follow_up_at = CURRENT_TIMESTAMP WHERE id = ?').run(lead.id);
      logActivity(lead.id, 'sms', { direction: 'out', body: followUpMessage(lead.name), meta: { automated: true, followUp: true } });
      sent++;
    } catch (err) {
      console.error(`[CRM] follow-up SMS failed for lead ${lead.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { sent };
}

// Off by default — texting leads automatically turned out to be unwanted in
// practice, so this now requires an explicit opt-in (CRM_AUTO_FOLLOWUP_ENABLED=1).
// runLeadFollowUps() is still here to call by hand or wire to a button later.
export function scheduleLeadFollowUps(): void {
  if (process.env.CRM_AUTO_FOLLOWUP_ENABLED !== '1') {
    console.log('[CRM] Follow-up sequence disabled (set CRM_AUTO_FOLLOWUP_ENABLED=1 to enable). Follow up manually from the CRM.');
    return;
  }
  const run = () => {
    runLeadFollowUps()
      .then((r) => { if (r.sent) console.log(`[CRM] follow-up sweep — sent ${r.sent} nudge(s)`); })
      .catch((err) => console.error('[CRM] follow-up sweep error:', err));
  };
  setTimeout(run, 5 * 60 * 1000);
  setInterval(run, 60 * 60 * 1000);
  console.log('[CRM] Follow-up sequence scheduled — hourly check, nudges leads stalled 48h+ (max 2 per lead)');
}
