import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { runSeoAgent, recoverStuckSeoRuns, forceResetRunningSeoRun, isSeoRunActiveInDb, wipeSeoDataForFreshStart } from '../services/seoAgent';
import { publishContentToGithub, unpublishContentFromGithub, checkLiveStatus, checkAllLiveStatuses } from '../services/seoPublish';
import { preparePreviewHtml } from '../services/geminiSeo';
import { liveUrlForPath } from '../services/seoNav';
import { enrichGeneratedPage } from '../services/seo/enrich';
import { getImageBytes } from '../services/seo/images';
import { auditPage } from '../services/seo/audit';
import { computeSiteHealth } from '../services/seo/siteHealth';
import { syncSearchConsole, gscSummary } from '../services/google/searchConsole';
import { getBusinessProfile } from '../services/seo/businessProfile';
import { safeJsonParse } from '../utils/safeJson';
import { extractCitySlug } from '../services/seoTemplate';

const router = Router();

interface SeoRun {
  id: number;
  status: string;
  phase: string | null;
  keywords_found: number;
  content_generated: number;
  commits_made: number;
  summary: string | null;
  weekly_plan: string | null;
  started_at: string;
  completed_at: string | null;
}

interface SeoKeyword {
  id: number;
  keyword: string;
  our_ranking: string;
  competitor: string | null;
  competitor_ranking: string | null;
  monthly_volume: string | null;
  opportunity_score: number;
}

interface SeoContent {
  id: number;
  type: string;
  title: string;
  content: string;
  target_keyword: string | null;
  file_path: string | null;
  status: string;
  committed: number;
  committed_at: string | null;
  scheduled_for: string | null;
  plan_task_id: number | null;
  approved_at: string | null;
  denied_at: string | null;
  created_at: string;
  seo_score: number | null;
  seo_grade: string | null;
  seo_report: string | null;
  meta_title: string | null;
  meta_description: string | null;
  schema_types: string | null;
  word_count: number | null;
  internal_links_out: number | null;
  eeat_score: number | null;
  github_sha: string | null;
  live_status: string | null;
  live_checked_at: string | null;
  index_status: string | null;
  index_checked_at: string | null;
}

// Compact per-page SEO summary attached to queue/performance rows.
function seoSummary(c: SeoContent): Record<string, unknown> {
  return {
    score: c.seo_score,
    grade: c.seo_grade,
    eeat: c.eeat_score,
    wordCount: c.word_count,
    internalLinks: c.internal_links_out,
    schemaTypes: (c.schema_types || '').split(',').filter(Boolean),
    metaTitle: c.meta_title,
    metaDescription: c.meta_description,
    liveStatus: c.live_status,
    liveCheckedAt: c.live_checked_at,
    indexStatus: c.index_status,
    indexCheckedAt: c.index_checked_at,
  };
}

interface SeoPlanRow {
  id: number;
  week_start: string;
  day: string;
  task: string;
  status: string;
  completed_at: string | null;
}

router.get('/seo/status', (_req: Request, res: Response) => {
  recoverStuckSeoRuns();
  const db = getDb();

  const lastRun = db.prepare('SELECT * FROM seo_runs ORDER BY started_at DESC LIMIT 1').get() as SeoRun | undefined;

  // Matches the actual scheduler cadence in crons.ts (daily; see SEO_RUN_INTERVAL_MS).
  let nextRun: string | null = null;
  if (lastRun?.started_at) {
    const d = new Date(lastRun.started_at.replace(' ', 'T') + 'Z');
    d.setDate(d.getDate() + 1);
    nextRun = d.toISOString();
  }

  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  const weekStart = monday.toISOString().split('T')[0];

  const weeklyPlan = db.prepare('SELECT * FROM seo_weekly_plan WHERE week_start = ? ORDER BY id').all(weekStart) as SeoPlanRow[];
  const keywords = db.prepare('SELECT * FROM seo_keywords ORDER BY opportunity_score DESC LIMIT 20').all() as SeoKeyword[];
  const contentQueue = db.prepare(`
    SELECT * FROM seo_content
    WHERE committed = 0 AND status NOT IN ('denied', 'published')
    ORDER BY
      CASE status WHEN 'pending_review' THEN 0 WHEN 'ready' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
      scheduled_for ASC,
      created_at DESC
  `).all() as SeoContent[];
  const recentCommits = db.prepare('SELECT * FROM seo_content WHERE committed = 1 ORDER BY committed_at DESC LIMIT 10').all() as SeoContent[];
  const competitors = db.prepare('SELECT domain, url, title FROM seo_competitors ORDER BY domain ASC').all() as {
    domain: string; url: string; title: string | null;
  }[];

  res.json({
    lastRun: lastRun ?? null,
    nextRun,
    weeklyPlan,
    keywords,
    contentQueue: contentQueue.map((c) => ({ ...c, seo: seoSummary(c), live_url: liveUrlForPath(c.file_path) })),
    recentCommits: recentCommits.map((c) => ({ ...c, seo: seoSummary(c), live_url: liveUrlForPath(c.file_path) })),
    competitors,
    runActive: isSeoRunActiveInDb(),
  });
});

router.post('/seo/reset', (_req: Request, res: Response) => {
  const cleared = forceResetRunningSeoRun();
  res.json({ success: true, cleared });
});

router.post('/seo/wipe', (_req: Request, res: Response) => {
  forceResetRunningSeoRun();
  const wiped = wipeSeoDataForFreshStart();
  res.json({ success: true, wiped });
});

router.post('/seo/run', (_req: Request, res: Response) => {
  recoverStuckSeoRuns();
  if (isSeoRunActiveInDb()) {
    res.status(409).json({ success: false, message: 'Atlas is already running' });
    return;
  }
  runSeoAgent().catch((err) => console.error('[SEO Agent] Manual run error:', err));
  res.json({ success: true, message: 'SEO agent started' });
});

router.get('/seo/plan', (_req: Request, res: Response) => {
  const db = getDb();
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  const weekStart = monday.toISOString().split('T')[0];

  const rows = db.prepare('SELECT * FROM seo_weekly_plan WHERE week_start = ? ORDER BY id').all(weekStart) as SeoPlanRow[];
  res.json(rows);
});

router.post('/seo/plan/:id/complete', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  db.prepare("UPDATE seo_weekly_plan SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  res.json({ success: true });
});

router.delete('/seo/plan/:id', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id FROM seo_weekly_plan WHERE id = ?').get(req.params.id);
  if (!row) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  db.prepare('DELETE FROM seo_weekly_plan WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/seo/content', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM seo_content ORDER BY created_at DESC').all() as SeoContent[];
  res.json(rows);
});

function serveSeoPreview(id: string, res: Response): void {
  const db = getDb();
  const row = db.prepare('SELECT id, type, content FROM seo_content WHERE id = ?').get(id) as
    | { id: number; type: string; content: string }
    | undefined;
  if (!row) {
    res.status(404).send('Content not found');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(preparePreviewHtml(row.content, row.type));
}

router.get('/seo/preview/:id', (req: Request, res: Response) => {
  serveSeoPreview(req.params.id, res);
});

router.get('/seo/content/:id/preview', (req: Request, res: Response) => {
  serveSeoPreview(req.params.id, res);
});

router.post('/seo/content/:id/approve', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id, status, committed FROM seo_content WHERE id = ?').get(req.params.id) as
    | { id: number; status: string; committed: number }
    | undefined;
  if (!row) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  if (row.committed) {
    res.status(400).json({ success: false, message: 'Already published' });
    return;
  }
  if (row.status === 'denied') {
    res.status(400).json({ success: false, message: 'Content was denied' });
    return;
  }
  db.prepare(
    "UPDATE seo_content SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(req.params.id);
  res.json({ success: true, message: 'Approved — will upload on scheduled date or use Upload Now' });
});

router.post('/seo/content/:id/deny', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id, committed FROM seo_content WHERE id = ?').get(req.params.id) as
    | { id: number; committed: number }
    | undefined;
  if (!row) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  if (row.committed) {
    res.status(400).json({ success: false, message: 'Cannot deny published content' });
    return;
  }
  db.prepare(
    "UPDATE seo_content SET status = 'denied', denied_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(req.params.id);
  res.json({ success: true, message: 'Denied' });
});

router.post('/seo/content/:id/publish', async (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id, status FROM seo_content WHERE id = ?').get(req.params.id) as
    | { id: number; status: string }
    | undefined;
  if (!row) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  if (row.status === 'pending_review' || row.status === 'ready') {
    db.prepare(
      "UPDATE seo_content SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(req.params.id);
  }
  const result = await publishContentToGithub(Number(req.params.id));
  if (!result.success) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

// Remove a published page from the repo (delete file + unlink nav + drop row).
router.post('/seo/content/:id/unpublish', async (req: Request, res: Response) => {
  const result = await unpublishContentFromGithub(Number(req.params.id));
  if (!result.success) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.delete('/seo/content/:id', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id, committed FROM seo_content WHERE id = ?').get(req.params.id) as
    | { id: number; committed: number }
    | undefined;
  if (!row) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  if (row.committed) {
    res.status(400).json({ success: false, message: 'Cannot delete committed content' });
    return;
  }
  db.prepare('DELETE FROM seo_content WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Serve a generated image for preview (bytes held on the server pre-publish) ─
router.get('/seo/img/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id).replace(/\.png$/i, ''), 10);
  if (!Number.isFinite(id)) {
    res.status(400).send('Bad image id');
    return;
  }
  const img = getImageBytes(id);
  if (!img) {
    res.status(404).send('Image not found');
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(img.buffer);
});

// ─── Per-page SEO audit report ──────────────────────────────────────────────
router.get('/seo/content/:id/audit', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM seo_content WHERE id = ?').get(req.params.id) as SeoContent | undefined;
  if (!row) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  let report = row.seo_report ? safeJsonParse(row.seo_report) : null;
  // Fall back to a live audit if this row predates scoring.
  if (!report) {
    const city = row.type === 'city_page'
      ? extractCitySlug(row.target_keyword || undefined, row.title).replace(/-/g, ' ')
      : undefined;
    report = auditPage(row.content || '', { keyword: row.target_keyword || undefined, type: row.type, city });
  }
  res.json({
    success: true,
    id: row.id,
    title: row.title,
    type: row.type,
    filePath: row.file_path,
    liveUrl: liveUrlForPath(row.file_path),
    status: row.status,
    committed: row.committed,
    liveStatus: row.live_status,
    report,
  });
});

// Re-score (and, for drafts, re-enrich) a single page.
router.post('/seo/content/:id/reaudit', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM seo_content WHERE id = ?').get(req.params.id) as SeoContent | undefined;
  if (!row) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  const slug = row.file_path
    ? (row.file_path.split('/').pop() || '').replace(/\.html?$/i, '')
    : undefined;
  const city = row.type === 'city_page'
    ? extractCitySlug(row.target_keyword || undefined, row.title).replace(/-/g, ' ')
    : undefined;

  if (!row.committed) {
    // Draft: re-enrich (meta + schema + links) and persist the improved HTML.
    const enriched = enrichGeneratedPage({
      html: row.content || '',
      type: row.type,
      keyword: row.target_keyword || undefined,
      task: row.title,
      city,
      slug,
      filePath: row.file_path || undefined,
    });
    const r = enriched.report;
    db.prepare(`
      UPDATE seo_content SET content = ?, seo_score = ?, seo_grade = ?, seo_report = ?, meta_title = ?,
        meta_description = ?, schema_types = ?, word_count = ?, internal_links_out = ?, eeat_score = ?
      WHERE id = ?
    `).run(
      enriched.html, r.score, r.grade, JSON.stringify(r), enriched.meta.title, enriched.meta.description,
      enriched.schemaTypes.join(','), r.signals.wordCount, r.signals.internalLinks, r.eeat.score, row.id,
    );
    res.json({ success: true, reEnriched: true, score: r.score, grade: r.grade, report: r });
    return;
  }

  // Committed: audit-only (never mutate published content).
  const report = auditPage(row.content || '', { keyword: row.target_keyword || undefined, type: row.type, city });
  db.prepare('UPDATE seo_content SET seo_score = ?, seo_grade = ?, seo_report = ?, eeat_score = ? WHERE id = ?')
    .run(report.score, report.grade, JSON.stringify(report), report.eeat.score, row.id);
  res.json({ success: true, reEnriched: false, score: report.score, grade: report.grade, report });
});

// Verify a published page resolves on the live site (404 catcher).
router.post('/seo/content/:id/live-check', async (req: Request, res: Response) => {
  const result = await checkLiveStatus(Number(req.params.id));
  if (!result.success) {
    res.status(404).json({ success: false, message: 'No published page / live URL for this item' });
    return;
  }
  res.json(result);
});

// Sweep every published page's live status.
router.post('/seo/live-check-all', async (_req: Request, res: Response) => {
  const result = await checkAllLiveStatuses();
  res.json({ success: true, ...result });
});

// Site-level SEO health (powers the hero ring).
router.get('/seo/health', (_req: Request, res: Response) => {
  res.json(computeSiteHealth());
});

// Business profile / NAP — surfaced in the dashboard's local-SEO panel.
router.get('/seo/business', (_req: Request, res: Response) => {
  res.json(getBusinessProfile());
});

// ─── Rich analytics payload for the dedicated Atlas dashboard ───────────────
function parseRankNum(rank: string | null | undefined): number | null {
  if (!rank) return null;
  const m = String(rank).match(/\d{1,3}/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1 && n <= 200 ? n : null;
}

router.get('/seo/analytics', (_req: Request, res: Response) => {
  recoverStuckSeoRuns();
  const db = getDb();

  const lastRun = db.prepare('SELECT * FROM seo_runs ORDER BY started_at DESC LIMIT 1').get() as SeoRun | undefined;
  const runs = db.prepare('SELECT * FROM seo_runs ORDER BY started_at ASC LIMIT 40').all() as SeoRun[];

  // Matches the actual scheduler cadence in crons.ts (daily; see SEO_RUN_INTERVAL_MS).
  let nextRun: string | null = null;
  if (lastRun?.started_at) {
    const d = new Date(lastRun.started_at.replace(' ', 'T') + 'Z');
    d.setDate(d.getDate() + 1);
    nextRun = d.toISOString();
  }
  let durationMs: number | null = null;
  if (lastRun?.started_at && lastRun?.completed_at) {
    durationMs = new Date(lastRun.completed_at).getTime() - new Date(lastRun.started_at).getTime();
  }

  const keywords = db.prepare('SELECT * FROM seo_keywords ORDER BY opportunity_score DESC').all() as SeoKeyword[];
  const allContent = db.prepare('SELECT * FROM seo_content ORDER BY created_at DESC').all() as SeoContent[];
  const published = allContent.filter((c) => c.committed === 1);
  const queue = allContent.filter((c) => c.committed === 0 && c.status !== 'denied');
  const competitors = db.prepare('SELECT domain, url, title FROM seo_competitors ORDER BY domain ASC').all() as {
    domain: string; url: string; title: string | null;
  }[];

  // Week-over-week keyword movement using history snapshots.
  const weeks = (db.prepare('SELECT DISTINCT week_start FROM seo_keyword_history ORDER BY week_start DESC').all() as { week_start: string }[]).map((w) => w.week_start);
  const prevWeek = weeks.length > 1 ? weeks[1] : null;
  const prevSnap = prevWeek
    ? (db.prepare('SELECT keyword, our_ranking FROM seo_keyword_history WHERE week_start = ?').all(prevWeek) as { keyword: string; our_ranking: string | null }[])
    : [];
  const prevByKeyword = new Map<string, string | null>(prevSnap.map((r) => [r.keyword, r.our_ranking] as [string, string | null]));

  const keywordRankings = keywords.map((kw) => {
    const cur = parseRankNum(kw.our_ranking);
    const prev = prevByKeyword.has(kw.keyword) ? parseRankNum(prevByKeyword.get(kw.keyword)) : null;
    let change: number | null = null;
    let changeDir: 'up' | 'down' | 'flat' | 'new' = 'new';
    if (cur != null && prev != null) {
      change = prev - cur; // positive = moved up (lower rank number is better)
      changeDir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    } else if (cur != null && prevByKeyword.size && !prevByKeyword.has(kw.keyword)) {
      changeDir = 'new';
    } else {
      changeDir = 'flat';
    }
    const opp = Math.round((kw.opportunity_score || 0) * 100);
    return {
      keyword: kw.keyword,
      rank: kw.our_ranking || 'unranked',
      rankNum: cur,
      change,
      changeDir,
      volume: kw.monthly_volume || '—',
      difficulty: Math.max(1, Math.min(100, 100 - opp)),
      opportunity: opp,
      competitor: kw.competitor || null,
    };
  });

  // Activity trend from each run.
  const trafficSeries = runs.map((r) => ({
    date: r.completed_at || r.started_at,
    keywords: r.keywords_found || 0,
    content: r.content_generated || 0,
    commits: r.commits_made || 0,
  }));

  // Competitor gap — how many tracked keywords each competitor ranks for.
  const compCounts = new Map<string, number>();
  for (const kw of keywords) {
    if (kw.competitor) compCounts.set(kw.competitor, (compCounts.get(kw.competitor) || 0) + 1);
  }
  const ourRankedCount = keywords.filter((k) => parseRankNum(k.our_ranking) != null).length;
  const compKeys = Array.from(compCounts.keys());
  const competitorComparison = competitors.map((c) => {
    const key = compKeys.find((k) => k.toLowerCase().includes(c.domain.split('.')[0].toLowerCase()) || c.domain.toLowerCase().includes(k.toLowerCase()));
    return {
      domain: c.domain,
      url: c.url,
      title: c.title,
      keywordCount: key ? compCounts.get(key) || 0 : 0,
    };
  });

  // Content performance (published pages). Impressions/clicks need Search Console.
  const contentPerformance = published.map((c) => ({
    id: c.id,
    title: c.title,
    type: c.type,
    filePath: c.file_path,
    liveUrl: liveUrlForPath(c.file_path),
    committedAt: c.committed_at,
    targetKeyword: c.target_keyword,
    seo: seoSummary(c),
  }));

  // Draft/approval queue surfaced directly on the Atlas dashboard.
  const contentQueue = allContent
    .filter((c) => c.committed === 0 && c.status !== 'denied' && c.status !== 'published')
    .map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      status: c.status,
      filePath: c.file_path,
      targetKeyword: c.target_keyword,
      scheduledFor: c.scheduled_for,
      createdAt: c.created_at,
      seo: seoSummary(c),
    }));

  // Measurement roll-ups.
  const scored = allContent.filter((c) => typeof c.seo_score === 'number');
  const avgSeoScore = scored.length
    ? Math.round(scored.reduce((n, c) => n + (c.seo_score || 0), 0) / scored.length)
    : null;
  const withSchema = published.filter((c) => (c.schema_types || '').trim().length > 0).length;
  const schemaCoverage = published.length ? Math.round((withSchema / published.length) * 100) : 0;
  const orphanPages = published.filter((c) => (c.internal_links_out ?? 0) < 2).length;
  const brokenLive = published.filter((c) => (c.live_status || '').startsWith('error') || c.live_status === 'unreachable').length;
  const health = computeSiteHealth();

  // Calendar events — published, scheduled, and pending content + plan tasks.
  // Two bugs fixed here: (1) denied content used to show as "pending" forever
  // at its original scheduled_for date, since only 'approved' was special-cased;
  // (2) when a page has multiple attempts (e.g. a denied draft superseded by a
  // later regenerate), every attempt showed up separately, so an old stale date
  // kept appearing alongside the real one. Now: denied rows are excluded
  // entirely, and non-published rows are deduped to only the latest attempt
  // per file_path.
  const latestByPath = new Map<string, typeof allContent[number]>();
  for (const c of allContent) {
    if (c.status === 'denied') continue;
    if (c.committed && c.committed_at) continue; // published rows handled separately below
    const key = c.file_path || `untitled-${c.id}`;
    const existing = latestByPath.get(key);
    if (!existing || new Date(c.created_at) > new Date(existing.created_at)) {
      latestByPath.set(key, c);
    }
  }
  const calendar: { date: string; title: string; type: string; status: string }[] = [];
  for (const c of allContent) {
    if (c.committed && c.committed_at) {
      calendar.push({ date: c.committed_at.split('T')[0].split(' ')[0], title: c.title, type: c.type, status: 'published' });
    }
  }
  for (const c of latestByPath.values()) {
    if (c.scheduled_for) {
      calendar.push({ date: c.scheduled_for, title: c.title, type: c.type, status: c.status === 'approved' ? 'scheduled' : 'pending' });
    }
  }

  // Top opportunities — high-opportunity keywords we have not yet built a page for.
  const publishedKeywords = new Set(published.map((p) => (p.target_keyword || '').toLowerCase()).filter(Boolean));
  const opportunities = keywords
    .filter((k) => !publishedKeywords.has((k.keyword || '').toLowerCase()))
    .slice(0, 12)
    .map((k) => ({
      keyword: k.keyword,
      volume: k.monthly_volume || '—',
      opportunity: Math.round((k.opportunity_score || 0) * 100),
      difficulty: Math.max(1, Math.min(100, 100 - Math.round((k.opportunity_score || 0) * 100))),
      competitor: k.competitor || null,
    }));

  // Activity feed.
  const activity: { kind: string; text: string; ts: string | null }[] = [];
  for (const r of runs.slice().reverse().slice(0, 8)) {
    activity.push({ kind: 'run', text: `Atlas run — ${r.summary || r.status} (${r.keywords_found} kw, ${r.content_generated} drafts, ${r.commits_made} commits)`, ts: r.completed_at || r.started_at });
  }
  for (const c of published.slice(0, 10)) {
    activity.push({ kind: 'commit', text: `Published ${c.file_path || c.title}`, ts: c.committed_at });
  }
  for (const c of queue.slice(0, 10)) {
    activity.push({ kind: 'draft', text: `Generated ${c.type}: ${c.title}`, ts: c.created_at });
  }
  activity.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  const gsc = gscSummary();

  const oppScores = keywords.map((k) => k.opportunity_score || 0);
  const avgOpportunity = oppScores.length ? Math.round((oppScores.reduce((a, b) => a + b, 0) / oppScores.length) * 100) : 0;
  const rankNums = keywordRankings.map((k) => k.rankNum).filter((n): n is number => n != null);
  const avgPosition = rankNums.length ? Math.round((rankNums.reduce((a, b) => a + b, 0) / rankNums.length) * 10) / 10 : null;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const contentThisMonth = published.filter((p) => (p.committed_at || '').slice(0, 7) === thisMonth).length;

  res.json({
    agent: {
      lastRun: lastRun ?? null,
      nextRun,
      runActive: isSeoRunActiveInDb(),
      phase: lastRun?.phase ?? null,
      durationMs,
      summary: lastRun?.summary ?? null,
    },
    health,
    kpis: {
      keywordsTracked: keywords.length,
      pagesPublished: published.length,
      // REAL Google index count via the URL Inspection API — null until the
      // first check has run (never pretend published == indexed).
      pagesIndexed: published.some((c) => c.index_checked_at)
        ? published.filter((c) => c.index_status === 'indexed').length
        : null,
      indexChecked: published.filter((c) => c.index_checked_at).length,
      pagesInQueue: queue.length,
      competitorsTracked: competitors.length,
      avgOpportunity,
      // Real Google position when Search Console is connected; else internal estimate.
      avgPosition: gsc.connected ? gsc.totals.avgPosition : avgPosition,
      ourRankedCount,
      contentThisMonth,
      // Atlas SEO-intelligence measurements (no external API needed).
      avgSeoScore,
      schemaCoverage,
      orphanPages,
      brokenLive,
      pagesNeedingWork: health.pagesNeedingWork,
      // REAL Search Console metrics (null until an owning account is connected).
      organicTraffic: gsc.connected ? gsc.totals.clicks : null,
      impressions: gsc.connected ? gsc.totals.impressions : null,
      ctr: gsc.connected && gsc.totals.impressions ? Math.round((gsc.totals.clicks / gsc.totals.impressions) * 1000) / 10 : null,
    },
    gsc,
    keywordRankings,
    trafficSeries,
    competitorComparison,
    contentPerformance,
    contentQueue,
    calendar,
    opportunities,
    activity: activity.slice(0, 25),
  });
});

// Manual Search Console sync (real rankings). No auth — for dashboard button/testing.
router.post('/seo/gsc-sync', async (_req: Request, res: Response) => {
  try {
    const result = await syncSearchConsole();
    res.json(result);
  } catch (err) {
    res.status(500).json({ connected: false, message: err instanceof Error ? err.message : 'sync failed' });
  }
});
router.get('/seo/gsc-sync', async (_req: Request, res: Response) => {
  try { res.json(await syncSearchConsole()); }
  catch (err) { res.status(500).json({ connected: false, message: err instanceof Error ? err.message : 'sync failed' }); }
});

export default router;
