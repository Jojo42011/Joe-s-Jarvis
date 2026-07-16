import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_SCOPES,
  googleConfigured,
  labelForEmail,
} from '../../config/google';
import { getGoogleAccount, upsertGoogleAccount, updateGoogleTokens } from '../../db/google';

function baseClient(): OAuth2Client {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

/**
 * Consent URL for a specific mailbox. `state` carries the intended email so the
 * callback can label it; the true identity is confirmed from userinfo. login_hint
 * pre-selects the right Google account on the chooser.
 */
export function getAuthUrl(email: string): string {
  const client = baseClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token every time
    scope: GOOGLE_SCOPES,
    login_hint: email,
    state: email,
  });
}

/** Exchange the callback code for tokens and persist the account. Returns the email. */
export async function handleOAuthCallback(code: string): Promise<string> {
  const client = baseClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Confirm which mailbox actually authorized.
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const me = await oauth2.userinfo.get();
  const email = (me.data.email || '').toLowerCase();
  if (!email) throw new Error('Could not resolve account email from Google');

  upsertGoogleAccount({
    email,
    label: labelForEmail(email),
    access_token: tokens.access_token ?? null,
    refresh_token: tokens.refresh_token ?? null,
    token_expiry: tokens.expiry_date ?? null,
    scopes: (tokens.scope as string | undefined) ?? GOOGLE_SCOPES.join(' '),
  });

  return email;
}

/**
 * An authenticated client for a connected mailbox, or null if not connected.
 * Auto-persists refreshed access tokens via the 'tokens' event.
 */
export function getAuthorizedClient(email: string): OAuth2Client | null {
  if (!googleConfigured()) return null;
  const acct = getGoogleAccount(email);
  if (!acct || !acct.refresh_token) return null;

  const client = baseClient();
  client.setCredentials({
    access_token: acct.access_token ?? undefined,
    refresh_token: acct.refresh_token,
    expiry_date: acct.token_expiry ?? undefined,
  });

  client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      updateGoogleTokens(
        email,
        tokens.access_token,
        tokens.expiry_date ?? null,
        tokens.refresh_token ?? null
      );
    }
  });

  return client;
}
