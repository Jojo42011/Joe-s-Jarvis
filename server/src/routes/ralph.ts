import { Router, Request, Response } from 'express';
import {
  createRalphContent, updateRalphContent, deleteRalphContent,
  listRalphContent, ralphStats, ralphAnalytics, RALPH_CHANNELS, RALPH_STATUSES,
  getRalphVideoBytes, swapRalphCaption, nextOpenScheduleDate,
} from '../db/ralph';
import { generateBatch, pendingDraftCount, publishRalphPost } from '../services/ralphContent';
import { getZernioSocial, listZernioAccounts, hasZernio } from '../services/zernio';

const router = Router();

function reqOrigin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol || 'https';
  const host = req.headers.host;
  return host ? `${proto}://${host}` : '';
}

// Whether a generation run is in flight (image gen is slow/throttled — don't stack).
let generating = false;

// Paulie generates real on-brand posts (caption + image) into the Approvals queue.
// Best-effort and async-safe: returns immediately with what it made. count 1–12.
router.post('/ralph/generate', async (req: Request, res: Response) => {
  if (generating) { res.status(409).json({ ok: false, error: 'A generation run is already in progress.' }); return; }
  const b = (req.body || {}) as { count?: number; channel?: string };
  const count = Math.max(1, Math.min(Number(b.count) || 5, 12));
  const channel = b.channel && RALPH_CHANNELS.includes(b.channel) ? b.channel : undefined;
  generating = true;
  try {
    const posts = await generateBatch(count, channel as never);
    res.json({ ok: true, created: posts.length, pending: pendingDraftCount(), posts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'generation failed' });
  } finally {
    generating = false;
  }
});

// Serve a rendered reel video. Accepts /ralph/video/:id.mp4 (the .mp4 is cosmetic).
router.get('/ralph/video/:id', (req: Request, res: Response) => {
  const id = Number(String(req.params.id).replace(/\.mp4$/i, ''));
  if (!Number.isFinite(id)) { res.status(400).end(); return; }
  const bytes = getRalphVideoBytes(id);
  if (!bytes) { res.status(404).end(); return; }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Accept-Ranges', 'bytes');
  res.end(bytes);
});

router.get('/ralph/status', (_req: Request, res: Response) => {
  res.json({ ready: true, name: 'Paulie', role: 'Content Manager', channels: RALPH_CHANNELS, statuses: RALPH_STATUSES, stats: ralphStats() });
});

router.get('/ralph/analytics', async (_req: Request, res: Response) => {
  // Merge REAL social numbers from Zernio (cached) into the pipeline analytics.
  const social = hasZernio() ? await getZernioSocial().catch(() => undefined) : undefined;
  res.json(ralphAnalytics(social));
});

// Connected social accounts (Instagram/Facebook) surfaced through Zernio.
router.get('/ralph/accounts', async (_req: Request, res: Response) => {
  if (!hasZernio()) { res.json({ connected: false, accounts: [] }); return; }
  const accounts = await listZernioAccounts().catch(() => []);
  res.json({ connected: accounts.length > 0, accounts });
});

// Approve & publish a post to its real platform (Instagram/Facebook) via Zernio.
router.post('/ralph/content/:id/publish', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'bad id' }); return; }
  const result = await publishRalphPost(id, reqOrigin(req));
  res.status(result.ok ? 200 : 400).json(result);
});

router.get('/ralph/content', (req: Request, res: Response) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  const channel = req.query.channel ? String(req.query.channel) : undefined;
  res.json({ items: listRalphContent({ status, channel }) });
});

router.post('/ralph/content', (req: Request, res: Response) => {
  const { title, channel, body, status, tags, scheduled_for, format } = req.body as Record<string, string>;
  if (!title || !title.trim()) { res.status(400).json({ error: 'title required' }); return; }
  const id = createRalphContent({ title: title.trim(), channel, body, status, tags, scheduled_for, format });
  res.json({ ok: true, id });
});

router.post('/ralph/content/:id', (req: Request, res: Response) => {
  const patch = { ...(req.body || {}) } as Record<string, unknown>;
  // Approving to the schedule with no date → drop it into the next proven
  // posting slot so the calendar fills sensibly instead of staying blank.
  if (patch.status === 'scheduled' && !patch.scheduled_for) {
    const slot = nextOpenScheduleDate(Date.now());
    if (slot) patch.scheduled_for = slot;
  }
  updateRalphContent(Number(req.params.id), patch);
  res.json({ ok: true, scheduled_for: patch.scheduled_for ?? null });
});

// Swap a post's caption with its alternate angle (Arthur picked the other one).
router.post('/ralph/content/:id/swap-caption', (req: Request, res: Response) => {
  const ok = swapRalphCaption(Number(req.params.id));
  res.status(ok ? 200 : 400).json({ ok });
});

router.post('/ralph/content/:id/delete', (req: Request, res: Response) => {
  deleteRalphContent(Number(req.params.id));
  res.json({ ok: true });
});

router.get('/ralph/calendar', (_req: Request, res: Response) => {
  const items = listRalphContent().filter((i) => i.scheduled_for || i.published_at);
  const events = items.map((i) => ({
    id: i.id, title: i.title, channel: i.channel,
    date: (i.scheduled_for || i.published_at || '').split('T')[0].split(' ')[0],
    status: i.status,
  }));
  res.json({ events });
});

export default router;
