import { google } from 'googleapis';
import { getAuthorizedClient } from './auth';
import { listGoogleAccounts } from '../../db/google';
import { getDb } from '../../db/schema';

const TAG = '[GSC]';

function siteCandidates(): string[] {
  const url = (process.env.SEO_WEBSITE_URL || 'https://aquaticpoolaz.com').replace(/\/+$/, '');
  const host = url.replace(/^https?:\/\//, '');
  return [`${url}/`, url, `sc-domain:${host}`];
}

/** Find a connected account that owns the site in Search Console. */
export async function resolveSite(): Promise<{ email: string; siteUrl: string } | null> {
  const accounts = listGoogleAccounts().filter((a) => a.refresh_token);
  const wanted = siteCandidates().map((s) => s.toLowerCase());
  for (const acct of accounts) {
    const auth = getAuthorizedClient(acct.email);
    if (!auth) continue;
    try {
      const sc = google.searchconsole({ version: 'v1', auth });
      const sites = await sc.sites.list();
      for (const s of sites.data.siteEntry || []) {
        const u = (s.siteUrl || '').toLowerCase();
        if (wanted.includes(u) || wanted.some((w) => u.includes(w.replace('sc-domain:', '')))) {
          return { email: acct.email, siteUrl: s.siteUrl! };
        }
      }
    } catch (err) {
      console.warn(TAG, `sites.list failed for ${acct.email}:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

export interface GscSyncResult {
  connected: boolean;
  site?: string;
  account?: string;
  rows?: number;
  updatedKeywords?: number;
  message: string;
}

/**
 * Pull REAL Search Console data (query, clicks, impressions, ctr, position) for
 * the last 28 days, cache it, and write true Google rankings back onto the tracked
 * keywords. Requires a connected account that owns the property + the
 * webmasters.readonly scope (re-consent after the scope was added).
 */
export async function syncSearchConsole(): Promise<GscSyncResult> {
  const resolved = await resolveSite();
  if (!resolved) {
    return { connected: false, message: 'No connected Google account owns this Search Console property (or webmasters scope not granted — re-connect the account that owns the site).' };
  }
  const { email, siteUrl } = resolved;
  const auth = getAuthorizedClient(email);
  if (!auth) return { connected: false, message: 'Account not authorized' };

  const sc = google.searchconsole({ version: 'v1', auth });
  let rows: { keys?: string[] | null; clicks?: number | null; impressions?: number | null; ctr?: number | null; position?: number | null }[] = [];
  try {
    const resp = await sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: isoDaysAgo(28),
        endDate: isoDaysAgo(1),
        dimensions: ['query'],
        rowLimit: 200,
      },
    });
    rows = resp.data.rows || [];
  } catch (err) {
    return { connected: false, site: siteUrl, account: email, message: `searchanalytics.query failed: ${err instanceof Error ? err.message : err}` };
  }

  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const upsertMetric = db.prepare(`
    INSERT INTO gsc_metrics (query, page, clicks, impressions, ctr, position, fetched_for)
    VALUES (@query, NULL, @clicks, @impressions, @ctr, @position, @fetched_for)
    ON CONFLICT(query, fetched_for) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, position=excluded.position
  `);
  const findKw = db.prepare('SELECT id FROM seo_keywords WHERE lower(keyword) = lower(?)');
  const updKw = db.prepare("UPDATE seo_keywords SET our_ranking = ?, monthly_volume = COALESCE(monthly_volume, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  const insKw = db.prepare("INSERT INTO seo_keywords (keyword, our_ranking, monthly_volume, opportunity_score) VALUES (?, ?, ?, ?)");

  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const query = (r.keys && r.keys[0]) ? r.keys[0] : '';
      if (!query) continue;
      const position = r.position != null ? Math.round(r.position * 10) / 10 : null;
      upsertMetric.run({
        query, clicks: r.clicks || 0, impressions: r.impressions || 0,
        ctr: r.ctr || 0, position, fetched_for: today,
      });
      const rankStr = position != null ? String(Math.round(position)) : 'unranked';
      const volStr = r.impressions != null ? `${Math.round(r.impressions)}/mo (impr.)` : null;
      const existing = findKw.get(query) as { id: number } | undefined;
      if (existing) {
        updKw.run(rankStr, volStr, existing.id);
        updated++;
      } else if (updated < 200) {
        // Track high-impression queries we didn't know about, with REAL rank.
        const opp = r.impressions ? Math.min(1, (r.impressions as number) / 1000) : 0;
        insKw.run(query, rankStr, volStr, opp);
      }
    }
  });
  tx();

  console.log(TAG, `Synced ${rows.length} queries from ${siteUrl} (${email}); ${updated} tracked keywords updated with real rank`);
  return { connected: true, site: siteUrl, account: email, rows: rows.length, updatedKeywords: updated, message: `Real Search Console data synced for ${siteUrl}` };
}

/** Summary of the latest real GSC data for the dashboard. */
export function gscSummary() {
  const db = getDb();
  const latest = db.prepare('SELECT MAX(fetched_for) as d FROM gsc_metrics').get() as { d: string | null };
  const day = latest?.d;
  if (!day) return { connected: false as const };
  const agg = db.prepare(
    'SELECT COUNT(*) queries, SUM(clicks) clicks, SUM(impressions) impressions, AVG(position) avgPosition FROM gsc_metrics WHERE fetched_for = ?'
  ).get(day) as { queries: number; clicks: number; impressions: number; avgPosition: number };
  const top = db.prepare(
    'SELECT query, clicks, impressions, ctr, position FROM gsc_metrics WHERE fetched_for = ? ORDER BY clicks DESC, impressions DESC LIMIT 12'
  ).all(day) as { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  // Clicks/impressions over time (by fetch date) for a clean real trend.
  const trend = db.prepare(
    'SELECT fetched_for date, SUM(clicks) clicks, SUM(impressions) impressions, AVG(position) avgPosition FROM gsc_metrics GROUP BY fetched_for ORDER BY fetched_for ASC LIMIT 60'
  ).all() as { date: string; clicks: number; impressions: number; avgPosition: number }[];
  return {
    connected: true as const,
    lastSync: day,
    totals: {
      queries: agg.queries || 0,
      clicks: Math.round(agg.clicks || 0),
      impressions: Math.round(agg.impressions || 0),
      avgPosition: agg.avgPosition ? Math.round(agg.avgPosition * 10) / 10 : null,
    },
    topQueries: top,
    trend,
  };
}
