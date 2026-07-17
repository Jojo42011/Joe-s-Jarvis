import { GOOGLE_ACCOUNTS, LEGACY_GMAIL_REFRESH_TOKEN, googleConfigured } from '../../config/google';
import { getGoogleAccount, upsertGoogleAccount } from '../../db/google';

/**
 * One-time boot step: if Joe's prior JARVIS build already has a working
 * GMAIL_REFRESH_TOKEN for totallyoutdoors@gmail.com (granted with
 * gmail.readonly/send/modify/labels + calendar — a superset of what this app
 * needs), wire it straight into google_accounts instead of making him click
 * through Google's consent screen again for a mailbox he's already authorized.
 *
 * Safe/idempotent: only fires if the account isn't already connected, so it
 * never clobbers a token from a real Connect-button click.
 */
export function bootstrapLegacyGmailAccount(): void {
  if (!googleConfigured()) {
    console.log('[Google] bootstrap skipped — GOOGLE_CLIENT_ID/SECRET (or GMAIL_CLIENT_ID/SECRET) not set.');
    return;
  }
  if (!LEGACY_GMAIL_REFRESH_TOKEN) {
    console.log('[Google] bootstrap skipped — GMAIL_REFRESH_TOKEN not set.');
    return;
  }

  const primary = GOOGLE_ACCOUNTS[0];
  if (!primary) {
    console.log('[Google] bootstrap skipped — no primary mailbox configured in GOOGLE_ACCOUNTS.');
    return;
  }

  const existing = getGoogleAccount(primary.email);
  if (existing?.refresh_token) {
    console.log(`[Google] bootstrap skipped — ${primary.email} already has a stored refresh_token.`);
    return;
  }

  upsertGoogleAccount({
    email: primary.email,
    label: primary.label,
    access_token: null,
    refresh_token: LEGACY_GMAIL_REFRESH_TOKEN,
    token_expiry: null, // forces a fresh access token on first authorized call
    scopes: 'gmail.readonly gmail.send gmail.modify gmail.metadata gmail.labels calendar',
  });

  const stored = getGoogleAccount(primary.email);
  console.log(
    `[Google] Bootstrapped ${primary.email} from legacy GMAIL_REFRESH_TOKEN — no consent screen needed. ` +
    `Verify: refresh_token stored = ${!!stored?.refresh_token}, length = ${stored?.refresh_token?.length ?? 0}.`
  );
}
