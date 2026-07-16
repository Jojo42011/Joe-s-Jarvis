// ─── Zernio — social publishing + analytics (Paulie Layer 2) ──────────────────
// Zernio (https://zernio.com) is the connection layer to Joe's already-linked
// Instagram (@totallyoutdoors) and Facebook (Totally Outdoors LLC) accounts. Paulie uses
// it to (1) publish approved posts to the real platforms and (2) pull REAL audience
// + engagement analytics for the dashboard. One Bearer key authorizes everything.
//
// Docs: https://docs.zernio.com  ·  Key: ZERNIO_API_KEY (Fly secret).

const BASE = (process.env.ZERNIO_BASE_URL || 'https://zernio.com/api/v1').replace(/\/+$/, '');
const TAG = '[Zernio]';

export function hasZernio(): boolean {
  return !!process.env.ZERNIO_API_KEY;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.ZERNIO_API_KEY || ''}`,
    'Content-Type': 'application/json',
  };
}

// Channels Paulie can actually publish through Zernio. blog/email/gbp/linkedin are
// not wired to a connected Zernio account here, so they stay in-app only.
export const ZERNIO_PLATFORMS = ['instagram', 'facebook'] as const;
export type ZernioPlatform = (typeof ZERNIO_PLATFORMS)[number];

export function isZernioChannel(channel: string): channel is ZernioPlatform {
  return (ZERNIO_PLATFORMS as readonly string[]).includes(channel);
}

export interface ZernioAccount {
  id: string;              // Zernio account _id (used as accountId in posts/analytics)
  platform: string;        // 'instagram' | 'facebook'
  name: string;            // display name
  username: string | null;
  followers: number | null;
  pageId: string | null;   // Facebook selected page id
  active: boolean;
}

interface RawAccount {
  _id: string;
  platform: string;
  displayName?: string;
  isActive?: boolean;
  enabled?: boolean;
  metadata?: {
    selectedPageId?: string;
    selectedPageUsername?: string;
    username?: string;
    followersCount?: number;
    followers_count?: number;
    availablePages?: { id: string; username?: string; fan_count?: number }[];
    userProfile?: { username?: string };
  };
}

let accountsCache: { at: number; accounts: ZernioAccount[] } | null = null;
const ACCOUNTS_TTL_MS = 5 * 60 * 1000;

async function zfetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
}

/** All connected Zernio accounts (cached 5 min). Followers come from platform
 *  metadata where available. */
export async function listZernioAccounts(force = false): Promise<ZernioAccount[]> {
  if (!hasZernio()) return [];
  if (!force && accountsCache && Date.now() - accountsCache.at < ACCOUNTS_TTL_MS) return accountsCache.accounts;
  try {
    const res = await zfetch('/accounts');
    if (!res.ok) { console.error(TAG, 'accounts fetch failed', res.status); return accountsCache?.accounts || []; }
    const data = (await res.json()) as { accounts?: RawAccount[] };
    const accounts: ZernioAccount[] = (data.accounts || []).map((a) => {
      const m = a.metadata || {};
      const page = m.availablePages?.find((p) => p.id === m.selectedPageId) || m.availablePages?.[0];
      const followers = m.followersCount ?? m.followers_count ?? page?.fan_count ?? null;
      return {
        id: a._id,
        platform: a.platform,
        name: a.displayName || m.selectedPageUsername || m.username || a.platform,
        username: m.selectedPageUsername || m.username || m.userProfile?.username || null,
        followers: typeof followers === 'number' ? followers : null,
        pageId: m.selectedPageId || null,
        active: a.isActive !== false && a.enabled !== false,
      };
    });
    accountsCache = { at: Date.now(), accounts };
    return accounts;
  } catch (err) {
    console.error(TAG, 'accounts error:', err instanceof Error ? err.message : err);
    return accountsCache?.accounts || [];
  }
}

/** The connected account for a platform (instagram/facebook), or null. */
export async function accountFor(platform: ZernioPlatform): Promise<ZernioAccount | null> {
  const accounts = await listZernioAccounts();
  return accounts.find((a) => a.platform === platform && a.active) || accounts.find((a) => a.platform === platform) || null;
}

export interface PublishResult {
  ok: boolean;
  postId?: string;
  url?: string;
  error?: string;
}

/** Publish a post to a connected platform via Zernio. The image MUST be a public
 *  HTTPS URL that returns raw bytes (Paulie's /api/seo/img/<id>.png on the live host
 *  satisfies this). Set publishNow=false to create it as a draft inside Zernio. */
export async function publishToZernio(opts: {
  platform: ZernioPlatform;
  content: string;
  imageUrl?: string | null;
  imageUrls?: string[];        // carousel — up to 10 images (Instagram/Facebook)
  videoUrl?: string | null;    // reel/video — a single public MP4 URL
  firstComment?: string | null;
  publishNow?: boolean;
}): Promise<PublishResult> {
  if (!hasZernio()) return { ok: false, error: 'ZERNIO_API_KEY not configured' };
  const account = await accountFor(opts.platform);
  if (!account) return { ok: false, error: `No connected ${opts.platform} account in Zernio` };

  const platformSpecificData: Record<string, unknown> = {};
  if (opts.platform === 'facebook' && account.pageId) platformSpecificData.pageId = account.pageId;
  if (opts.firstComment) platformSpecificData.firstComment = opts.firstComment;

  let mediaItems: { type: string; url: string }[];
  if (opts.videoUrl) {
    // A reel is a single video post (Instagram reel / Facebook video).
    mediaItems = [{ type: 'video', url: opts.videoUrl }];
    // Instagram publishes vertical video as a Reel; flag it where the API supports it.
    if (opts.platform === 'instagram') platformSpecificData.mediaType = 'reel';
  } else {
    // Prefer the multi-image list (carousel); fall back to the single image.
    const urls = (opts.imageUrls && opts.imageUrls.length ? opts.imageUrls : (opts.imageUrl ? [opts.imageUrl] : [])).slice(0, 10);
    mediaItems = urls.map((url) => ({ type: 'image', url }));
  }
  const body = {
    content: opts.content,
    mediaItems,
    platforms: [{
      platform: opts.platform,
      accountId: account.id,
      ...(Object.keys(platformSpecificData).length ? { platformSpecificData } : {}),
    }],
    publishNow: opts.publishNow !== false,
  };

  try {
    const res = await zfetch('/posts', { method: 'POST', body: JSON.stringify(body) });
    const text = await res.text();
    let json: { post?: { _id?: string; platforms?: { platformPostUrl?: string }[]; platformPostUrl?: string }; message?: string; error?: string } = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
    if (!res.ok) {
      const error = json.message || json.error || `Zernio ${res.status}: ${text.slice(0, 200)}`;
      console.error(TAG, `publish ${opts.platform} failed:`, error);
      return { ok: false, error };
    }
    const post = json.post || {};
    const url = post.platforms?.[0]?.platformPostUrl || post.platformPostUrl;
    console.log(TAG, `published to ${opts.platform} — post ${post._id || '(no id)'}`);
    return { ok: true, postId: post._id, url };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'publish failed';
    console.error(TAG, `publish ${opts.platform} error:`, error);
    return { ok: false, error };
  }
}

export interface ZernioSocial {
  connected: boolean;
  followers: number | null;
  engagementRate: number | null;
  reach: number | null;
  impressions: number | null;
  clicks: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  postsAnalyzed: number;
  accounts: { platform: string; name: string; username: string | null; followers: number | null }[];
  topPosts: { content: string; url: string | null; platform: string; likes: number; comments: number; reach: number; engagementRate: number }[];
  // Every post Zernio has analytics for (topPosts is just the top 5 of this,
  // ranked by engagement) — used to match real per-post stats onto EVERY
  // published ralph_content row, not just the best performers.
  allPosts: { content: string; url: string | null; platform: string; likes: number; comments: number; shares: number; saved: number; reach: number; impressions: number; engagementRate: number }[];
}

interface AnalyticsPost {
  content?: string;
  platform?: string;
  platformPostUrl?: string;
  analytics?: Record<string, number>;
  platforms?: { platform?: string; platformPostUrl?: string; analytics?: Record<string, number> }[];
}

let socialCache: { at: number; data: ZernioSocial } | null = null;
const SOCIAL_TTL_MS = 5 * 60 * 1000;

/** Real audience + engagement analytics aggregated across the connected accounts. */
export async function getZernioSocial(force = false): Promise<ZernioSocial> {
  const empty: ZernioSocial = {
    connected: false, followers: null, engagementRate: null, reach: null, impressions: null,
    clicks: null, likes: null, comments: null, shares: null, saves: null, postsAnalyzed: 0, accounts: [], topPosts: [], allPosts: [],
  };
  if (!hasZernio()) return empty;
  if (!force && socialCache && Date.now() - socialCache.at < SOCIAL_TTL_MS) return socialCache.data;

  try {
    const accounts = await listZernioAccounts(force);
    const res = await zfetch('/analytics?limit=100');
    if (!res.ok) { console.error(TAG, 'analytics fetch failed', res.status); return socialCache?.data || { ...empty, connected: accounts.length > 0, accounts: accounts.map(mapAcct) }; }
    const data = (await res.json()) as { posts?: AnalyticsPost[] };
    const posts = data.posts || [];

    const sum = { reach: 0, impressions: 0, clicks: 0, likes: 0, comments: 0, shares: 0, saves: 0, er: 0, erN: 0 };
    const allScored: ZernioSocial['allPosts'] = [];
    for (const p of posts) {
      const a = p.analytics || p.platforms?.[0]?.analytics || {};
      sum.reach += a.reach || 0;
      sum.impressions += a.impressions || 0;
      sum.clicks += a.clicks || 0;
      sum.likes += a.likes || 0;
      sum.comments += a.comments || 0;
      sum.shares += a.shares || 0;
      sum.saves += a.saves || 0;
      if (typeof a.engagementRate === 'number') { sum.er += a.engagementRate; sum.erN += 1; }
      allScored.push({
        content: (p.content || '').slice(0, 120),
        url: p.platformPostUrl || p.platforms?.[0]?.platformPostUrl || null,
        platform: p.platform || p.platforms?.[0]?.platform || 'social',
        likes: a.likes || 0, comments: a.comments || 0, shares: a.shares || 0, saved: a.saves || 0,
        reach: a.reach || 0, impressions: a.impressions || 0,
        engagementRate: typeof a.engagementRate === 'number' ? a.engagementRate : 0,
      });
    }
    allScored.sort((x, y) => (y.likes + y.comments * 2) - (x.likes + x.comments * 2));
    const topPosts = allScored.slice(0, 5).map((p) => ({
      content: p.content, url: p.url, platform: p.platform, likes: p.likes, comments: p.comments, reach: p.reach, engagementRate: p.engagementRate,
    }));

    // Sum only the accounts whose follower count Zernio actually exposes —
    // Instagram's followers_count isn't in Zernio's account metadata today (FB
    // fan_count is), so silently treating a missing IG count as 0 here would
    // make the combined total look like it includes IG when it doesn't. The
    // per-account breakdown (accounts[]) is what tells the true story; this
    // total is only ever the sum of platforms Zernio actually reports.
    const knownFollowerAccounts = accounts.filter((a) => a.followers != null);
    const totalFollowers = knownFollowerAccounts.length
      ? knownFollowerAccounts.reduce((s, a) => s + (a.followers || 0), 0)
      : null;
    const data2: ZernioSocial = {
      connected: accounts.length > 0,
      followers: totalFollowers,
      engagementRate: sum.erN ? Math.round((sum.er / sum.erN) * 100) / 100 : null,
      reach: sum.reach || null,
      impressions: sum.impressions || null,
      clicks: sum.clicks || null,
      likes: sum.likes || null,
      comments: sum.comments || null,
      shares: sum.shares || null,
      saves: sum.saves || null,
      postsAnalyzed: posts.length,
      accounts: accounts.map(mapAcct),
      topPosts,
      allPosts: allScored,
    };
    socialCache = { at: Date.now(), data: data2 };
    return data2;
  } catch (err) {
    console.error(TAG, 'social analytics error:', err instanceof Error ? err.message : err);
    return socialCache?.data || empty;
  }
}

function mapAcct(a: ZernioAccount) {
  return { platform: a.platform, name: a.name, username: a.username, followers: a.followers };
}
