import { getDb } from './schema';

export interface RalphItem {
  id: number;
  title: string;
  channel: string;
  body: string | null;
  status: string;
  tags: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  format?: string;
  alt_body?: string | null;
  image_url?: string | null;
  image_urls?: string[];
  external_post_id?: string | null;
  external_url?: string | null;
  publish_error?: string | null;
  video_url?: string | null;
}

export const RALPH_CHANNELS = ['blog', 'instagram', 'facebook', 'linkedin', 'gbp', 'email'];
export const RALPH_STATUSES = ['idea', 'draft', 'scheduled', 'published', 'archived'];

export function createRalphContent(c: {
  title: string; channel?: string; body?: string; status?: string; tags?: string; scheduled_for?: string; format?: string; alt_body?: string;
}): number {
  const db = getDb();
  const res = db.prepare(`
    INSERT INTO ralph_content (title, channel, body, status, tags, scheduled_for, format, alt_body)
    VALUES (@title, @channel, @body, @status, @tags, @scheduled_for, @format, @alt_body)
  `).run({
    title: c.title,
    channel: c.channel || 'blog',
    body: c.body ?? null,
    status: c.status || 'idea',
    tags: c.tags ?? null,
    scheduled_for: c.scheduled_for ?? null,
    format: c.format || 'single',
    alt_body: c.alt_body ?? null,
  });
  return Number(res.lastInsertRowid);
}

/** Swap a post's primary caption with its stored alternate (Arthur picked the other angle). */
export function swapRalphCaption(id: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT body, alt_body FROM ralph_content WHERE id = ?').get(id) as { body: string | null; alt_body: string | null } | undefined;
  if (!row || !row.alt_body) return false;
  db.prepare('UPDATE ralph_content SET body = ?, alt_body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(row.alt_body, row.body, id);
  return true;
}

// Proven posting days (industry windows): Tue/Wed/Thu/Sat. The next open one that
// isn't already taken by another scheduled post — so approving fills the calendar
// sensibly instead of piling everything on one day or leaving it blank.
const BEST_DOWS = new Set([2, 3, 4, 6]); // 0=Sun … 6=Sat
export function nextOpenScheduleDate(fromMs: number): string | null {
  const db = getDb();
  const taken = new Set(
    (db.prepare("SELECT scheduled_for FROM ralph_content WHERE status = 'scheduled' AND scheduled_for IS NOT NULL").all() as { scheduled_for: string }[])
      .map((r) => (r.scheduled_for || '').split('T')[0].split(' ')[0]),
  );
  for (let i = 1; i <= 60; i++) {
    const d = new Date(fromMs + i * 86400000);
    if (!BEST_DOWS.has(d.getUTCDay())) continue;
    const ds = d.toISOString().slice(0, 10);
    if (!taken.has(ds)) return ds;
  }
  return null;
}

export function updateRalphContent(id: number, patch: Partial<RalphItem>): void {
  const db = getDb();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const key of ['title', 'channel', 'body', 'status', 'tags', 'scheduled_for'] as const) {
    if (patch[key] !== undefined) { fields.push(`${key} = @${key}`); params[key] = patch[key]; }
  }
  if (patch.status === 'published') { fields.push("published_at = CURRENT_TIMESTAMP"); }
  if (!fields.length) return;
  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE ralph_content SET ${fields.join(', ')} WHERE id = @id`).run(params);
}

export function deleteRalphContent(id: number): void {
  getDb().prepare('DELETE FROM ralph_content WHERE id = ?').run(id);
}

/** Single content row + all its linked preview images (carousels have several). */
export function getRalphContent(id: number): RalphItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ralph_content WHERE id = ?').get(id) as RalphItem | undefined;
  if (!row) return null;
  const ids = (db.prepare('SELECT id FROM seo_images WHERE content_id = ? ORDER BY idx, id').all(id) as { id: number }[]).map((x) => x.id);
  const image_urls = ids.map((i) => `/api/seo/img/${i}.png`);
  const hasVideo = !!(db.prepare('SELECT 1 FROM ralph_videos WHERE content_id = ?').get(id));
  return { ...row, image_urls, image_url: image_urls[0] || null, video_url: hasVideo ? `/api/ralph/video/${id}.mp4` : null };
}

/** Store (or replace) a rendered reel video, base64-encoded MP4. */
export function saveRalphVideo(contentId: number, base64Mp4: string): void {
  getDb().prepare(
    'INSERT INTO ralph_videos (content_id, data) VALUES (?, ?) ON CONFLICT(content_id) DO UPDATE SET data = excluded.data, created_at = CURRENT_TIMESTAMP'
  ).run(contentId, base64Mp4);
}

/** Serve a rendered reel video's bytes (route helper). */
export function getRalphVideoBytes(contentId: number): Buffer | null {
  const row = getDb().prepare('SELECT data FROM ralph_videos WHERE content_id = ?').get(contentId) as { data: string } | undefined;
  if (!row || !row.data) return null;
  return Buffer.from(row.data, 'base64');
}

/** Mark a post published to a real platform (records the external id + live URL). */
export function setRalphPublished(id: number, ext: { postId?: string; url?: string }): void {
  getDb().prepare(
    `UPDATE ralph_content
     SET status='published', published_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP,
         external_post_id=?, external_url=?, publish_error=NULL
     WHERE id=?`
  ).run(ext.postId ?? null, ext.url ?? null, id);
}

export function setRalphPublishError(id: number, error: string): void {
  getDb().prepare('UPDATE ralph_content SET publish_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(error.slice(0, 500), id);
}

export function listRalphContent(filter: { status?: string; channel?: string } = {}): RalphItem[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.* FROM ralph_content c ${where ? where.replace(/status|channel/g, 'c.$&') : ''}
     ORDER BY COALESCE(c.scheduled_for, c.created_at) DESC LIMIT 300`
  ).all(...params) as RalphItem[];
  const imgStmt = db.prepare('SELECT id FROM seo_images WHERE content_id = ? ORDER BY idx, id');
  const vidStmt = db.prepare('SELECT 1 FROM ralph_videos WHERE content_id = ?');
  return rows.map((r) => {
    const ids = (imgStmt.all(r.id) as { id: number }[]).map((x) => x.id);
    const image_urls = ids.map((id) => `/api/seo/img/${id}.png`);
    const hasVideo = !!vidStmt.get(r.id);
    return { ...r, image_urls, image_url: image_urls[0] || null, video_url: hasVideo ? `/api/ralph/video/${r.id}.mp4` : null };
  });
}

export interface RalphSocial {
  connected: boolean;
  followers: number | null;
  engagementRate: number | null;
  reach: number | null;
  impressions: number | null;
  clicks: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  postsAnalyzed?: number;
  accounts?: { platform: string; name: string; username: string | null; followers: number | null }[];
  topPosts?: unknown[];
  allPosts?: { content: string; url: string | null; platform: string; likes: number; comments: number; shares: number; saved: number; reach: number; impressions: number; engagementRate: number }[];
}

export interface PublishedPostView {
  id: number;
  title: string;
  channel: string;
  publishedAt: string | null;
  imageUrl: string | null;
  permalink: string | null;
  // Whether this post's real stats have come back from Zernio yet — every
  // published post auto-carries its external_url (set at publish time), so
  // there's no manual linking step; "pending_sync" just means Zernio hasn't
  // returned analytics for this specific post yet (e.g. it's very recent).
  statsStatus: 'not_connected' | 'pending_sync' | 'synced';
  stats: {
    likes: number; comments: number; shares: number; saved: number; reach: number; impressions: number; engagementRate: number;
  } | null;
}

/**
 * Every published post, individually, matched against Zernio's real per-post
 * analytics by its live URL (external_url — written automatically when
 * publishRalphPost() posts it, no manual step). Distinct from `topPosts`,
 * which is only the best-performing 5.
 */
function publishedPostsWithStats(social?: RalphSocial): PublishedPostView[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.id, c.title, c.channel, c.published_at, c.external_url,
           (SELECT id FROM seo_images WHERE content_id = c.id ORDER BY idx, id LIMIT 1) AS image_id
    FROM ralph_content c WHERE c.status = 'published'
    ORDER BY COALESCE(c.published_at, c.updated_at) DESC LIMIT 100
  `).all() as { id: number; title: string; channel: string; published_at: string | null; external_url: string | null; image_id: number | null }[];

  const byUrl = new Map((social?.allPosts || []).filter((p) => p.url).map((p) => [p.url as string, p]));

  return rows.map((r) => {
    const matched = r.external_url ? byUrl.get(r.external_url) : undefined;
    const statsStatus: PublishedPostView['statsStatus'] = !social?.connected ? 'not_connected' : matched ? 'synced' : 'pending_sync';
    return {
      id: r.id,
      title: r.title,
      channel: r.channel,
      publishedAt: r.published_at,
      imageUrl: r.image_id ? `/api/seo/img/${r.image_id}.png` : null,
      permalink: r.external_url,
      statsStatus,
      stats: matched
        ? { likes: matched.likes, comments: matched.comments, shares: matched.shares, saved: matched.saved, reach: matched.reach, impressions: matched.impressions, engagementRate: matched.engagementRate }
        : null,
    };
  });
}

/**
 * Full content-manager analytics — the metrics top social tools (Sprout, Hootsuite,
 * Metricool, Planable) surface. Content-throughput numbers are REAL (derived from
 * the pipeline). Audience/engagement metrics are REAL too once Zernio is connected
 * — pass the live social payload in; otherwise the section reports not-connected.
 */
export function ralphAnalytics(social?: RalphSocial) {
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7);
  const stats = ralphStats();

  const publishedThisMonth = (db.prepare(
    "SELECT COUNT(*) c FROM ralph_content WHERE status='published' AND strftime('%Y-%m', COALESCE(published_at, updated_at)) = ?"
  ).get(month) as { c: number }).c;

  const scheduledAhead = (db.prepare(
    "SELECT COUNT(*) c FROM ralph_content WHERE status='scheduled' AND scheduled_for >= date('now')"
  ).get() as { c: number }).c;

  const byChannelPublished = db.prepare(
    "SELECT channel, COUNT(*) c FROM ralph_content WHERE status='published' GROUP BY channel"
  ).all() as { channel: string; c: number }[];

  // Weekly publish throughput (last 8 weeks) — real.
  const rawWeeks = db.prepare(
    "SELECT strftime('%Y-%W', COALESCE(published_at, updated_at)) wk, COUNT(*) c FROM ralph_content WHERE status='published' GROUP BY wk ORDER BY wk DESC LIMIT 8"
  ).all() as { wk: string; c: number }[];
  const throughput = rawWeeks.reverse();

  const totalPublished = stats.published || 0;
  const avgPerWeek = throughput.length ? Math.round((totalPublished / Math.max(throughput.length, 1)) * 10) / 10 : 0;

  return {
    kpis: {
      published: totalPublished,
      publishedThisMonth,
      scheduledAhead,
      ideas: stats.ideas,
      drafts: stats.drafts,
      avgPerWeek,
    },
    byChannel: byChannelPublished,
    throughput,
    // Audience + engagement — REAL from Zernio when connected, else not-connected.
    social: social ?? {
      connected: false,
      followers: null as number | null,
      engagementRate: null as number | null,
      reach: null as number | null,
      impressions: null as number | null,
      clicks: null as number | null,
    },
    topPosts: (social?.topPosts as unknown[]) ?? [],
    // Every published post individually, with real Zernio stats matched by its
    // live URL once available — not just the top 5 performers.
    posts: publishedPostsWithStats(social),
    // General best-time guidance (industry windows) until real data replaces it.
    bestTimes: [
      { day: 'Tue', windows: ['9–11am', '1–3pm'] },
      { day: 'Wed', windows: ['9–11am', '5–7pm'] },
      { day: 'Thu', windows: ['10am–12pm', '6–8pm'] },
      { day: 'Sat', windows: ['9–11am'] },
    ],
  };
}

export function ralphStats() {
  const db = getDb();
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM ralph_content GROUP BY status').all() as { status: string; c: number }[];
  const byChannel = db.prepare('SELECT channel, COUNT(*) c FROM ralph_content GROUP BY channel').all() as { channel: string; c: number }[];
  const map = (rows: { status?: string; channel?: string; c: number }[], key: 'status' | 'channel') => {
    const o: Record<string, number> = {};
    for (const r of rows) { const k = r[key]; if (k) o[k] = r.c; }
    return o;
  };
  const s = map(byStatus, 'status');
  const total = (db.prepare('SELECT COUNT(*) c FROM ralph_content').get() as { c: number }).c;
  const scheduledNext = db.prepare(
    "SELECT title, channel, scheduled_for FROM ralph_content WHERE status = 'scheduled' AND scheduled_for IS NOT NULL ORDER BY scheduled_for ASC LIMIT 1"
  ).get() as { title: string; channel: string; scheduled_for: string } | undefined;
  return {
    total,
    ideas: s.idea || 0,
    drafts: s.draft || 0,
    scheduled: s.scheduled || 0,
    published: s.published || 0,
    byChannel: map(byChannel, 'channel'),
    nextScheduled: scheduledNext || null,
  };
}
