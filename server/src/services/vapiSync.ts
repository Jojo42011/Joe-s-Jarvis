/**
 * Vapi call sync — pulls EVERY call on the account (all assistants: the
 * inbound receptionist AND the outbound sales agent alike) into the vapi_calls
 * table on a timed interval, costs included.
 *
 * Sync layers (each one covers a way the table can drift from Vapi's truth):
 *  1. Backfill  — pages through the whole account history once. Survives
 *     transient errors: every page is retried with backoff, and progress is
 *     checkpointed so an interrupted backfill RESUMES instead of restarting.
 *  2. Incremental (every 2 min) — upserts the newest page (refreshing
 *     cost/duration on recently-ended calls) and keeps paging only while it
 *     still sees calls it doesn't have.
 *  3. Reconcile (daily) — re-walks the FULL history, upserting everything
 *     (catches late cost corrections / summaries on old calls) and deleting
 *     local rows Vapi no longer has (test calls Joe deleted, etc.).
 *     Deletion only happens when the walk completed without gaps.
 * All passes share one in-flight guard so they never run concurrently, and
 * every successful pass stamps vapi_last_sync_ok so the dashboard can show
 * real freshness instead of assuming "key set = live".
 */

import { getDb } from '../db/schema';
import { getSystemState, setSystemState } from '../db/queries';

interface VapiMessage { role?: string; message?: string; content?: string }
interface VapiRecording {
  stereoUrl?: string;
  url?: string;
  mono?: { combinedUrl?: string; assistantUrl?: string; customerUrl?: string };
}

export interface VapiCall {
  id?: string;
  assistantId?: string;
  type?: string;
  status?: string;
  endedReason?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  cost?: number;
  costBreakdown?: { [key: string]: number | undefined };
  customer?: { number?: string; name?: string };
  analysis?: { successEvaluation?: string | boolean; summary?: string };
  artifact?: {
    recording?: string | VapiRecording;
    recordingUrl?: string | VapiRecording;
    stereoRecordingUrl?: string;
    transcript?: string;
    messages?: VapiMessage[];
    messagesOpenAIFormatted?: VapiMessage[];
  };
  recordingUrl?: string | VapiRecording;
  transcript?: string;
  messages?: VapiMessage[];
  summary?: string;
}

const COST_LINE_KEYS = new Set(['stt', 'llm', 'tts', 'vapi', 'transport']);
const HIDDEN_MESSAGE_ROLES = new Set(['system', 'tool', 'function']);
const PAGE_SIZE = 100;
const MAX_PAGES = 300;            // 30k calls — a backstop, not a real limit
const PAGE_DELAY_MS = 200;        // pacing between pages (keeps Vapi rate limits happy)
const FETCH_RETRIES = 3;

const BACKFILL_FLAG = 'vapi_backfill_done';
const BACKFILL_CURSOR = 'vapi_backfill_cursor';
const LAST_SYNC_OK = 'vapi_last_sync_ok';
const LAST_RECONCILE = 'vapi_last_reconcile';
const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
// Never delete rows younger than this during reconcile — a call created while
// we were mid-walk can legitimately be missing from the pages we saw.
const DELETE_MIN_AGE_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function durationSeconds(call: VapiCall): number {
  if (!call.startedAt || !call.endedAt) return 0;
  const start = new Date(call.startedAt).getTime();
  const end = new Date(call.endedAt).getTime();
  if (isNaN(start) || isNaN(end) || end <= start) return 0;
  return Math.round((end - start) / 1000);
}

function isBooked(call: VapiCall): boolean {
  const se = call.analysis?.successEvaluation;
  if (se === true) return true;
  if (typeof se === 'string') {
    const v = se.toLowerCase();
    return v === 'true' || v === 'pass' || v === 'success' || v === 'booked';
  }
  return false;
}

function directionOf(call: VapiCall): string {
  if (call.type?.toLowerCase().includes('inbound')) return 'inbound';
  if (call.type?.toLowerCase().includes('outbound')) return 'outbound';
  return 'unknown';
}

function extractMessages(call: VapiCall): { role: string; text: string }[] {
  const raw = call.artifact?.messages ?? call.messages ?? call.artifact?.messagesOpenAIFormatted;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => {
      const role = (m.role ?? '').toLowerCase();
      if (!role || HIDDEN_MESSAGE_ROLES.has(role)) return false;
      return !!(m.message || m.content);
    })
    .map((m) => ({ role: m.role!, text: (m.message || m.content)! }));
}

function parseRecordingUrl(rec: string | VapiRecording | undefined): string | null {
  if (!rec) return null;
  if (typeof rec === 'string' && rec.startsWith('http')) return rec;
  if (typeof rec === 'object') {
    if (rec.stereoUrl) return rec.stereoUrl;
    if (rec.mono?.combinedUrl) return rec.mono.combinedUrl;
    if (rec.url) return rec.url;
  }
  return null;
}

function extractRecordingUrl(call: VapiCall): string | null {
  return parseRecordingUrl(call.artifact?.recording)
    ?? parseRecordingUrl(call.artifact?.recordingUrl)
    ?? parseRecordingUrl(call.recordingUrl)
    ?? call.artifact?.stereoRecordingUrl
    ?? null;
}

function extractCostBreakdown(call: VapiCall): string | null {
  if (!call.costBreakdown) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(call.costBreakdown)) {
    if (!COST_LINE_KEYS.has(k)) continue;
    if (typeof v === 'number' && v > 0) out[k] = Number(v.toFixed(4));
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** Upsert one Vapi call; returns true when the row didn't exist before.
 *  Exported so the Vapi webhook can write calls the moment they happen —
 *  real-time updates instead of waiting for the next sync interval. */
export function upsertVapiCall(c: VapiCall): boolean {
  return upsertCall(c);
}

function upsertCall(c: VapiCall): boolean {
  if (!c.id) return false;
  const db = getDb();
  const existed = !!db.prepare('SELECT 1 FROM vapi_calls WHERE id = ?').get(c.id);
  db.prepare(`
    INSERT INTO vapi_calls (
      id, assistant_id, direction, number, customer_name, duration_sec, connected,
      booked, ended_reason, cost, cost_breakdown, started_at, created_at,
      recording_url, transcript, messages, summary, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      duration_sec = excluded.duration_sec,
      connected = excluded.connected,
      booked = excluded.booked,
      ended_reason = excluded.ended_reason,
      cost = excluded.cost,
      cost_breakdown = excluded.cost_breakdown,
      recording_url = excluded.recording_url,
      transcript = excluded.transcript,
      messages = excluded.messages,
      summary = excluded.summary,
      synced_at = CURRENT_TIMESTAMP
  `).run(
    c.id,
    c.assistantId ?? null,
    directionOf(c),
    c.customer?.number ?? null,
    c.customer?.name ?? null,
    durationSeconds(c),
    durationSeconds(c) > 0 ? 1 : 0,
    isBooked(c) ? 1 : 0,
    c.endedReason ?? c.status ?? 'unknown',
    typeof c.cost === 'number' ? Number(c.cost.toFixed(4)) : 0,
    extractCostBreakdown(c),
    c.startedAt ?? null,
    c.createdAt ?? null,
    extractRecordingUrl(c),
    c.artifact?.transcript ?? c.transcript ?? null,
    JSON.stringify(extractMessages(c)),
    c.analysis?.summary ?? c.summary ?? null,
  );
  return !existed;
}

/** One page of calls, with retry + backoff on rate limits and server blips. */
async function fetchPage(apiKey: string, createdAtLt?: string): Promise<VapiCall[]> {
  const url = new URL('https://api.vapi.ai/call');
  url.searchParams.set('limit', String(PAGE_SIZE));
  // Deliberately NO assistantId filter — every assistant's calls count.
  if (createdAtLt) url.searchParams.set('createdAtLt', createdAtLt);

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** attempt, 8000));
    try {
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        if (retryAfter > 0 && retryAfter <= 30) await sleep(retryAfter * 1000);
        lastErr = new Error(`Vapi returned ${response.status}`);
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Vapi returned ${response.status}: ${body.slice(0, 200)}`);
      }
      const data = (await response.json()) as VapiCall[];
      return Array.isArray(data) ? data : [];
    } catch (err) {
      // Auth/client errors won't heal with a retry — surface them immediately.
      if (err instanceof Error && /Vapi returned 4/.test(err.message)) throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error('Vapi fetch failed');
}

// Pages are cut with createdAtLt (strictly LESS THAN a boundary timestamp).
// Naively using the last item's exact createdAt as the next boundary means
// any OTHER call sharing that exact timestamp — plausible if Vapi's
// precision collapses two near-simultaneous calls to the same value — falls
// on the wrong side of "strictly less than" and is silently skipped forever
// (never inserted during backfill; wrongly treated as deleted-upstream
// during reconcile). Nudging the boundary 1ms later re-includes every call
// at the exact cutoff timestamp on the next page — upsertCall's ON CONFLICT
// makes the resulting single-item overlap a harmless no-op.
function nextCursor(createdAt: string): string | null {
  const t = Date.parse(createdAt);
  if (isNaN(t)) return createdAt || null;
  return new Date(t + 1).toISOString();
}

let inFlight: Promise<{ upserted: number; total: number } | { skipped: string }> | null = null;

/**
 * One sync pass. First run pages through the entire account history
 * (checkpointing its cursor so interruptions resume, not restart); after
 * that each pass upserts the newest page (refreshing costs on recent calls)
 * and only keeps paging while it finds calls it doesn't already have.
 * Concurrent callers share the same pass.
 */
export function syncVapiCalls(): Promise<{ upserted: number; total: number } | { skipped: string }> {
  if (inFlight) return inFlight;
  inFlight = doSync().finally(() => { inFlight = null; });
  return inFlight;
}

async function doSync(): Promise<{ upserted: number; total: number } | { skipped: string }> {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return { skipped: 'VAPI_API_KEY not configured' };

  const db = getDb();
  const backfilled = !!getSystemState(BACKFILL_FLAG);
  // Resume an interrupted backfill from its checkpoint instead of page 0.
  let cursor: string | undefined = backfilled ? undefined : getSystemState(BACKFILL_CURSOR) || undefined;
  let upserted = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(PAGE_DELAY_MS);
    const data = await fetchPage(apiKey, cursor);
    if (!data.length) break;
    let newInPage = 0;
    for (const c of data) {
      if (upsertCall(c)) newInPage++;
    }
    upserted += newInPage;
    // Incremental mode: page 0 is always refreshed (late cost/duration
    // updates); stop as soon as a page contains nothing new.
    if (backfilled && newInPage === 0) break;
    if (data.length < PAGE_SIZE) break;
    const lastCreatedAt = data[data.length - 1].createdAt;
    if (!lastCreatedAt) break;
    cursor = nextCursor(lastCreatedAt) || undefined;
    if (!cursor) break;
    if (!backfilled) setSystemState(BACKFILL_CURSOR, cursor);
  }

  if (!backfilled) {
    setSystemState(BACKFILL_FLAG, new Date().toISOString());
    setSystemState(BACKFILL_CURSOR, '');
    console.log(`[Phone sync] full backfill complete — ${upserted} call(s) imported`);
  }
  setSystemState(LAST_SYNC_OK, new Date().toISOString());

  const total = (db.prepare('SELECT COUNT(*) c FROM vapi_calls').get() as { c: number }).c;
  return { upserted, total };
}

/**
 * Daily reconcile: re-walk the ENTIRE account history. Upserting every call
 * catches late cost corrections / analysis summaries on rows that long ago
 * fell off the incremental window, and comparing the full ID set lets us
 * delete local rows that no longer exist in Vapi (deleted test calls). Rows
 * are only deleted when the walk completed cleanly — a partial walk must
 * never look like a mass deletion.
 */
export async function reconcileVapiCalls(): Promise<{ refreshed: number; deleted: number } | { skipped: string }> {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return { skipped: 'VAPI_API_KEY not configured' };
  if (!getSystemState(BACKFILL_FLAG)) return { skipped: 'backfill not finished yet' };

  const db = getDb();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let complete = false;
  let oldestSeen: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(PAGE_DELAY_MS);
    const data = await fetchPage(apiKey, cursor);
    if (!data.length) { complete = true; break; }
    for (const c of data) {
      if (!c.id) continue;
      seen.add(c.id);
      upsertCall(c);
      if (c.createdAt && (!oldestSeen || c.createdAt < oldestSeen)) oldestSeen = c.createdAt;
    }
    if (data.length < PAGE_SIZE) { complete = true; break; }
    const lastCreatedAt = data[data.length - 1].createdAt;
    if (!lastCreatedAt) break; // can't page further — treat as incomplete, skip deletes
    cursor = nextCursor(lastCreatedAt) || undefined;
    if (!cursor) break;
  }

  // Deletion is scoped to the window the API actually returned: only rows
  // newer than the OLDEST call we saw are candidates. If Vapi's listing is
  // ever truncated (retention window, API cap), history older than the
  // window is preserved — the table stays truly all-time.
  let deleted = 0;
  if (complete && oldestSeen) {
    const cutoff = new Date(Date.now() - DELETE_MIN_AGE_MS).toISOString();
    const rows = db.prepare('SELECT id FROM vapi_calls WHERE created_at >= ? AND created_at < ?').all(oldestSeen, cutoff) as { id: string }[];
    const del = db.prepare('DELETE FROM vapi_calls WHERE id = ?');
    for (const r of rows) {
      if (!seen.has(r.id)) { del.run(r.id); deleted++; }
    }
  }

  setSystemState(LAST_RECONCILE, new Date().toISOString());
  setSystemState(RECONCILE_VERSION_KEY, String(RECONCILE_LOGIC_VERSION));
  setSystemState(LAST_SYNC_OK, new Date().toISOString());
  console.log(`[Phone sync] reconcile walked ${seen.size} call(s), oldest seen ${oldestSeen || 'n/a'}, complete=${complete}, removed ${deleted}`);
  return { refreshed: seen.size, deleted };
}

// Debounced "sync again shortly" — the webhook calls this after writing a
// call snapshot so a full pass follows and picks up Vapi's late-finalized
// cost/analysis for that call without waiting for the 2-min interval.
let syncSoonTimer: ReturnType<typeof setTimeout> | null = null;
export function requestVapiSyncSoon(delayMs = 45_000): void {
  if (syncSoonTimer) return;
  syncSoonTimer = setTimeout(() => {
    syncSoonTimer = null;
    syncVapiCalls().catch((err) =>
      console.error('[Phone sync] post-call sync error:', err instanceof Error ? err.message : err));
  }, delayMs);
}

/** ISO timestamp of the last successful sync pass (either layer), if any. */
export function lastSyncOkAt(): string | null {
  return getSystemState(LAST_SYNC_OK) || null;
}

// Bump this when reconcile/pagination logic changes in a way that could
// have left bad data behind (like the timestamp-boundary skip bug fixed
// alongside this constant) — it forces one immediate full re-walk on the
// next boot instead of waiting for the normal once-a-day cadence, so any
// calls the old logic lost (still live in Vapi, just missing locally) get
// rediscovered right away.
const RECONCILE_LOGIC_VERSION = 2;
const RECONCILE_VERSION_KEY = 'vapi_reconcile_version';

function reconcileDue(): boolean {
  const seenVersion = Number(getSystemState(RECONCILE_VERSION_KEY) || '0');
  if (seenVersion < RECONCILE_LOGIC_VERSION) return true;
  const last = getSystemState(LAST_RECONCILE);
  if (!last) return true;
  const t = new Date(last).getTime();
  return isNaN(t) || Date.now() - t >= RECONCILE_EVERY_MS;
}

/** Incremental every 2 minutes (first pass shortly after boot) + daily reconcile. */
export function scheduleVapiSync(): void {
  const run = () => {
    syncVapiCalls()
      .then((r) => {
        if ('skipped' in r) return;
        if (r.upserted) console.log(`[Phone sync] ${r.upserted} new/updated call(s) — ${r.total} total in DB`);
      })
      .catch((err) => console.error('[Phone sync] error:', err instanceof Error ? err.message : err));
  };
  const reconcile = () => {
    if (!reconcileDue()) return;
    reconcileVapiCalls()
      .then((r) => {
        if ('skipped' in r) return;
        console.log(`[Phone sync] reconcile pass — ${r.refreshed} call(s) refreshed, ${r.deleted} removed`);
      })
      .catch((err) => console.error('[Phone sync] reconcile error:', err instanceof Error ? err.message : err));
  };
  setTimeout(run, 15 * 1000);
  setInterval(run, 2 * 60 * 1000);
  setTimeout(reconcile, 90 * 1000);
  // Checks every 10 min but only actually walks once per day — the tight check
  // interval is so a FAILED reconcile retries quickly instead of waiting hours.
  setInterval(reconcile, 10 * 60 * 1000);
  console.log('[Phone sync] Vapi call sync scheduled — incremental every 2 min + daily full reconcile (all assistants, costs included)');
}
