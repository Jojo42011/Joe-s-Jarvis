/**
 * Google indexing pipeline for Lauren's pages — the step that was missing:
 *
 *  1. updateSitemap(): regenerates sitemap.xml from every HTML page in the
 *     website repo (Lauren's pages + hand-made ones), commits it, and submits
 *     it to Search Console so Google is told about new pages immediately
 *     instead of waiting on its own crawl.
 *  2. checkIndexStatus(): asks the Search Console URL Inspection API for the
 *     TRUE index status of each published page and stamps it on the row —
 *     the dashboard's "Indexed by Google" count comes from this, not from
 *     assuming published == indexed.
 *
 * Both degrade gracefully: no GitHub token → sitemap skipped; no Search
 * Console account/scope → submit/inspect skipped with a clear log line.
 * Runs daily (plus shortly after boot) and the sitemap also refreshes right
 * after every publish.
 */

import { google } from 'googleapis';
import { getDb } from '../../db/schema';
import { getAuthorizedClient } from '../google/auth';
import { resolveSite } from '../google/searchConsole';
import { listRepoHtmlFiles } from '../seoTemplate';

const TAG = '[Indexing]';

function siteBase(): string {
  return (process.env.SEO_WEBSITE_URL || 'https://www.totallyoutdoorsllc.com').replace(/\/+$/, '');
}

function pathToUrl(filePath: string): string {
  let p = filePath.replace(/^\/+/, '');
  if (p === 'index.html') return `${siteBase()}/`;
  p = p.replace(/\/index\.html$/i, '/');
  return `${siteBase()}/${p}`;
}

/** Regenerate sitemap.xml from the repo's HTML pages, commit it, submit to GSC. */
export async function updateSitemap(): Promise<{ ok: boolean; pages?: number; submitted?: boolean; message: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  if (!token || !repo) return { ok: false, message: 'GITHUB_TOKEN or SEO_GITHUB_REPO not configured' };

  let files: string[];
  try {
    files = await listRepoHtmlFiles(repo, branch, token);
  } catch (err) {
    return { ok: false, message: `repo listing failed: ${err instanceof Error ? err.message : err}` };
  }
  const urls = Array.from(new Set(
    files
      .filter((f) => !/template|partial|snippet/i.test(f))
      .map(pathToUrl),
  )).sort();
  if (!urls.length) return { ok: false, message: 'no pages found in repo' };

  const today = new Date().toISOString().slice(0, 10);
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
    '\n</urlset>\n';

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'TotallyOutdoorsSEOAgent/1.0',
  };
  try {
    // Only commit when the content actually changed (ignoring lastmod churn is
    // overkill — a daily lastmod bump is fine and cheap).
    let sha: string | undefined;
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/sitemap.xml?ref=${branch}`, { headers });
    if (getRes.ok) {
      const existing = (await getRes.json()) as { sha?: string; content?: string };
      sha = existing.sha;
      const current = Buffer.from(existing.content || '', 'base64').toString('utf8');
      if (current === xml) return { ok: true, pages: urls.length, submitted: false, message: 'sitemap unchanged' };
    }
    const body: Record<string, string> = {
      message: `SEO Agent: Update sitemap.xml (${urls.length} pages)`,
      content: Buffer.from(xml).toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/sitemap.xml`, {
      method: 'PUT', headers, body: JSON.stringify(body),
    });
    if (!putRes.ok) {
      const err = await putRes.text().catch(() => '');
      return { ok: false, message: `sitemap commit failed: HTTP ${putRes.status} ${err.slice(0, 150)}` };
    }
  } catch (err) {
    return { ok: false, message: `sitemap commit error: ${err instanceof Error ? err.message : err}` };
  }

  // Tell Search Console about it (needs the full webmasters scope — if the
  // account only granted read-only, log and move on; the committed sitemap
  // still gets picked up via robots/crawl).
  let submitted = false;
  try {
    const resolved = await resolveSite();
    if (resolved) {
      const auth = getAuthorizedClient(resolved.email);
      if (auth) {
        const sc = google.searchconsole({ version: 'v1', auth });
        await sc.sitemaps.submit({ siteUrl: resolved.siteUrl, feedpath: `${siteBase()}/sitemap.xml` });
        submitted = true;
      }
    }
  } catch (err) {
    console.warn(TAG, 'sitemap submit to Search Console failed (read-only scope?):', err instanceof Error ? err.message : err);
  }

  console.log(TAG, `sitemap.xml updated — ${urls.length} pages${submitted ? ', submitted to Search Console' : ''}`);
  return { ok: true, pages: urls.length, submitted, message: 'sitemap updated' };
}

function simplifyCoverage(verdict?: string | null, coverage?: string | null): string {
  if (verdict === 'PASS') return 'indexed';
  const c = (coverage || '').toLowerCase();
  if (c.includes('indexed')) {
    return c.includes('not indexed') ? 'crawled_not_indexed' : 'indexed';
  }
  if (c.includes('unknown to google')) return 'not_found';
  if (c.includes('discovered')) return 'discovered_not_indexed';
  if (c.includes('crawled')) return 'crawled_not_indexed';
  return coverage ? coverage.slice(0, 60) : 'unknown';
}

/** Stamp each published page with its real Google index status. */
export async function checkIndexStatus(): Promise<{ checked: number; indexed: number; message: string }> {
  const resolved = await resolveSite();
  if (!resolved) return { checked: 0, indexed: 0, message: 'Search Console not connected' };
  const auth = getAuthorizedClient(resolved.email);
  if (!auth) return { checked: 0, indexed: 0, message: 'account not authorized' };

  const db = getDb();
  const pages = db.prepare(
    "SELECT id, file_path FROM seo_content WHERE committed = 1 AND file_path IS NOT NULL",
  ).all() as { id: number; file_path: string }[];
  if (!pages.length) return { checked: 0, indexed: 0, message: 'no published pages' };

  const sc = google.searchconsole({ version: 'v1', auth });
  let checked = 0;
  let indexed = 0;
  for (const page of pages) {
    try {
      const resp = await sc.urlInspection.index.inspect({
        requestBody: { inspectionUrl: pathToUrl(page.file_path), siteUrl: resolved.siteUrl },
      });
      const result = resp.data.inspectionResult?.indexStatusResult;
      const status = simplifyCoverage(result?.verdict, result?.coverageState);
      db.prepare('UPDATE seo_content SET index_status = ?, index_checked_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(status, page.id);
      checked++;
      if (status === 'indexed') indexed++;
      // URL Inspection quota is generous (2000/day) but stay polite.
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      console.warn(TAG, `inspect failed for ${page.file_path}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(TAG, `index check — ${indexed}/${checked} published pages verified indexed by Google`);
  return { checked, indexed, message: 'ok' };
}

/** Daily sweep: refresh the sitemap, then verify index status per page. */
export async function runIndexingSweep(): Promise<void> {
  try {
    const sm = await updateSitemap();
    if (!sm.ok) console.log(TAG, 'sitemap step skipped:', sm.message);
  } catch (err) {
    console.error(TAG, 'sitemap step error:', err instanceof Error ? err.message : err);
  }
  try {
    await checkIndexStatus();
  } catch (err) {
    console.error(TAG, 'index check error:', err instanceof Error ? err.message : err);
  }
}

export function scheduleIndexingSweep(): void {
  const run = () => { runIndexingSweep().catch((err) => console.error(TAG, 'sweep error:', err)); };
  setTimeout(run, 6 * 60 * 1000);
  setInterval(run, 24 * 60 * 60 * 1000);
  console.log(TAG, 'Scheduled — sitemap refresh + URL Inspection index check daily (first pass 6 min after boot)');
}
