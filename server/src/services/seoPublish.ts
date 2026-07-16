import { getDb } from '../db/schema';
import { linkPageIntoSiteNav, liveUrlForPath, unlinkPageFromSiteNav, resetAndRebuildNav, sectionForType } from './seoNav';
import { commitImagesForContent } from './seo/images';
import { getSystemState, setSystemState } from '../db/queries';

const TAG = '[SEO Agent]';
const NAV_REBUILT_KEY = 'seo_nav_rebuilt_v3';

interface ContentRow {
  id: number;
  title: string;
  content: string;
  file_path: string;
  status: string;
  committed: number;
  type: string;
  nav_label: string | null;
  nav_group: string | null;
}

/**
 * Make sure the destination folder (locations/, insights/, services/, …) exists
 * in the repo before we commit a page into it. Git has no empty folders, so we
 * materialize the folder by committing a simple `index.html` landing placeholder
 * the first time we publish into it. Never throws — a failed folder-ensure just
 * falls through to the page commit (which itself creates the folder implicitly).
 */
async function ensureRepoFolder(
  repo: string,
  branch: string,
  headers: Record<string, string>,
  filePath: string,
): Promise<void> {
  const slash = filePath.lastIndexOf('/');
  if (slash < 0) return; // root-level file — no folder to create
  const folder = filePath.slice(0, slash);
  const marker = `${folder}/index.html`;
  const getUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(marker)}?ref=${branch}`;

  try {
    console.log(TAG, `Folder check → GET ${getUrl}`);
    const res = await fetch(getUrl, { headers, signal: AbortSignal.timeout(20000) });
    console.log(TAG, `Folder check "${folder}/" → HTTP ${res.status}`);
    if (res.ok) return; // folder already has an index.html — nothing to do
    if (res.status !== 404) {
      console.warn(TAG, `Folder check for "${folder}/" was inconclusive (HTTP ${res.status}) — proceeding to page commit`);
      return;
    }

    const title = folder.split('/').pop() || 'Pages';
    const label = title.charAt(0).toUpperCase() + title.slice(1);
    const placeholder = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${label}</title></head>
<body><h1>${label}</h1><p>Pages in this section are published here by Lauren.</p></body>
</html>`;
    const putUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(marker)}`;
    console.log(TAG, `Folder "${folder}/" missing → creating placeholder PUT ${putUrl}`);
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Lauren: create ${folder}/ section`,
        content: Buffer.from(placeholder).toString('base64'),
        branch,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (putRes.ok) {
      console.log(TAG, `Created folder "${folder}/" (placeholder ${marker} committed)`);
    } else {
      const err = await putRes.text().catch(() => '');
      console.warn(TAG, `Folder create for "${folder}/" failed: HTTP ${putRes.status} ${err.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(TAG, `ensureRepoFolder("${folder}/") error:`, err instanceof Error ? err.message : err);
  }
}

export async function publishContentToGithub(
  contentId: number,
): Promise<{ success: boolean; message: string; liveUrl?: string | null; navLinked?: boolean }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    return { success: false, message: 'GITHUB_TOKEN or SEO_GITHUB_REPO not configured' };
  }

  const db = getDb();
  const item = db.prepare(
    'SELECT id, title, content, file_path, status, committed, type, nav_label, nav_group FROM seo_content WHERE id = ?',
  ).get(contentId) as ContentRow | undefined;

  if (!item) return { success: false, message: 'Content not found' };
  if (item.committed) return { success: false, message: 'Already published' };
  if (item.status === 'denied') return { success: false, message: 'Content was denied' };
  if (item.status === 'pending_review') {
    return { success: false, message: 'Approve content before publishing' };
  }
  if (!item.file_path) return { success: false, message: 'No file path set' };

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'TotallyOutdoorsSEOAgent/1.0',
  };

  try {
    console.log(TAG, `── Publish start: content #${item.id} "${item.title}" (${item.type}) → repo=${repo}@${branch} path="${item.file_path}"`);

    // Make sure the destination section folder exists before we write into it.
    await ensureRepoFolder(repo, branch, headers, item.file_path);

    // Commit this page's AI images to the repo and rewrite <img> src from the
    // preview endpoint to the live production URLs before publishing the page.
    let pageHtml = item.content;
    try {
      const imgResult = await commitImagesForContent(item.id, pageHtml);
      pageHtml = imgResult.html;
      console.log(TAG, `Images for #${item.id}: committed ${imgResult.committed} to repo`);
      if (imgResult.committed) {
        db.prepare('UPDATE seo_content SET content = ? WHERE id = ?').run(pageHtml, item.id);
      }
    } catch (err) {
      console.warn(TAG, `Image commit step failed for ${item.file_path}:`, err instanceof Error ? err.message : err);
    }

    const getUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(item.file_path)}?ref=${branch}`;
    console.log(TAG, `Existing-file check → GET ${getUrl}`);
    let sha: string | undefined;
    const getRes = await fetch(getUrl, { headers });
    console.log(TAG, `Existing-file check for "${item.file_path}" → HTTP ${getRes.status} (${getRes.ok ? 'update existing' : 'create new'})`);
    if (getRes.ok) {
      const existing = (await getRes.json()) as { sha?: string };
      sha = existing.sha;
    }

    const body: Record<string, string> = {
      message: `SEO Agent: Publish ${item.title}`,
      content: Buffer.from(pageHtml).toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    const putUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(item.file_path)}`;
    console.log(TAG, `Committing page → PUT ${putUrl} (${Buffer.byteLength(pageHtml)} bytes, ${sha ? 'with sha' : 'new file'})`);
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });

    if (!putRes.ok) {
      const err = await putRes.text();
      console.error(TAG, `GitHub publish FAILED for ${item.file_path}: HTTP ${putRes.status} ${err.slice(0, 400)}`);
      return { success: false, message: `GitHub error: ${putRes.status}` };
    }
    console.log(TAG, `GitHub commit OK for "${item.file_path}" → HTTP ${putRes.status}`);

    let newSha: string | null = null;
    try {
      const putData = (await putRes.json()) as { content?: { sha?: string } };
      newSha = putData.content?.sha ?? null;
    } catch { /* sha is best-effort */ }

    db.prepare(
      "UPDATE seo_content SET committed = 1, committed_at = CURRENT_TIMESTAMP, status = 'published', github_sha = ?, live_status = NULL, live_checked_at = NULL WHERE id = ?",
    ).run(newSha, contentId);

    const linked = db.prepare('SELECT plan_task_id FROM seo_content WHERE id = ?').get(contentId) as
      | { plan_task_id: number | null }
      | undefined;
    if (linked?.plan_task_id) {
      db.prepare(
        "UPDATE seo_weekly_plan SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).run(linked.plan_task_id);
    }

    const liveUrl = liveUrlForPath(item.file_path);

    // Tell Google about the new page right away: refresh + submit the sitemap
    // (best-effort — publish already succeeded regardless).
    import('./seo/indexStatus')
      .then((m) => m.updateSitemap())
      .then((r) => { if (!r.ok) console.log(TAG, 'sitemap refresh skipped:', r.message); })
      .catch((err) => console.warn(TAG, 'sitemap refresh failed:', err instanceof Error ? err.message : err));

    // Wire the page into the site nav UNDER THE RIGHT SECTION (dropdown / new section).
    let navLinked = false;
    if (item.type !== 'meta' && item.type !== 'schema') {
      const label = item.nav_label || item.title;

      if (!getSystemState(NAV_REBUILT_KEY)) {
        // ONE-TIME migration: the early runs left stray plain nav tabs. Strip all
        // of Lauren's old nav artifacts and rebuild clean dropdowns for every
        // currently-published page (this one included — it's already committed=1).
        console.log(TAG, 'One-time nav cleanup + rebuild starting (first publish on the new nav system)…');
        const published = db.prepare(
          "SELECT title, file_path, nav_label, nav_group, type FROM seo_content WHERE committed = 1 AND file_path IS NOT NULL",
        ).all() as { title: string; file_path: string; nav_label: string | null; nav_group: string | null; type: string }[];
        const pages = published.map((p) => ({
          filePath: p.file_path,
          label: p.nav_label || p.title,
          section: p.nav_group || sectionForType(p.type, null),
        }));
        const rebuilt = await resetAndRebuildNav(pages);
        setSystemState(NAV_REBUILT_KEY, new Date().toISOString());
        navLinked = rebuilt.success && rebuilt.changed;
        if (navLinked) db.prepare('UPDATE seo_content SET nav_linked = 1 WHERE committed = 1').run();
        console.log(TAG, `One-time nav rebuild: ${rebuilt.message}`);
      } else {
        // Normal path: add just this page into its section dropdown.
        console.log(TAG, `Nav link start for "${item.file_path}" → href="${liveUrl}" label="${label}" section="${item.nav_group || '(auto)'}"`);
        const navResult = await linkPageIntoSiteNav({
          filePath: item.file_path,
          label,
          section: item.nav_group,
          type: item.type,
        });
        navLinked = navResult.linked;
        if (navResult.linked) {
          db.prepare('UPDATE seo_content SET nav_linked = 1 WHERE id = ?').run(contentId);
          console.log(TAG, `Nav link OK for "${item.file_path}": ${navResult.message}`);
        } else {
          console.warn(TAG, `Nav link NOT applied for "${item.file_path}": ${navResult.message}`);
        }
      }
    }

    console.log(TAG, `── Publish complete: "${item.file_path}" (live: ${liveUrl || 'n/a'}, navLinked=${navLinked})`);
    return { success: true, message: `Published ${item.file_path}`, liveUrl, navLinked };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(TAG, `Publish error for ${item.file_path}:`, err);
    return { success: false, message: msg };
  }
}

/** Remove a published page from the repo: delete its HTML file from GitHub,
 *  unlink it from the site nav, drop its images, and remove the DB row. Powers
 *  the dashboard "X" (remove) button. */
export async function unpublishContentFromGithub(
  contentId: number,
): Promise<{ success: boolean; message: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';

  const db = getDb();
  const item = db.prepare('SELECT id, title, file_path, committed FROM seo_content WHERE id = ?').get(contentId) as
    | { id: number; title: string; file_path: string | null; committed: number }
    | undefined;
  if (!item) return { success: false, message: 'Content not found' };

  // Delete the page file from the repo (only if it was actually published).
  if (item.committed && item.file_path) {
    if (!token || !repo) return { success: false, message: 'GITHUB_TOKEN or SEO_GITHUB_REPO not configured' };
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'TotallyOutdoorsSEOAgent/1.0',
    };
    try {
      const getUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(item.file_path)}?ref=${branch}`;
      console.log(TAG, `Remove: GET sha ${getUrl}`);
      const getRes = await fetch(getUrl, { headers, signal: AbortSignal.timeout(20000) });
      if (getRes.ok) {
        const meta = (await getRes.json()) as { sha?: string };
        if (meta.sha) {
          const delUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(item.file_path)}`;
          console.log(TAG, `Remove: DELETE ${delUrl}`);
          const delRes = await fetch(delUrl, {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ message: `Lauren: remove ${item.file_path}`, sha: meta.sha, branch }),
            signal: AbortSignal.timeout(25000),
          });
          if (!delRes.ok) {
            const err = await delRes.text().catch(() => '');
            console.error(TAG, `Remove FAILED for ${item.file_path}: HTTP ${delRes.status} ${err.slice(0, 300)}`);
            return { success: false, message: `GitHub delete error: ${delRes.status}` };
          }
          console.log(TAG, `Remove: deleted ${item.file_path} from repo`);
        }
      } else if (getRes.status === 404) {
        console.log(TAG, `Remove: ${item.file_path} already absent from repo — cleaning up DB only`);
      } else {
        console.warn(TAG, `Remove: sha lookup returned HTTP ${getRes.status} — proceeding with DB cleanup`);
      }
    } catch (err) {
      console.error(TAG, `Remove error for ${item.file_path}:`, err instanceof Error ? err.message : err);
      return { success: false, message: 'GitHub delete request failed' };
    }

    // Best-effort: remove its link from the site nav (and collapse an empty dropdown).
    try {
      const nav = await unlinkPageFromSiteNav(item.file_path);
      console.log(TAG, `Remove: nav unlink — ${nav.message}`);
    } catch (err) {
      console.warn(TAG, 'Remove: nav unlink failed:', err instanceof Error ? err.message : err);
    }
  }

  // Drop images + the content row so it disappears from the dashboard entirely.
  db.prepare('DELETE FROM seo_images WHERE content_id = ?').run(contentId);
  db.prepare('DELETE FROM seo_content WHERE id = ?').run(contentId);
  console.log(TAG, `Remove complete: content #${contentId} "${item.title}"`);
  return { success: true, message: `Removed ${item.file_path || item.title}` };
}

/** Verify a published page actually resolves on the live site (catches the
 *  repo-path ≠ public-URL 404 class). Stores the HTTP status on the row. */
export async function checkLiveStatus(
  contentId: number,
): Promise<{ success: boolean; status: number | null; liveUrl: string | null; ok: boolean }> {
  const db = getDb();
  const row = db.prepare('SELECT id, file_path, committed FROM seo_content WHERE id = ?').get(contentId) as
    | { id: number; file_path: string | null; committed: number }
    | undefined;
  if (!row) return { success: false, status: null, liveUrl: null, ok: false };

  const liveUrl = liveUrlForPath(row.file_path);
  if (!liveUrl) return { success: false, status: null, liveUrl: null, ok: false };

  let status: number | null = null;
  try {
    let res = await fetch(liveUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(12000) });
    // Some hosts reject HEAD — fall back to a lightweight GET.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(liveUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12000) });
    }
    status = res.status;
  } catch (err) {
    console.warn(TAG, `Live check failed for ${liveUrl}:`, err instanceof Error ? err.message : err);
  }

  const label = status == null ? 'unreachable' : status >= 200 && status < 400 ? `live:${status}` : `error:${status}`;
  db.prepare('UPDATE seo_content SET live_status = ?, live_checked_at = CURRENT_TIMESTAMP WHERE id = ?').run(label, contentId);

  return { success: true, status, liveUrl, ok: status != null && status >= 200 && status < 400 };
}

/** Re-check every published page's live status (used by the dashboard sweep). */
export async function checkAllLiveStatuses(): Promise<{ checked: number; ok: number; broken: number }> {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM seo_content WHERE committed = 1").all() as { id: number }[];
  let ok = 0;
  let broken = 0;
  for (const r of rows) {
    const result = await checkLiveStatus(r.id);
    if (result.ok) ok++;
    else if (result.status != null) broken++;
  }
  return { checked: rows.length, ok, broken };
}

export async function publishDueContent(): Promise<number> {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const due = db.prepare(`
    SELECT id FROM seo_content
    WHERE status = 'approved' AND committed = 0
      AND scheduled_for IS NOT NULL AND scheduled_for <= ?
    ORDER BY scheduled_for ASC
  `).all(today) as { id: number }[];

  let count = 0;
  for (const row of due) {
    const result = await publishContentToGithub(row.id);
    if (result.success) count++;
  }
  if (count) console.log(TAG, `Scheduled publish: ${count} file(s) uploaded`);
  return count;
}
