/**
 * Google (Gmail + Calendar) configuration.
 *
 * One OAuth client (a Google Cloud "Web application" credential) authorizes all
 * three Aquatic mailboxes individually. Tokens are stored per-account in the DB,
 * so account 2 and 3 are just extra trips through the consent screen — no code
 * changes. Everything degrades gracefully when the secrets are absent.
 */

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

/** Full callback URL registered in the Google Cloud console. */
export const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  'https://arthur-arlo.fly.dev/api/google/callback';

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

/** The three mailboxes Arlo watches, kept separate so he can speak per-inbox. */
export const GOOGLE_ACCOUNTS: KnownAccount[] = [
  { email: 'arthur.garcia@aquaticpoolaz.com', label: 'Arthur (Primary)' },
  { email: 'info@aquaticpoolaz.com', label: 'Info / New Leads' },
  { email: 'support@aquaticpoolaz.com', label: 'Support' },
];

export function labelForEmail(email: string): string {
  const found = GOOGLE_ACCOUNTS.find((a) => a.email.toLowerCase() === email.toLowerCase());
  return found ? found.label : email;
}

/**
 * How much mail to pull per account per sync.
 * TEMP (verification): pull the last 10 messages regardless of read state so we
 * can confirm Arlo is actually reading the inbox. Tighten back to
 * "in:inbox is:unread newer_than:7d" once confirmed.
 */
export const INBOX_LOOKBACK_QUERY = process.env.GOOGLE_INBOX_QUERY || 'in:inbox';
export const INBOX_MAX_PER_SYNC = parseInt(process.env.GOOGLE_INBOX_MAX || '10', 10);
export const CALENDAR_LOOKAHEAD_DAYS = parseInt(process.env.GOOGLE_CAL_DAYS || '14', 10);
