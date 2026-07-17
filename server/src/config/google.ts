/**
 * Google (Gmail + Calendar) configuration.
 *
 * One OAuth client (a Google Cloud "Web application" credential) authorizes each
 * Totally Outdoors mailbox individually. Tokens are stored per-account in the DB,
 * so adding another mailbox later is just an extra trip through the consent
 * screen — no code changes. Everything degrades gracefully when the secrets are absent.
 */

// Aliased to GMAIL_CLIENT_ID/SECRET too — Joe's Fly secrets from the prior
// JARVIS build use that naming, and it's the same Google Cloud OAuth client
// either way. No need to rename anything already set.
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.GMAIL_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || '';

/** A long-lived refresh token already granted under the prior JARVIS build for
 *  the same mailbox (same scopes: gmail read/send/modify + calendar, a
 *  superset of what this app needs). When present, boot wires it straight into
 *  google_accounts for GOOGLE_ACCOUNTS[0] — no new consent-screen click
 *  required. See services/google/bootstrap.ts. */
export const LEGACY_GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN?.trim() || '';

/** Full callback URL registered in the Google Cloud console. Must match the
 *  domain this app actually runs on (joes-jarvis.fly.dev) — override with
 *  GOOGLE_REDIRECT_URI if the domain ever changes. */
export const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  'https://joes-jarvis.fly.dev/api/google/callback';

export function googleConfigured(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

/** Scopes: identify the account, read+modify+send mail, full calendar. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  // Real SEO rankings for Lauren (Search Console). Re-consent required after adding.
  'https://www.googleapis.com/auth/webmasters.readonly',
];

export interface KnownAccount {
  email: string;
  label: string;
}

/** The mailboxes Jarvis watches, kept separate so he can speak per-inbox. Add more entries as needed. */
export const GOOGLE_ACCOUNTS: KnownAccount[] = [
  { email: 'totallyoutdoors@gmail.com', label: 'Office / New Leads' },
];

export function labelForEmail(email: string): string {
  const found = GOOGLE_ACCOUNTS.find((a) => a.email.toLowerCase() === email.toLowerCase());
  return found ? found.label : email;
}

/**
 * How much mail to pull per account per sync.
 * TEMP (verification): pull the last 10 messages regardless of read state so we
 * can confirm Jarvis is actually reading the inbox. Tighten back to
 * "in:inbox is:unread newer_than:7d" once confirmed.
 */
export const INBOX_LOOKBACK_QUERY = process.env.GOOGLE_INBOX_QUERY || 'in:inbox';
export const INBOX_MAX_PER_SYNC = parseInt(process.env.GOOGLE_INBOX_MAX || '10', 10);
export const CALENDAR_LOOKAHEAD_DAYS = parseInt(process.env.GOOGLE_CAL_DAYS || '14', 10);
