import { Router, Request, Response } from 'express';
import { googleConfigured, GOOGLE_ACCOUNTS, labelForEmail } from '../config/google';
import { getAuthUrl, handleOAuthCallback } from '../services/google/auth';
import { sendEmailReply, sendNewEmail, markEmailRead, getEmailBody } from '../services/google/gmail';
import { createEvent } from '../services/google/calendar';
import { syncAllAccounts } from '../services/google/monitor';
import {
  listGoogleAccounts,
  getGoogleAccount,
  listEmailItems,
  getEmailItem,
  setDraftStatus,
  updateDraftBody,
  listUpcomingEvents,
  upsertCalendarEvent,
  emailCountsByAccount,
  clearGoogleAccountTokens,
} from '../db/google';

const router = Router();

function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

// ── Connection status + OAuth ───────────────────────────────────────────────

router.get('/google/accounts', (_req: Request, res: Response) => {
  const connected = new Set(listGoogleAccounts().filter((a) => a.refresh_token).map((a) => a.email.toLowerCase()));
  const accounts = GOOGLE_ACCOUNTS.map((a) => ({
    email: a.email,
    label: a.label,
    connected: connected.has(a.email.toLowerCase()),
    connectUrl: `/api/google/connect?account=${encodeURIComponent(a.email)}`,
  }));
  res.json({ configured: googleConfigured(), accounts });
});

router.get('/google/connect', (req: Request, res: Response) => {
  if (!googleConfigured()) {
    res.status(503).send('Google is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.');
    return;
  }
  const account = String(req.query.account || '');
  const known = GOOGLE_ACCOUNTS.find((a) => a.email.toLowerCase() === account.toLowerCase());
  res.redirect(getAuthUrl(known ? known.email : account));
});

// Disconnect a mailbox: clears the stored token so the badge stops showing
// "Connected" after access was revoked on Google's side, and the next
// "Connect" click goes through a fresh consent screen (picking up any new
// scopes, e.g. Search Console, that the old grant didn't have).
router.post('/google/disconnect', (req: Request, res: Response) => {
  const account = String((req.body as { account?: string })?.account || req.query.account || '');
  const known = GOOGLE_ACCOUNTS.find((a) => a.email.toLowerCase() === account.toLowerCase());
  if (!known) { res.status(400).json({ error: 'unknown account' }); return; }
  clearGoogleAccountTokens(known.email);
  res.json({ ok: true });
});

router.get('/google/callback', async (req: Request, res: Response) => {
  const code = String(req.query.code || '');
  if (!code) { res.status(400).send('Missing authorization code'); return; }
  try {
    const email = await handleOAuthCallback(code);
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{background:#0a0a0a;color:#e0e0e0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{border:1px solid rgba(255,140,0,.4);border-radius:14px;padding:34px 40px;text-align:center}
h1{color:#FF8C00;font-size:20px;margin:0 0 8px}a{color:#FF8C00}</style></head>
<body><div class="card"><h1>✓ ${labelForEmail(email)} connected</h1>
<p>${email} is now wired to Arlo.</p>
<p><a href="/integrations">← Back to Integrations</a></p></div></body></html>`);
  } catch (err) {
    console.error('[Google] callback error:', err);
    res.status(500).send('Authorization failed: ' + (err instanceof Error ? err.message : 'unknown error'));
  }
});

// ── Inbox ───────────────────────────────────────────────────────────────────

router.get('/google/inbox', (req: Request, res: Response) => {
  const account = req.query.account ? String(req.query.account) : undefined;
  const flaggedOnly = req.query.flagged === '1';
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
  res.json({ items: listEmailItems({ account, flaggedOnly, limit }) });
});

router.get('/google/drafts', (_req: Request, res: Response) => {
  res.json({ items: listEmailItems({ pendingDraftsOnly: true, limit: 100 }) });
});

// Counts per account, for the panel's tabs/badges.
router.get('/google/counts', (_req: Request, res: Response) => {
  res.json({ counts: emailCountsByAccount() });
});

// One email with its full body (fetched live from Gmail).
router.get('/google/email/:id', async (req: Request, res: Response) => {
  const item = getEmailItem(Number(req.params.id));
  if (!item) { res.status(404).json({ error: 'not found' }); return; }
  let body = item.snippet || '';
  try { body = (await getEmailBody(item.account_email, item.gmail_id)) || body; } catch { /* keep snippet */ }
  res.json({ item, body });
});

// Compose + send a brand-new email. The panel send button IS Joe's approval.
router.post('/google/send', async (req: Request, res: Response) => {
  const { account, to, subject, body } = req.body as { account?: string; to?: string; subject?: string; body?: string };
  if (!account || !to || !subject || !body) {
    res.status(400).json({ error: 'account, to, subject, body required' });
    return;
  }
  const known = getGoogleAccount(account);
  if (!known || !known.refresh_token) { res.status(400).json({ error: `${account} not connected` }); return; }
  try {
    const sent = await sendNewEmail(account, { to, subject, body });
    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'send failed' });
  }
});

router.post('/google/draft/:id/edit', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { body } = req.body as { body?: string };
  if (!body) { res.status(400).json({ error: 'body required' }); return; }
  updateDraftBody(id, body);
  res.json({ ok: true });
});

router.post('/google/draft/:id/dismiss', (req: Request, res: Response) => {
  setDraftStatus(Number(req.params.id), 'dismissed');
  res.json({ ok: true });
});

// The one gated action: send a drafted reply, only on explicit approval.
router.post('/google/draft/:id/approve', async (req: Request, res: Response) => {
  const item = getEmailItem(Number(req.params.id));
  if (!item) { res.status(404).json({ error: 'not found' }); return; }
  if (!item.draft_reply) { res.status(400).json({ error: 'no draft to send' }); return; }
  const bodyOverride = (req.body as { body?: string })?.body;
  try {
    const sent = await sendEmailReply(item.account_email, {
      to: extractEmail(item.from_addr || ''),
      subject: item.subject || '',
      body: bodyOverride || item.draft_reply,
      threadId: item.thread_id || undefined,
    });
    setDraftStatus(item.id, 'sent');
    try { await markEmailRead(item.account_email, item.gmail_id); } catch { /* non-fatal */ }
    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'send failed' });
  }
});

// ── Calendar ────────────────────────────────────────────────────────────────

router.get('/google/calendar', (req: Request, res: Response) => {
  const account = req.query.account ? String(req.query.account) : undefined;
  res.json({ events: listUpcomingEvents(account, 60) });
});

router.post('/google/calendar/create', async (req: Request, res: Response) => {
  const { account, summary, start, end, description, location, attendees } = req.body as {
    account?: string; summary?: string; start?: string; end?: string;
    description?: string; location?: string; attendees?: string[];
  };
  if (!account || !summary || !start || !end) {
    res.status(400).json({ error: 'account, summary, start, end required' });
    return;
  }
  const known = getGoogleAccount(account);
  if (!known || !known.refresh_token) { res.status(400).json({ error: `${account} not connected` }); return; }
  try {
    const created = await createEvent(account, { summary, start, end, description, location, attendees });
    upsertCalendarEvent({
      account_email: account, event_id: created.id, summary,
      description: description || null, location: location || null,
      start_time: start, end_time: end,
      attendees: (attendees || []).join(', '), status: 'confirmed',
    });
    res.json({ ok: true, event: created });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'create failed' });
  }
});

// ── Manual sync trigger ─────────────────────────────────────────────────────

// Manual sync — no auth, awaits the run and returns real counts for testing.
// Available as POST (programmatic) and GET (browser-friendly).
async function runManualSync(_req: Request, res: Response) {
  try {
    const result = await syncAllAccounts();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Inbox] manual sync error:', err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'sync failed' });
  }
}

router.post('/google/sync', runManualSync);
router.get('/google/sync', runManualSync);

export default router;
