// ─── AI image generation for SEO pages (OpenAI Images) ───
// Lauren fills every image slot with a purpose-built, photorealistic image.
//
// Lifecycle:
//   1. Generation: create the PNG, store its bytes in the DB (seo_images), and
//      reference it in the draft via Lauren's own server route /api/seo/img/<id>
//      so it renders in preview immediately (no repo/CDN round-trip).
//   2. Publish: commit each PNG to the website repo (assets/seo/<slug>/img-N.png)
//      and rewrite the page's <img> src to the live production URL.
//
// Placeholder convention (emitted by the generation prompt):
//   <img src="__LAUREN_IMAGE__" data-img-prompt="a scene description" alt="...">
// Any <img> with an empty/placeholder src is also backfilled from its alt/context.

import { getDb } from '../../db/schema';
import { getBusinessProfile } from './businessProfile';
import { applyBrandLogo } from './brandLogo';
import { applyTextOverlay, TextOverlay } from './postText';

const TAG = '[SEO Agent]';
const PLACEHOLDER = '__LAUREN_IMAGE__';
const PREVIEW_BASE = '/api/seo/img';

export function hasImageKey(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

interface ImageConfig {
  model: string;
  aspect: string;
  max: number;
}
function imageConfig(): ImageConfig {
  return {
    model: process.env.SEO_IMAGE_MODEL || 'gemini-2.5-flash-image',
    aspect: process.env.SEO_IMAGE_ASPECT || '16:9',
    // No per-page cap: we fill EVERY visual slot on the page. The env override
    // stays available as an escape hatch, but the default is effectively unlimited.
    max: parseInt(process.env.SEO_IMAGE_MAX || '999', 10),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Rate-limit throttle ──────────────────────────────────────────────────────
// Serialize image calls process-wide with a minimum spacing so we stay under the
// provider's per-minute limit. We now generate one image per slot (10-15 per
// page), so a conservative 12s spacing keeps us comfortably under the limit and
// avoids the 429 pileups that used to leave slots empty.
const MIN_INTERVAL_MS = parseInt(process.env.SEO_IMAGE_MIN_INTERVAL_MS || '12000', 10);
const MAX_RETRIES = parseInt(process.env.SEO_IMAGE_RETRIES || '4', 10);
// How many full generateOne() rounds we attempt PER SLOT before falling back to
// reusing another image. Each round itself retries 429/5xx up to MAX_RETRIES, so
// this is deliberately high — we would rather take a long time and fill every
// slot with its own fresh image than leave any slot empty.
const SLOT_ATTEMPTS = Math.max(1, parseInt(process.env.SEO_IMAGE_SLOT_ATTEMPTS || '6', 10));
let nextSlot = 0;
async function throttleGate(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

function retryAfterMs(res: Response, attempt: number): number {
  const hdr = res.headers.get('retry-after');
  if (hdr) {
    const secs = parseInt(hdr, 10);
    if (Number.isFinite(secs)) return Math.min(60000, secs * 1000);
  }
  // Exponential backoff with jitter: 3s, 6s, 12s, 24s (+0-1s)
  return Math.min(30000, 3000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 1000);
}

// Convert any placeholder-backed <video> block into an <img> slot so Lauren can
// fill it with a still (we generate images, not video).
function convertPlaceholderVideos(html: string): string {
  return html.replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, (block) => {
    if (!block.includes(PLACEHOLDER)) return block;
    const prompt = block.match(/data-img-prompt\s*=\s*["']([^"']*)["']/i)?.[1]
      || 'cinematic wide hero shot of a beautifully landscaped Ohio backyard with a paver patio and stone retaining wall at golden hour';
    const cls = block.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1];
    const clsAttr = cls ? ` class="${cls}"` : '';
    return `<img${clsAttr} src="${PLACEHOLDER}" data-img-prompt="${prompt.replace(/"/g, '&quot;')}" alt="Professional landscaping">`;
  });
}

// ── Expert prompt engineering ─────────────────────────────────────────────
// Wrap the LLM's raw scene description in a photographic scaffold tuned for
// Ohio landscaping/hardscaping photography. This is what makes Lauren an expert prompter.
export function buildImagePrompt(sceneDesc: string, ctx: { city?: string; keyword?: string; type?: string }): string {
  const where = ctx.city ? `a well-kept ${ctx.city}, Ohio` : 'a well-kept Holmes County, Ohio';
  const subject = (sceneDesc || '').trim() || 'a beautifully landscaped backyard with a paver patio and stone retaining wall at golden hour';

  return [
    `Professional landscape and outdoor-living photography. Subject: ${subject}.`,
    `Location: ${where} property designed and built by a high-end landscaping and hardscaping contractor.`,
    `Style: rustic-classic Midwest warmth — natural stone retaining walls, paver patios, ponds and waterfalls,`,
    `deep green manicured lawns, layered perennial beds, mature hardwood trees,`,
    `rolling Holmes County countryside in the background, four-season Midwest light (warm golden hour or soft overcast),`,
    `ultra-realistic, high dynamic range, sharp focus, shot on a full-frame DSLR with a 24-35mm lens.`,
    `Composition: editorial, magazine-quality, inviting.`,
    `Absolutely no people, no text, no words, no watermark, no logos, no signage.`,
  ].join(' ');
}

interface GeminiImagePart { inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string } }
interface GeminiImageResponse {
  candidates?: { content?: { parts?: GeminiImagePart[] } }[];
  error?: { message?: string };
}

// Generate one image with Gemini 2.5 Flash Image (same key/stack as the rest of
// Lauren). Throttled + retries 429/5xx with backoff. Returns base64 PNG or null.
async function generateOne(prompt: string, cfg: ImageConfig): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: cfg.aspect },
    },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttleGate();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      if (res.ok) {
        const data = (await res.json()) as GeminiImageResponse;
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          const b64 = p.inlineData?.data || p.inline_data?.data;
          if (b64) return b64;
        }
        console.warn(TAG, 'Gemini image response had no inline image data');
        return null;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const waitMs = retryAfterMs(res, attempt);
          console.warn(TAG, `Gemini image ${res.status} — backing off ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(waitMs);
          continue;
        }
      }

      const errText = await res.text().catch(() => '');
      console.error(TAG, `Image generation failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
      return null;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.warn(TAG, `Image request error, retrying: ${err instanceof Error ? err.message : err}`);
        await sleep(retryAfterMs({ headers: { get: () => null } } as unknown as Response, attempt));
        continue;
      }
      console.error(TAG, 'Image generation error:', err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

/** Public URL for a committed repo asset (site-relative by default — the repo IS
 *  the live site — with CDN/raw fallbacks). Used only at publish time. */
export function imageUrlForRepoPath(path: string): string {
  const repo = process.env.SEO_GITHUB_REPO || '';
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  const mode = process.env.SEO_IMAGE_CDN || 'site';
  if (mode === 'jsdelivr') return `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}`;
  if (mode === 'raw') return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  const base = (process.env.SEO_WEBSITE_URL || 'https://www.totallyoutdoorsllc.com').replace(/\/+$/, '');
  return `${base}/${path}`;
}

interface ImgSlot {
  full: string;        // full <img ...> tag
  prompt: string;      // scene description
  alt: string;
}

// Character ranges of the <nav> bar only. We deliberately do NOT skip <header>
// or <footer> — one-page templates often wrap the whole hero (with its image
// cards) inside <header>, and skipping it would leave those images empty.
function skipRanges(html: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /<nav\b[\s\S]*?<\/nav>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

// A logo is usually wrapped in a link back to the homepage — skip those imgs
// even when they sit outside <nav>.
function isLogoLink(html: string, pos: number): boolean {
  const pre = html.slice(Math.max(0, pos - 220), pos);
  const lastOpen = pre.lastIndexOf('<a ');
  const lastClose = pre.lastIndexOf('</a>');
  if (lastOpen < 0 || lastOpen < lastClose) return false;
  const aTag = pre.slice(lastOpen);
  return /href\s*=\s*["'](\/|\.?\/?index[\w.]*|#top|#home|#)["']/i.test(aTag);
}

// Text of the nearest heading before a position — used to describe an image
// when the tag itself carries no data-img-prompt or alt.
function nearestHeading(html: string, pos: number): string {
  const before = html.slice(0, pos);
  const matches = [...before.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)];
  if (!matches.length) return '';
  return matches[matches.length - 1][1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Find EVERY content image that should be a real photo — robust to whatever the
// LLM emitted (our token, an empty src, or a hallucinated template path). Skips
// logos/icons and anything inside header/nav/footer.
function findImageSlots(html: string): ImgSlot[] {
  const slots: ImgSlot[] = [];
  const skips = skipRanges(html);
  const inSkip = (i: number) => skips.some(([s, e]) => i >= s && i < e);
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const pos = m.index;
    if (inSkip(pos)) continue;

    const src = tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
    const cls = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
    const dataPrompt = tag.match(/\bdata-img-prompt\s*=\s*["']([^"']*)["']/i)?.[1];
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';

    // Skip logos / icons / already-generated images.
    if (/logo|icon|avatar|badge|sprite|favicon/i.test(cls) || /logo|icon|sprite|favicon/i.test(src)) continue;
    if (/\.svg(\?|#|$)/i.test(src)) continue;
    if (/\/api\/seo\/img\//i.test(src)) continue;
    if (isLogoLink(html, pos)) continue;
    const w = parseInt(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || '', 10);
    const h = parseInt(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || '', 10);
    if ((w && w <= 64) || (h && h <= 64)) continue;

    // Fill it if: our placeholder, empty, has a prompt, OR a non-absolute (template/relative) path.
    const isAbsolute = /^(https?:|data:|\/\/)/i.test(src);
    const fillable = src === PLACEHOLDER || src === '' || !!dataPrompt || /placeholder|TODO|__/i.test(src) || !isAbsolute;
    if (!fillable) continue;

    const prompt = (dataPrompt || alt || nearestHeading(html, pos) || '').trim();
    slots.push({ full: tag, prompt, alt });
  }
  return slots;
}

const IMG_SIZING = 'object-fit:cover;width:100%;height:100%;display:block';

function rebuildImgTag(originalTag: string, src: string, altFallback: string): string {
  let tag = originalTag
    .replace(/\bsrc\s*=\s*["'][^"']*["']/i, `src="${src}"`)
    .replace(/\s*data-img-prompt\s*=\s*["'][^"']*["']/i, '');
  if (!/\bsrc\s*=/i.test(tag)) tag = tag.replace(/<img\b/i, `<img src="${src}"`);
  if (!/\balt\s*=/i.test(tag)) tag = tag.replace(/<img\b/i, `<img alt="${altFallback.replace(/"/g, '&quot;')}"`);
  if (!/\bloading\s*=/i.test(tag)) tag = tag.replace(/<img\b/i, '<img loading="lazy"');
  // Ensure the image fills its container (fixes empty gaps / cropping mismatches).
  if (/\bstyle\s*=\s*["']/i.test(tag)) {
    tag = tag.replace(/\bstyle\s*=\s*["']([^"']*)["']/i, (_mm, val: string) => `style="${val.replace(/;\s*$/, '')};${IMG_SIZING}"`);
  } else {
    tag = tag.replace(/<img\b/i, `<img style="${IMG_SIZING}"`);
  }
  return tag;
}

// ── Hero background scrim + readable text (C) ────────────────────────────────
const SCRIM = 'linear-gradient(rgba(0,0,0,0.42),rgba(0,0,0,0.55))';
const LAUREN_STYLE_MARKER = '<!-- lauren:imgstyle -->';

// Recognize the empty visual containers Gemini emits (beige/empty image boxes,
// divs with a template background path, empty <figure>/<picture>) and turn them
// into fillable slots so no image area is ever left blank.
const CONTAINER_KW = /(image|img|photo|gallery|media|hero|banner|thumb|picture|visual|feature|masthead|snapshot|backdrop|showcase)/i;

function normalizeImageContainers(
  html: string,
  ctx: { city?: string; keyword?: string },
): string {
  let out = html;

  // 1) Any inline background-image pointing at a (missing) template asset → fill fresh.
  out = out.replace(
    /background-image\s*:\s*url\(\s*['"]?(?!https?:|data:|__LAUREN_IMAGE__|\/api\/seo)[^'")]+['"]?\s*\)/gi,
    "background-image:url('__LAUREN_IMAGE__')",
  );

  // 2) Empty image-ish containers → give them a fillable image.
  out = out.replace(
    /<(div|figure|span|a|picture)\b([^>]*)>(\s*)<\/\1>/gi,
    (whole: string, tag: string, attrs: string, _ws: string, offset: number) => {
      const cls = attrs.match(/\b(?:class|id)\s*=\s*["']([^"']*)["']/i)?.[1] || '';
      if (!CONTAINER_KW.test(cls)) return whole;
      if (/logo|icon|avatar|badge/i.test(cls)) return whole;
      if (/__LAUREN_IMAGE__/.test(attrs)) return whole; // already a bg placeholder
      const desc = nearestHeading(out, offset) || `${ctx.city || 'Ohio'} professional landscaping and hardscaping`;
      const img = `<img src="__LAUREN_IMAGE__" data-img-prompt="${desc.replace(/"/g, '&quot;')}" alt="${(ctx.city || 'Ohio')} professional landscaping">`;
      return `<${tag}${attrs}>${img}</${tag}>`;
    },
  );

  return out;
}

// Convert a full-bleed / hero <img> that sits ON TOP of text into a CSS
// background on its parent, so it renders BEHIND the text (never covers it).
// Only touches images that look like backgrounds (hero/banner/cover class or
// absolute positioning) and are the first child of a section/div/header.
function heroImgToBackground(html: string): string {
  return html.replace(
    /<(section|div|header)\b([^>]*)>(\s*)<img\b([^>]*?)\/?>/gi,
    (whole, tagName: string, parentAttrs: string, ws: string, imgAttrs: string) => {
      const cls = imgAttrs.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '';
      const style = imgAttrs.match(/\bstyle\s*=\s*["']([^"']*)["']/i)?.[1] || '';
      const looksBg = /\b(hero|banner|bg|background|cover|masthead|full-?bleed|hero-?image)\b/i.test(cls)
        || /position\s*:\s*(absolute|fixed)/i.test(style);
      if (!looksBg) return whole; // normal content image — leave as <img>

      const dataPrompt = imgAttrs.match(/\bdata-img-prompt\s*=\s*["']([^"']*)["']/i)?.[1] || '';
      const bg = "background-image:url('__LAUREN_IMAGE__');background-size:cover;background-position:center";
      let attrs = parentAttrs;
      if (/\bstyle\s*=\s*"/i.test(attrs)) attrs = attrs.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_m, v) => `style="${v.replace(/;\s*$/, '')};${bg}"`);
      else if (/\bstyle\s*=\s*'/i.test(attrs)) attrs = attrs.replace(/\bstyle\s*=\s*'([^']*)'/i, (_m, v) => `style='${v.replace(/;\s*$/, '')};${bg}'`);
      else attrs += ` style="${bg}"`;
      if (/\bclass\s*=\s*"/i.test(attrs)) attrs = attrs.replace(/\bclass\s*=\s*"([^"]*)"/i, 'class="$1 lauren-bg"');
      else if (/\bclass\s*=\s*'/i.test(attrs)) attrs = attrs.replace(/\bclass\s*=\s*'([^']*)'/i, "class='$1 lauren-bg'");
      else attrs += ' class="lauren-bg"';
      if (dataPrompt) attrs += ` data-img-prompt="${dataPrompt.replace(/"/g, '&quot;')}"`;
      return `<${tagName}${attrs}>${ws}`;
    },
  );
}

// Add the lauren-bg class to any element carrying a background-image placeholder
// (so our readable-text CSS applies). Skips page-level wrappers; idempotent.
function tagLaurenBg(html: string): string {
  return html.replace(
    /<([a-zA-Z][\w-]*)\b[^>]*\bstyle\s*=\s*(?:"[^"]*__LAUREN_IMAGE__[^"]*"|'[^']*__LAUREN_IMAGE__[^']*')[^>]*>/gi,
    (openTag, tagName: string) => {
      if (/^(body|html|main|header|footer|nav)$/i.test(tagName)) return openTag;
      if (/\blauren-bg\b/.test(openTag)) return openTag; // already tagged
      if (/\bclass\s*=\s*"/i.test(openTag)) return openTag.replace(/\bclass\s*=\s*"([^"]*)"/i, 'class="$1 lauren-bg"');
      if (/\bclass\s*=\s*'/i.test(openTag)) return openTag.replace(/\bclass\s*=\s*'([^']*)'/i, "class='$1 lauren-bg'");
      return openTag.replace(/^<([a-zA-Z][\w-]*)/, '<$1 class="lauren-bg"');
    },
  );
}

function injectLaurenStyle(html: string): string {
  if (html.includes(LAUREN_STYLE_MARKER)) return html;
  const css = `${LAUREN_STYLE_MARKER}<style>
.lauren-bg{position:relative}
.lauren-bg,.lauren-bg h1,.lauren-bg h2,.lauren-bg h3,.lauren-bg h4,.lauren-bg p,.lauren-bg li,.lauren-bg span:not([class*="btn"]):not([class*="button"]),.lauren-bg a:not([class*="btn"]):not([class*="button"]){color:#fff !important;}
.lauren-bg h1,.lauren-bg h2,.lauren-bg h3{text-shadow:0 2px 12px rgba(0,0,0,0.65)}
.lauren-bg p,.lauren-bg li{text-shadow:0 1px 6px rgba(0,0,0,0.6)}
</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${css}\n</head>`);
  return css + html;
}

export interface FilledImage { id: number; repoPath: string; previewUrl: string; prompt: string; }
export interface FillResult { html: string; images: FilledImage[]; attempted: number }

/** Generate images for every fillable slot, store them on the server, and point
 *  the draft at Lauren's preview endpoint. Guarantees NO __LAUREN_IMAGE__
 *  placeholder survives — overflow slots and failures reuse generated images,
 *  and background-image / poster tokens are swept last. Nothing is committed yet. */
function stripPlaceholders(html: string): string {
  return html
    .replace(/<img[^>]*\bsrc\s*=\s*["']__LAUREN_IMAGE__["'][^>]*>/gi, '')
    .split(PLACEHOLDER).join('');
}

export async function fillPageImages(
  html: string,
  ctx: { slug?: string; city?: string; keyword?: string; type?: string },
): Promise<FillResult> {
  // No key → don't leave broken placeholders behind.
  if (!hasImageKey()) return { html: stripPlaceholders(html), images: [], attempted: 0 };
  const cfg = imageConfig();

  let out = convertPlaceholderVideos(html);
  out = normalizeImageContainers(out, ctx); // empty boxes / template bg paths → fillable
  out = heroImgToBackground(out);           // move full-bleed hero images behind text
  const slots = findImageSlots(out);
  const bgTokenCount = (out.match(/__LAUREN_IMAGE__/g) || []).length - slots.length;
  const hasBgTokens = out.includes(PLACEHOLDER);
  console.log(TAG, `image pipeline [${ctx.slug || 'page'}]: ${slots.length} img slot(s), ${Math.max(0, bgTokenCount)} background/other placeholder(s)`);
  if (!slots.length && !hasBgTokens) {
    console.log(TAG, `image pipeline [${ctx.slug || 'page'}]: no image slots found — page has no visual containers`);
    return { html: out, images: [], attempted: 0 };
  }

  const slug = (ctx.slug || 'page').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const db = getDb();
  const images: FilledImage[] = [];
  const urls: string[] = [];         // preview URLs of generated images, for reuse
  const altFallback = `${ctx.city || 'Ohio'} landscaping by ${getBusinessProfile().name}`;

  // Round-robin cursor over already-generated images. Used to cycle a small set
  // of generated images across ALL remaining slots (slot 4 → img 1, slot 5 →
  // img 2, … slot 7 → img 1 again) so nothing ever renders empty.
  let cycleIdx = 0;
  const nextReuse = (): string | null => {
    if (!urls.length) return null;
    const url = urls[cycleIdx % urls.length];
    cycleIdx++;
    return url;
  };

  // Generate ONE fresh image for a slot (no per-page cap). PERSISTENT: keeps
  // re-attempting (up to SLOT_ATTEMPTS rounds, each with its own 429/5xx backoff)
  // so a transient failure or an empty response never leaves a slot without its
  // own image. Returns the preview URL, or null only if every attempt failed.
  const generate = async (sceneDesc: string): Promise<string | null> => {
    if (images.length >= cfg.max) return null; // escape hatch only (default 999)
    const prompt = buildImagePrompt(sceneDesc, ctx);
    for (let attempt = 1; attempt <= SLOT_ATTEMPTS; attempt++) {
      const b64 = await generateOne(prompt, cfg);
      if (b64) {
        const n = images.length + 1;
        const repoPath = `assets/seo/${slug}/img-${n}.png`;
        const info = db.prepare(
          'INSERT INTO seo_images (content_id, idx, repo_path, prompt, data, committed) VALUES (NULL, ?, ?, ?, ?, 0)',
        ).run(n, repoPath, prompt, b64);
        const imageId = Number(info.lastInsertRowid);
        const previewUrl = `${PREVIEW_BASE}/${imageId}.png`;
        urls.push(previewUrl);
        images.push({ id: imageId, repoPath, previewUrl, prompt });
        if (attempt > 1) console.log(TAG, `Slot image generated on attempt ${attempt}/${SLOT_ATTEMPTS}`);
        return previewUrl;
      }
      if (attempt < SLOT_ATTEMPTS) {
        const backoff = Math.min(20000, 4000 * attempt);
        console.warn(TAG, `Slot image not produced (attempt ${attempt}/${SLOT_ATTEMPTS}) — retrying in ${Math.round(backoff / 1000)}s to keep the page complete`);
        await sleep(backoff);
      }
    }
    console.warn(TAG, `Slot image failed after ${SLOT_ATTEMPTS} attempts — will reuse another generated image for this slot`);
    return null;
  };

  // 1) Fill every <img> slot. Generate a fresh image for each; if a single
  //    generation fails (e.g. a transient rate limit), reuse an already-generated
  //    image instead of skipping the slot. Never leave an <img> slot empty.
  const deferred: ImgSlot[] = [];
  for (const slot of slots) {
    const url = (await generate(slot.prompt)) ?? nextReuse();
    if (!url) { deferred.push(slot); continue; } // nothing generated yet — retry after we have some
    const altText = slot.alt || slot.prompt || altFallback;
    out = out.replace(slot.full, rebuildImgTag(slot.full, url, altText));
  }
  // Any slots we couldn't fill on the first pass (all early generations failed):
  // now that we (likely) have at least one image, cycle them in.
  for (const slot of deferred) {
    const url = nextReuse();
    if (!url) break; // truly no images available — final sweep strips these
    const altText = slot.alt || slot.prompt || altFallback;
    out = out.replace(slot.full, rebuildImgTag(slot.full, url, altText));
  }

  // 2) Sweep every remaining placeholder token (hero/section backgrounds,
  //    <video> posters, or any slot we couldn't fill above) so none render empty.
  if (out.includes(PLACEHOLDER)) {
    if (!urls.length) await generate(''); // ensure we have at least one image to cycle
    if (urls.length) {
      // Backgrounds: tag their element for readable text, then swap each url() with
      // a darkening scrim baked in front of a cycled image so overlaid text stays
      // legible AND adjacent hero/bands don't all show the identical photo.
      out = tagLaurenBg(out);
      out = out.replace(
        /url\(\s*['"]?__LAUREN_IMAGE__['"]?\s*\)/gi,
        () => `${SCRIM},url('${nextReuse()}')`,
      );
      // Any remaining plain tokens (img src / poster) → cycled plain fill.
      out = out.replace(/__LAUREN_IMAGE__/g, () => nextReuse() || '');
      // Belt-and-suspenders: drop any <img> that somehow ended up with an empty src.
      out = out.replace(/<img[^>]*\bsrc\s*=\s*["']\s*["'][^>]*>/gi, '');
    } else {
      // No image could be generated at all — strip placeholder imgs so nothing breaks.
      out = out.replace(/<img[^>]*\bsrc\s*=\s*["']__LAUREN_IMAGE__["'][^>]*>/gi, '').split(PLACEHOLDER).join('');
    }
  }

  // Inject the readable-text CSS once if any hero background was tagged.
  if (/\blauren-bg\b/.test(out)) out = injectLaurenStyle(out);

  if (images.length) console.log(TAG, `Generated ${images.length} image(s) for ${slug} (${slots.length} slots, stored for preview)`);
  return { html: out, images, attempted: slots.length };
}

/** Generate ONE standalone image (e.g. a Paulie social post), store its bytes in
 *  seo_images, and return the preview URL + id. Reuses the same throttle/backoff
 *  and the /api/seo/img/<id> preview endpoint as the page pipeline. content_id is
 *  left NULL until the caller links it (attachImagesToContent). Returns null only
 *  if no key is set or every attempt failed. */
export async function generateSocialImage(
  sceneDesc: string,
  ctx: { slug?: string; city?: string; keyword?: string; type?: string; aspect?: string; raw?: boolean; brand?: boolean; text?: TextOverlay } = {},
): Promise<{ id: number; previewUrl: string; repoPath: string; prompt: string } | null> {
  if (!hasImageKey()) return null;
  const cfg = { ...imageConfig(), aspect: ctx.aspect || process.env.RALPH_IMAGE_ASPECT || '1:1' };
  // raw=true: the caller (Paulie) already crafted a complete, format-aware photo
  // prompt (may allow people, before/after splits, editorial framing). Otherwise
  // wrap the scene in the standard landscaping photographic scaffold.
  const prompt = ctx.raw ? sceneDesc : buildImagePrompt(sceneDesc, ctx);
  let b64 = await generateOne(prompt, cfg);
  if (!b64) return null;
  // Copy first (bottom-left scrim), then the logo on top (bottom-right) — both
  // composited server-side so text and mark are always crisp, never AI-drawn.
  if (ctx.text) b64 = (await applyTextOverlay(b64, ctx.text)) ?? b64;
  if (ctx.brand) b64 = (await applyBrandLogo(b64)) ?? b64;
  const slug = (ctx.slug || 'social').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const db = getDb();
  const info = db.prepare(
    'INSERT INTO seo_images (content_id, idx, repo_path, prompt, data, committed) VALUES (NULL, 0, ?, ?, ?, 0)',
  ).run(`assets/ralph/${slug}.png`, prompt, b64);
  const id = Number(info.lastInsertRowid);
  return { id, previewUrl: `${PREVIEW_BASE}/${id}.png`, repoPath: `assets/ralph/${slug}.png`, prompt };
}

/** Link freshly generated images to their content row (called after INSERT). */
export function attachImagesToContent(contentId: number, imageIds: number[]): void {
  if (!imageIds.length) return;
  const db = getDb();
  const stmt = db.prepare('UPDATE seo_images SET content_id = ? WHERE id = ?');
  for (const id of imageIds) stmt.run(contentId, id);
}

/** Serve a stored image's bytes for preview (route handler helper). */
export function getImageBytes(id: number): { buffer: Buffer } | null {
  const db = getDb();
  const row = db.prepare('SELECT data FROM seo_images WHERE id = ?').get(id) as { data: string | null } | undefined;
  if (!row || !row.data) return null;
  return { buffer: Buffer.from(row.data, 'base64') };
}

/** The image ids attached to a content row, in display order (reel frame order). */
export function getContentImageIds(contentId: number): number[] {
  return (getDb().prepare('SELECT id FROM seo_images WHERE content_id = ? ORDER BY idx, id').all(contentId) as { id: number }[]).map((r) => r.id);
}

// ── Commit a binary asset to the website repo ─────────────────────────────
async function commitImageToRepo(repoPath: string, base64Png: string): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  if (!token || !repo) return false;

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'TotallyOutdoorsSEOBot/1.0 (totallyoutdoorsllc.com)',
  };
  const url = `https://api.github.com/repos/${repo}/contents/${repoPath}`;
  try {
    let sha: string | undefined;
    const getRes = await fetch(`${url}?ref=${branch}`, { headers, signal: AbortSignal.timeout(20000) });
    if (getRes.ok) {
      const existing = (await getRes.json()) as { sha?: string };
      sha = existing.sha;
    }
    const body: Record<string, string> = { message: `Lauren: add image ${repoPath}`, content: base64Png, branch };
    if (sha) body.sha = sha;
    const putRes = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    if (!putRes.ok) {
      console.warn(TAG, `Image commit failed for ${repoPath}: ${putRes.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(TAG, `Image commit error for ${repoPath}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** At publish time: commit this page's images to the repo and rewrite the page
 *  HTML from the preview endpoint URLs to the live production URLs. */
export async function commitImagesForContent(contentId: number, html: string): Promise<{ html: string; committed: number }> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, repo_path, data, committed FROM seo_images WHERE content_id = ?',
  ).all(contentId) as { id: number; repo_path: string; data: string | null; committed: number }[];
  if (!rows.length) return { html, committed: 0 };

  let out = html;
  let committed = 0;
  for (const row of rows) {
    const liveUrl = imageUrlForRepoPath(row.repo_path);
    // Commit the bytes if we still hold them and haven't already.
    if (!row.committed && row.data) {
      const ok = await commitImageToRepo(row.repo_path, row.data);
      if (ok) {
        db.prepare('UPDATE seo_images SET committed = 1, data = NULL WHERE id = ?').run(row.id);
        committed++;
      } else {
        continue; // leave the preview URL in place if the commit failed
      }
    }
    // Rewrite preview endpoint → live URL (match /api/seo/img/<id> with optional .png)
    const re = new RegExp(`${PREVIEW_BASE}/${row.id}(?:\\.png)?`, 'g');
    out = out.replace(re, liveUrl);
  }

  if (committed) console.log(TAG, `Committed ${committed} image(s) to repo for content ${contentId}`);
  return { html: out, committed };
}
