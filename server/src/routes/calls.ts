import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { getDb } from '../db/schema';
import { syncVapiCalls, lastSyncOkAt } from '../services/vapiSync';

const router = Router();

// The dashboard reads the synced vapi_calls table (see services/vapiSync.ts) —
// full lifetime history across ALL assistants, costs included — instead of a
// capped live fetch filtered to one assistant id (which is how the count got
// stuck at a fraction of the real total).

interface CallDbRow {
  id: string;
  direction: string;
  number: string | null;
  customer_name: string | null;
  duration_sec: number;
  connected: number;
  booked: number;
  ended_reason: string | null;
  cost: number;
  cost_breakdown: string | null;
  started_at: string | null;
  created_at: string | null;
  recording_url: string | null;
  transcript: string | null;
  messages: string | null;
  summary: string | null;
}

const DISPLAY_LIMIT = 300; // rows returned to the UI (stats cover ALL synced calls)

function rowToPayload(r: CallDbRow) {
  let costBreakdown: Record<string, number> | null = null;
  let messages: { role: string; text: string }[] = [];
  try { costBreakdown = r.cost_breakdown ? JSON.parse(r.cost_breakdown) : null; } catch { /* keep null */ }
  try { messages = r.messages ? JSON.parse(r.messages) : []; } catch { /* keep empty */ }
  return {
    id: r.id,
    direction: r.direction || 'unknown',
    number: r.number || '—',
    customerName: r.customer_name || '',
    durationSec: r.duration_sec || 0,
    connected: !!r.connected,
    booked: !!r.booked,
    endedReason: r.ended_reason || 'unknown',
    cost: r.cost || 0,
    costBreakdown,
    startedAt: r.started_at,
    recordingUrl: r.recording_url,
    transcript: r.transcript,
    messages,
    summary: r.summary,
  };
}

router.get('/calls', async (_req: Request, res: Response) => {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) {
    res.json({ connected: false, reason: 'VAPI_API_KEY not configured' });
    return;
  }

  const db = getDb();

  // Cold start (fresh volume / first deploy of the sync): pull the history in
  // before answering so the dashboard never shows an empty table with a key set.
  const count = (db.prepare('SELECT COUNT(*) c FROM vapi_calls').get() as { c: number }).c;
  if (count === 0) {
    try { await syncVapiCalls(); } catch (err) {
      console.error('[Phone] initial call sync failed:', err);
      res.json({ connected: false, reason: err instanceof Error ? err.message : 'Vapi sync failed' });
      return;
    }
  } else {
    // Self-heal: if the last successful sync is older than the scheduler's
    // cadence allows, the interval loop is dead or erroring — run a pass right
    // now so opening the dashboard always serves fresh numbers. (Concurrent
    // callers share one in-flight pass, so this can't stack requests.)
    const last = lastSyncOkAt();
    const ageMs = last ? Date.now() - new Date(last).getTime() : Infinity;
    if (ageMs > 5 * 60 * 1000) {
      try { await syncVapiCalls(); } catch (err) {
        console.error('[Phone] on-demand sync failed (serving cached data):', err instanceof Error ? err.message : err);
      }
    }
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(connected), 0) AS connected,
      COALESCE(SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END), 0) AS inbound,
      COALESCE(SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END), 0) AS outbound,
      COALESCE(SUM(booked), 0) AS booked,
      COALESCE(SUM(cost), 0) AS totalCost,
      COALESCE(SUM(CASE WHEN connected = 1 THEN duration_sec ELSE 0 END), 0) AS connectedSec
    FROM vapi_calls
  `).get() as { total: number; connected: number; inbound: number; outbound: number; booked: number; totalCost: number; connectedSec: number };

  const lastSync = lastSyncOkAt();
  const syncAgeSec = lastSync ? Math.max(0, Math.round((Date.now() - new Date(lastSync).getTime()) / 1000)) : null;
  const rows = (db.prepare('SELECT * FROM vapi_calls ORDER BY created_at DESC LIMIT ?').all(DISPLAY_LIMIT) as CallDbRow[]).map(rowToPayload);

  res.json({
    connected: true,
    stats: {
      total: stats.total,
      connected: stats.connected,
      inbound: stats.inbound,
      outbound: stats.outbound,
      booked: stats.booked,
      avgDurationSec: stats.connected ? Math.round(stats.connectedSec / stats.connected) : 0,
      totalCost: Number(stats.totalCost.toFixed(2)),
    },
    calls: rows,
    fetched: stats.total,
    lastSync,
    syncAgeSec,
  });
});

// Range-capable recording proxy — lets the browser seek + play recordings in full
// reliably (no CORS / range gaps from Vapi storage). Host-allowlisted to avoid SSRF.
const RECORDING_HOST_SUFFIXES = ['vapi.ai', 'amazonaws.com', 'cloudfront.net', 'googleapis.com', 'blob.core.windows.net', 'twilio.com'];
function allowedRecordingHost(host: string): boolean {
  const h = host.toLowerCase();
  return RECORDING_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s) || h.endsWith(s));
}

// Cap concurrent upstream recording fetches. A page that spawns hundreds of
// simultaneous proxied fetches can exhaust the VM's sockets — which also
// starves the Vapi sync's own requests. Over-cap requests get a 503 and the
// player simply retries when the user presses play.
let recordingFetchesActive = 0;
const MAX_RECORDING_FETCHES = 8;

router.get('/calls/recording', async (req: Request, res: Response) => {
  const raw = String(req.query.url || '');
  let target: URL;
  try { target = new URL(raw); } catch { res.status(400).send('bad url'); return; }
  if (target.protocol !== 'https:' || !allowedRecordingHost(target.hostname)) {
    res.status(403).send('forbidden host');
    return;
  }
  if (recordingFetchesActive >= MAX_RECORDING_FETCHES) {
    res.status(503).setHeader('Retry-After', '2');
    res.send('busy');
    return;
  }
  recordingFetchesActive++;
  res.once('close', () => { recordingFetchesActive = Math.max(0, recordingFetchesActive - 1); });
  try {
    const range = req.headers.range;
    const upstream = await fetch(target.toString(), {
      headers: range ? { Range: range } : {},
      signal: AbortSignal.timeout(30_000),
    });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'audio/wav');
    if (!upstream.body) { res.end(); return; }
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } catch (err) {
    console.error('[Phone] recording proxy error:', err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(502).send('recording fetch failed');
  }
});

export default router;
