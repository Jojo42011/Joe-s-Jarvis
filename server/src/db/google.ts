import { getDb } from './schema';

export interface GoogleAccountRow {
  id: number;
  email: string;
  label: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: number | null;
  scopes: string | null;
}

export interface EmailItemRow {
  id: number;
  account_email: string;
  gmail_id: string;
  thread_id: string | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: string | null;
  is_unread: number;
  priority: number;
  category: string | null;
  needs_reply: number;
  flagged: number;
  summary: string | null;
  draft_reply: string | null;
  draft_status: string;
  triaged: number;
}

export interface CalendarEventRow {
  id: number;
  account_email: string;
  event_id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_time: string | null;
  end_time: string | null;
  attendees: string | null;
  status: string | null;
}

// ── Accounts ──────────────────────────────────────────────────────────────

export function upsertGoogleAccount(a: {
  email: string;
  label?: string;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expiry?: number | null;
  scopes?: string | null;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO google_accounts (email, label, access_token, refresh_token, token_expiry, scopes, updated_at)
    VALUES (@email, @label, @access_token, @refresh_token, @token_expiry, @scopes, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET
      label = COALESCE(excluded.label, google_accounts.label),
      access_token = excluded.access_token,
      -- keep the existing refresh_token if Google didn't send a new one
      refresh_token = COALESCE(excluded.refresh_token, google_accounts.refresh_token),
      token_expiry = excluded.token_expiry,
      scopes = COALESCE(excluded.scopes, google_accounts.scopes),
      updated_at = CURRENT_TIMESTAMP
  `).run({
    email: a.email,
    label: a.label ?? null,
    access_token: a.access_token ?? null,
    refresh_token: a.refresh_token ?? null,
    token_expiry: a.token_expiry ?? null,
    scopes: a.scopes ?? null,
  });
}

export function updateGoogleTokens(email: string, access_token: string, token_expiry: number | null, refresh_token?: string | null): void {
  const db = getDb();
  db.prepare(`
    UPDATE google_accounts
    SET access_token = ?, token_expiry = ?,
        refresh_token = COALESCE(?, refresh_token),
        updated_at = CURRENT_TIMESTAMP
    WHERE email = ?
  `).run(access_token, token_expiry, refresh_token ?? null, email);
}

export function getGoogleAccount(email: string): GoogleAccountRow | undefined {
  return getDb().prepare('SELECT * FROM google_accounts WHERE email = ?').get(email) as GoogleAccountRow | undefined;
}

export function listGoogleAccounts(): GoogleAccountRow[] {
  return getDb().prepare('SELECT * FROM google_accounts ORDER BY id').all() as GoogleAccountRow[];
}

export function anyGoogleAccountConnected(): boolean {
  try {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM google_accounts WHERE refresh_token IS NOT NULL').get() as { c: number };
    return row.c > 0;
  } catch {
    return false;
  }
}

/** True once the given mailbox holds a live refresh_token that includes the given scope. */
export function accountHasScope(email: string, scopeSubstring: string): boolean {
  try {
    const row = getDb().prepare(
      'SELECT refresh_token, scopes FROM google_accounts WHERE email = ?'
    ).get(email) as { refresh_token: string | null; scopes: string | null } | undefined;
    return !!(row && row.refresh_token && row.scopes && row.scopes.includes(scopeSubstring));
  } catch {
    return false;
  }
}

/**
 * Clear a mailbox's stored tokens so the UI stops claiming "Connected" once
 * access has been revoked on Google's side (the "Connected" badge only ever
 * checks for a stored refresh_token — it never pings Google). This is the
 * disconnect action; clicking "Connect" again afterward starts a fresh OAuth
 * consent, which is required to pick up any scope added after the original grant.
 */
export function clearGoogleAccountTokens(email: string): void {
  getDb().prepare(`
    UPDATE google_accounts
    SET access_token = NULL, refresh_token = NULL, token_expiry = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE email = ?
  `).run(email);
}

// ── Email items ───────────────────────────────────────────────────────────

/** Insert a freshly fetched message shell if we haven't seen it. Returns true if new. */
export function insertEmailShell(item: {
  account_email: string;
  gmail_id: string;
  thread_id?: string | null;
  from_addr?: string | null;
  to_addr?: string | null;
  subject?: string | null;
  snippet?: string | null;
  received_at?: string | null;
  is_unread?: number;
}): boolean {
  const db = getDb();
  const res = db.prepare(`
    INSERT OR IGNORE INTO email_items
      (account_email, gmail_id, thread_id, from_addr, to_addr, subject, snippet, received_at, is_unread)
    VALUES (@account_email, @gmail_id, @thread_id, @from_addr, @to_addr, @subject, @snippet, @received_at, @is_unread)
  `).run({
    account_email: item.account_email,
    gmail_id: item.gmail_id,
    thread_id: item.thread_id ?? null,
    from_addr: item.from_addr ?? null,
    to_addr: item.to_addr ?? null,
    subject: item.subject ?? null,
    snippet: item.snippet ?? null,
    received_at: item.received_at ?? null,
    is_unread: item.is_unread ?? 1,
  });
  return res.changes > 0;
}

export function getUntriagedEmails(limit = 20): EmailItemRow[] {
  return getDb().prepare(
    'SELECT * FROM email_items WHERE triaged = 0 ORDER BY received_at DESC LIMIT ?'
  ).all(limit) as EmailItemRow[];
}

export function applyTriage(id: number, t: {
  priority: number;
  category: string;
  needs_reply: number;
  flagged: number;
  summary: string;
  draft_reply?: string | null;
  draft_status?: string;
}): void {
  getDb().prepare(`
    UPDATE email_items
    SET priority = ?, category = ?, needs_reply = ?, flagged = ?, summary = ?,
        draft_reply = ?, draft_status = ?, triaged = 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    t.priority, t.category, t.needs_reply, t.flagged, t.summary,
    t.draft_reply ?? null, t.draft_status ?? (t.draft_reply ? 'pending' : 'none'), id
  );
}

export function getEmailItem(id: number): EmailItemRow | undefined {
  return getDb().prepare('SELECT * FROM email_items WHERE id = ?').get(id) as EmailItemRow | undefined;
}

export function setDraftStatus(id: number, status: string): void {
  getDb().prepare('UPDATE email_items SET draft_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
}

export function updateDraftBody(id: number, body: string): void {
  getDb().prepare('UPDATE email_items SET draft_reply = ?, draft_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(body, 'pending', id);
}

export interface InboxFilter {
  account?: string;
  flaggedOnly?: boolean;
  pendingDraftsOnly?: boolean;
  limit?: number;
}

export interface AccountEmailCounts {
  account_email: string;
  total: number;
  unread: number;
  flagged: number;
  pending_drafts: number;
}

export function emailCountsByAccount(): AccountEmailCounts[] {
  return getDb().prepare(`
    SELECT account_email,
           COUNT(*) AS total,
           SUM(CASE WHEN is_unread = 1 THEN 1 ELSE 0 END) AS unread,
           SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged,
           SUM(CASE WHEN draft_status = 'pending' THEN 1 ELSE 0 END) AS pending_drafts
    FROM email_items GROUP BY account_email
  `).all() as AccountEmailCounts[];
}

/** Most recent emails for an account (newest first), for the brain digest + panel. */
export function recentEmails(account: string, limit = 6): EmailItemRow[] {
  return getDb().prepare(
    'SELECT * FROM email_items WHERE account_email = ? ORDER BY received_at DESC LIMIT ?'
  ).all(account, limit) as EmailItemRow[];
}

export function listEmailItems(f: InboxFilter = {}): EmailItemRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.account) { clauses.push('account_email = ?'); params.push(f.account); }
  if (f.flaggedOnly) { clauses.push('flagged = 1'); }
  if (f.pendingDraftsOnly) { clauses.push("draft_status = 'pending'"); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  params.push(f.limit ?? 50);
  return getDb().prepare(
    `SELECT * FROM email_items ${where} ORDER BY priority ASC, received_at DESC LIMIT ?`
  ).all(...params) as EmailItemRow[];
}

/**
 * Keyword search across subject/sender/summary/snippet — for when Joe asks
 * about something older than the passive top-6-per-mailbox snapshot Arlo is
 * normally given (e.g. "did that vendor ever email back about the tile order").
 */
export function searchEmailItems(query: string, limit = 10): EmailItemRow[] {
  const q = `%${query.trim()}%`;
  return getDb().prepare(`
    SELECT * FROM email_items
    WHERE subject LIKE ? OR from_addr LIKE ? OR summary LIKE ? OR snippet LIKE ?
    ORDER BY received_at DESC LIMIT ?
  `).all(q, q, q, q, limit) as EmailItemRow[];
}

// ── Calendar cache ────────────────────────────────────────────────────────

export function upsertCalendarEvent(e: {
  account_email: string;
  event_id: string;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  attendees?: string | null;
  status?: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO calendar_events
      (account_email, event_id, summary, description, location, start_time, end_time, attendees, status, updated_at)
    VALUES (@account_email, @event_id, @summary, @description, @location, @start_time, @end_time, @attendees, @status, CURRENT_TIMESTAMP)
    ON CONFLICT(account_email, event_id) DO UPDATE SET
      summary = excluded.summary, description = excluded.description, location = excluded.location,
      start_time = excluded.start_time, end_time = excluded.end_time, attendees = excluded.attendees,
      status = excluded.status, updated_at = CURRENT_TIMESTAMP
  `).run({
    account_email: e.account_email,
    event_id: e.event_id,
    summary: e.summary ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    start_time: e.start_time ?? null,
    end_time: e.end_time ?? null,
    attendees: e.attendees ?? null,
    status: e.status ?? null,
  });
}

export function clearFutureCalendar(account_email: string): void {
  // Drop cached upcoming events for an account before a fresh sync (keeps it tidy).
  getDb().prepare(
    "DELETE FROM calendar_events WHERE account_email = ? AND (start_time IS NULL OR start_time >= datetime('now', '-1 day'))"
  ).run(account_email);
}

export function listUpcomingEvents(account?: string, limit = 40): CalendarEventRow[] {
  if (account) {
    return getDb().prepare(
      'SELECT * FROM calendar_events WHERE account_email = ? ORDER BY start_time ASC LIMIT ?'
    ).all(account, limit) as CalendarEventRow[];
  }
  return getDb().prepare(
    'SELECT * FROM calendar_events ORDER BY start_time ASC LIMIT ?'
  ).all(limit) as CalendarEventRow[];
}
