import {
  listEmailItems,
  listUpcomingEvents,
  emailCountsByAccount,
  recentEmails,
  anyGoogleAccountConnected,
} from '../../db/google';
import { GOOGLE_ACCOUNTS, labelForEmail } from '../../config/google';

const MAX_CHARS = 3000;

function fmtWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function shortFrom(from: string | null): string {
  if (!from) return 'unknown';
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : from).trim().slice(0, 40);
}

/**
 * Live snapshot of the three inboxes + calendars injected into Arlo's brain so
 * he can actually see and talk about email — counts, senders, subjects, what's
 * hot — per mailbox. Always includes recent mail (not just flagged), so Arlo is
 * never blind to a connected inbox.
 */
export function buildInboxCalendarContext(): string {
  if (!anyGoogleAccountConnected()) return '';

  const counts = emailCountsByAccount();
  const countMap = new Map(counts.map((c) => [c.account_email.toLowerCase(), c]));
  const lines: string[] = ['## LIVE INBOX & CALENDAR — Arthur\'s three mailboxes (you have full access)'];

  // Snapshot line + recent mail per mailbox.
  for (const acct of GOOGLE_ACCOUNTS) {
    const c = countMap.get(acct.email.toLowerCase());
    if (!c || c.total === 0) continue;
    lines.push(`### ${acct.label} <${acct.email}> — ${c.total} recent, ${c.unread} unread, ${c.flagged} flagged, ${c.pending_drafts} draft(s) ready`);
    for (const e of recentEmails(acct.email, 6)) {
      const flag = e.flagged ? '★' : ' ';
      const p = e.priority ? `P${e.priority}` : 'P?';
      const draft = e.draft_status === 'pending' ? ' [reply drafted]' : '';
      const line = e.summary
        ? `${flag} (${p}) ${e.summary}${draft} [#${e.id}]`
        : `${flag} (${p}) ${shortFrom(e.from_addr)}: ${e.subject || '(no subject)'}${draft} [#${e.id}]`;
      lines.push(`- ${line}`);
    }
  }

  // Cross-mailbox "needs attention" and drafts awaiting approval.
  const flagged = listEmailItems({ flaggedOnly: true, limit: 8 });
  if (flagged.length) {
    lines.push('### NEEDS ATTENTION (any mailbox)');
    for (const e of flagged) {
      lines.push(`- (${labelForEmail(e.account_email)}, P${e.priority}) ${e.summary || e.subject} [#${e.id}]`);
    }
  }

  const drafts = listEmailItems({ pendingDraftsOnly: true, limit: 8 });
  if (drafts.length) {
    lines.push(`### DRAFTS AWAITING YOUR OK (${drafts.length})`);
    for (const e of drafts) {
      lines.push(`- (${labelForEmail(e.account_email)}) Re: ${e.subject} [#${e.id}]`);
    }
  }

  // Upcoming calendar per mailbox.
  const calLines: string[] = [];
  for (const acct of GOOGLE_ACCOUNTS) {
    const evs = listUpcomingEvents(acct.email, 4);
    if (!evs.length) continue;
    calLines.push(`- ${acct.label}: ` + evs.map((v) => `${v.summary} (${fmtWhen(v.start_time)})`).join('; '));
  }
  if (calLines.length) {
    lines.push('### UPCOMING CALENDAR');
    lines.push(...calLines);
  }

  if (lines.length === 1) return '';
  lines.push('When Arthur asks about email, answer concretely from this — counts, who, subjects, what\'s hot. Reference an item by its #id. You draft replies (Arthur approves before send); you may add calendar events directly. The full working panel is at /inbox.');

  return lines.join('\n').slice(0, MAX_CHARS);
}
