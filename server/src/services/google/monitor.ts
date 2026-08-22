import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '../../config/anthropic';
import { ANTHROPIC_FAST_MODEL } from '../../config/models';
import { ARLO_SYSTEM_PROMPT } from '../../config/constants';
import { safeJsonParse } from '../../utils/safeJson';
import { broadcast } from '../../ws/hub';
import {
  GOOGLE_ACCOUNTS,
  INBOX_LOOKBACK_QUERY,
  INBOX_MAX_PER_SYNC,
  CALENDAR_LOOKAHEAD_DAYS,
  labelForEmail,
  googleConfigured,
} from '../../config/google';
import {
  listGoogleAccounts,
  insertEmailShell,
  getUntriagedEmails,
  applyTriage,
  upsertCalendarEvent,
  clearFutureCalendar,
  anyGoogleAccountConnected,
} from '../../db/google';
import { listRecentEmails, getEmailBody } from './gmail';
import { listUpcoming } from './calendar';

interface TriageOut {
  priority?: number;
  category?: string;
  needs_reply?: boolean;
  flagged?: boolean;
  summary?: string;
  draft_reply?: string;
}

const TRIAGE_SYSTEM = `${ARLO_SYSTEM_PROMPT}

## TRIAGE TASK
You are triaging one email from one of Joe's mailboxes so you can brief him and
tee up the reply. Use everything you know about Joe and Totally Outdoors LLC to
judge what matters to HIM.

Rate priority 1-5:
  1 = urgent / Joe needs it now (hot lead, upset client, permit blocker, money)
  2 = important, reply today
  3 = normal
  4 = low
  5 = noise / spam / newsletter
category: lead | client | vendor | permit | admin | spam | other
needs_reply: true only if a reply is genuinely warranted.
flagged: true if Joe would want this surfaced proactively.
summary: ONE tight sentence of what it is and why it matters.
draft_reply: if needs_reply, write the reply in JOE'S voice — warm, confident,
grateful with new leads, his signature phrases where natural, never the banned
words, no promises on price/timeline (that's Joe's call). Otherwise "".
Remember: out-of-area leads get politely declined; leads get qualified toward an
on-site estimate; you draft, Joe sends.

Return ONLY JSON:
{"priority":1-5,"category":"...","needs_reply":true/false,"flagged":true/false,"summary":"...","draft_reply":"..."}`;

async function triageOne(client: Anthropic, accountEmail: string, subject: string, from: string, body: string): Promise<TriageOut | null> {
  const context = `MAILBOX: ${labelForEmail(accountEmail)} <${accountEmail}>
FROM: ${from}
SUBJECT: ${subject}
BODY:
${body.slice(0, 4000)}`;

  try {
    const res = await client.messages.create({
      model: ANTHROPIC_FAST_MODEL,
      max_tokens: 1024,
      system: TRIAGE_SYSTEM,
      messages: [{ role: 'user', content: context }],
    });
    const block = res.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    return safeJsonParse<TriageOut>(block.text);
  } catch (err) {
    console.error('[Inbox] triage error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Pull + triage mail and sync calendars for every connected account. */
export async function syncAllAccounts(): Promise<{ fetched: number; triaged: number; events: number }> {
  const configured = googleConfigured();
  const allAccounts = listGoogleAccounts();
  const accounts = allAccounts.filter((a) => a.refresh_token);
  console.log(
    `[Inbox] sync run — google configured: ${configured} | accounts connected: ${accounts.length}/${allAccounts.length}` +
    (accounts.length ? ` (${accounts.map((a) => a.email).join(', ')})` : '')
  );

  if (!configured) {
    console.warn('[Inbox] sync skipped — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set');
    return { fetched: 0, triaged: 0, events: 0 };
  }
  if (accounts.length === 0) {
    console.warn('[Inbox] sync skipped — no mailbox has authorized yet. Visit /integrations to connect the three accounts.');
    return { fetched: 0, triaged: 0, events: 0 };
  }

  let fetched = 0;
  let events = 0;

  // 1) Fetch new mail shells + refresh calendar cache.
  for (const acct of accounts) {
    try {
      const emails = await listRecentEmails(acct.email, INBOX_LOOKBACK_QUERY, INBOX_MAX_PER_SYNC);
      let newForAcct = 0;
      for (const e of emails) {
        if (insertEmailShell({
          account_email: acct.email,
          gmail_id: e.gmail_id,
          thread_id: e.thread_id,
          from_addr: e.from_addr,
          to_addr: e.to_addr,
          subject: e.subject,
          snippet: e.snippet,
          received_at: e.received_at,
          is_unread: e.is_unread ? 1 : 0,
        })) { fetched++; newForAcct++; }
      }
      console.log(`[Inbox] ${acct.email}: ${emails.length} fetched from Gmail, ${newForAcct} new`);
    } catch (err) {
      console.error(`[Inbox] fetch FAILED for ${acct.email}:`, err instanceof Error ? err.message : err);
    }

    try {
      const upcoming = await listUpcoming(acct.email, CALENDAR_LOOKAHEAD_DAYS);
      clearFutureCalendar(acct.email);
      for (const ev of upcoming) {
        upsertCalendarEvent({ account_email: acct.email, ...ev });
        events++;
      }
    } catch (err) {
      console.error(`[Calendar] sync failed for ${acct.email}:`, err instanceof Error ? err.message : err);
    }
  }

  // 2) Triage anything not yet triaged (Joe's judgment + Joe-voice drafts).
  let triaged = 0;
  const apiKey = anthropicApiKey();
  if (apiKey) {
    const client = new Anthropic({ apiKey });
    const pending = getUntriagedEmails(INBOX_MAX_PER_SYNC * accounts.length);
    for (const item of pending) {
      let body = item.snippet || '';
      try { body = await getEmailBody(item.account_email, item.gmail_id) || body; } catch { /* keep snippet */ }
      const t = await triageOne(client, item.account_email, item.subject || '', item.from_addr || '', body);
      if (!t) continue;
      const needsReply = !!t.needs_reply;
      applyTriage(item.id, {
        priority: Math.max(1, Math.min(Number(t.priority) || 3, 5)),
        category: t.category || 'other',
        needs_reply: needsReply ? 1 : 0,
        flagged: t.flagged ? 1 : 0,
        summary: t.summary || (item.subject || ''),
        draft_reply: needsReply ? (t.draft_reply || '') : null,
        draft_status: needsReply && t.draft_reply ? 'pending' : 'none',
      });
      triaged++;
    }
  }

  if (fetched > 0 || triaged > 0 || events > 0) {
    broadcast({ type: 'inbox_updated', fetched, triaged, events });
  }
  // Always log the outcome so it's clear the run happened, even when quiet.
  console.log(`[Inbox] sync complete — ${fetched} new email(s), ${triaged} triaged, ${events} calendar event(s) across ${accounts.length} account(s)`);
  return { fetched, triaged, events };
}

export function knownAccountLabels(): string[] {
  return GOOGLE_ACCOUNTS.map((a) => `${a.label} <${a.email}>`);
}
