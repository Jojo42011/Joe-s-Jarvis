import { getDb } from '../db/schema';
import { geminiSeoGenerate, hasGeminiKey, stripMarkdownFences, extractHtmlContent, parseCssHrefsFromHead } from './geminiSeo';
import { fetchGithubFile, listRepoHtmlFiles } from './seoTemplate';

const TAG = '[SEO Agent]';

async function fetchPageHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TotallyOutdoorsSEOBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 25000);
  } catch {
    return null;
  }
}

export function getRawBrandSource(): string {
  const db = getDb();
  const row = db.prepare("SELECT content FROM facts WHERE category = 'seo_brand' ORDER BY created_at DESC LIMIT 1").get() as
    | { content: string }
    | undefined;
  return row?.content ?? '';
}

export function getExistingSitePages(): string[] {
  const db = getDb();
  const row = db.prepare("SELECT content FROM facts WHERE category = 'seo_site_pages' ORDER BY created_at DESC LIMIT 1").get() as
    | { content: string }
    | undefined;
  if (!row?.content) return [];
  try {
    return JSON.parse(row.content) as string[];
  } catch {
    return [];
  }
}

export async function loadWebsiteBrandContext(): Promise<string> {
  const parts: string[] = [];
  const pagePaths: string[] = [];

  const siteUrl = process.env.SEO_WEBSITE_URL?.replace(/\/$/, '');
  if (siteUrl) {
    for (const p of ['', '/about', '/services', '/contact', '/gallery']) {
      const html = await fetchPageHtml(`${siteUrl}${p}`);
      if (html) {
        parts.push(`=== LIVE PAGE: ${siteUrl}${p} ===\n${html}`);
        pagePaths.push(`${siteUrl}${p}`);
      }
    }
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';

  if (token && repo) {
    console.log(TAG, `Loading site from GitHub: ${repo}@${branch}`);
    const htmlFiles = await listRepoHtmlFiles(repo, branch, token);
    pagePaths.push(...htmlFiles);

    const priority = [
      ...htmlFiles.filter((f) => /index\.html$/i.test(f)),
      ...htmlFiles.filter((f) => !/index\.html$/i.test(f)),
    ];

    const db = getDb();
    db.prepare("DELETE FROM facts WHERE category = 'seo_site_pages'").run();
    db.prepare(`INSERT INTO facts (content, category, keywords, strength) VALUES (?, 'seo_site_pages', 'sitemap', 1.0)`).run(
      JSON.stringify([...new Set(pagePaths)]),
    );

    let indexHtml = '';
    for (const file of priority.slice(0, 15)) {
      const content = await fetchGithubFile(repo, file, branch, token);
      if (content) {
        parts.push(`=== REPO FILE: ${file} ===\n${content.slice(0, 30000)}`);
        if (/index\.html$/i.test(file) && !indexHtml) indexHtml = content;
      }
    }

    // Load the REAL stylesheets by parsing the <link rel="stylesheet"> hrefs from
    // index.html — no more guessing filenames (fixes the CSS 404).
    const head = indexHtml.match(/<head[^>]*>[\s\S]*?<\/head>/i)?.[0] ?? indexHtml;
    const cssPaths = parseCssHrefsFromHead(head);
    const cssToLoad = cssPaths.length ? cssPaths : ['css/style.css', 'styles.css', 'assets/css/style.css', 'css/main.css'];
    console.log(TAG, `Stylesheets referenced by index.html: ${cssPaths.join(', ') || '(none parsed, using fallbacks)'}`);
    let cssLoaded = 0;
    for (const css of cssToLoad.slice(0, 5)) {
      const content = await fetchGithubFile(repo, css, branch, token);
      if (content) { parts.push(`=== REPO FILE: ${css} ===\n${content.slice(0, 15000)}`); cssLoaded++; }
    }
    console.log(TAG, `Loaded ${cssLoaded} stylesheet(s), ${parts.length} source(s) total (${htmlFiles.length} HTML pages in repo)`);
  } else {
    console.warn(TAG, 'GITHUB_TOKEN or SEO_GITHUB_REPO missing');
  }

  if (!parts.length) return '';

  const combined = parts.join('\n\n').slice(0, 150000);
  const db = getDb();
  db.prepare("DELETE FROM facts WHERE category IN ('seo_brand', 'seo_brand_brief')").run();
  db.prepare(`INSERT INTO facts (content, category, keywords, strength) VALUES (?, 'seo_brand', 'website', 1.0)`).run(combined);
  return combined;
}

export async function analyzeAndStoreBrandBrief(): Promise<string> {
  const raw = getRawBrandSource();
  if (!raw) return '';
  if (!hasGeminiKey()) return raw.slice(0, 12000);

  const pages = getExistingSitePages();
  const prompt = `Analyze this Totally Outdoors LLC website and extract a DESIGN-TOKEN guide so new
pages feel on-brand while using their OWN clean layout (we do NOT clone the homepage).

PAGES: ${pages.slice(0, 40).join(', ')}
SOURCE:
${raw.slice(0, 50000)}

Extract ONLY:
- Color palette (hex values) and what each color is used for
- Font families and the size scale
- Reusable CSS class names for buttons/CTAs, cards, and sections
- Spacing/padding conventions
- Brand voice: 4-6 short phrases that capture the tone

Do NOT describe or reproduce the header, nav, footer, or hero video markup — those must
NOT be copied onto new pages.`;

  try {
    const result = await geminiSeoGenerate(prompt, {
      system: 'Front-end lead for Totally Outdoors LLC. Report design tokens (colors, fonts, class names, spacing, voice) only — never structural header/nav/footer markup.',
      maxTokens: 4096,
      useGoogleSearch: false,
    });
    const brief = stripMarkdownFences(result.text).trim();
    if (brief.length > 200) {
      getDb().prepare("DELETE FROM facts WHERE category = 'seo_brand_brief'").run();
      getDb().prepare(`INSERT INTO facts (content, category, keywords, strength) VALUES (?, 'seo_brand_brief', 'brand', 1.0)`).run(brief);
      return brief;
    }
  } catch (err) {
    console.error(TAG, 'Brand brief error:', err);
  }
  return raw.slice(0, 12000);
}

// ─── Design tokens: extract the site's *look*, not its *structure* ──────────
// The old flow shipped the full head/header/nav/footer/hero HTML into the
// generation prompt, so Gemini cloned the homepage (same nav, same video hero,
// broken markup). Instead we distill ONLY design tokens — colors, fonts, class
// names, spacing, and a few brand-voice phrases — and let the model build its
// own clean layout from them.

export interface DesignTokens {
  colors: string[];
  cssVars: { name: string; value: string }[];
  fonts: string[];
  fontSizes: string[];
  buttonClasses: string[];
  cardClasses: string[];
  sectionClasses: string[];
  spacing: string[];
  voice: string[];
}

function topBy<T>(items: T[], n: number): T[] {
  return items.slice(0, n);
}

export function extractDesignTokens(source: string): DesignTokens {
  const src = source || '';

  // Colors — rank hex values by frequency (the most-used are the brand palette).
  const colorFreq = new Map<string, number>();
  for (const m of src.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const c = m[0].toLowerCase();
    colorFreq.set(c, (colorFreq.get(c) || 0) + 1);
  }
  const colors = [...colorFreq.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);

  // CSS custom properties (often the design-system source of truth).
  const cssVars: { name: string; value: string }[] = [];
  const seenVar = new Set<string>();
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}{]+)/gi)) {
    const name = m[1].toLowerCase();
    if (seenVar.has(name)) continue;
    seenVar.add(name);
    cssVars.push({ name, value: m[2].trim().slice(0, 40) });
    if (cssVars.length >= 16) break;
  }

  // Font families + sizes actually in use.
  const fontSet = new Set<string>();
  for (const m of src.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const f = m[1].replace(/["']/g, '').trim().slice(0, 60);
    if (f && !/inherit|initial|var\(/i.test(f)) fontSet.add(f);
    if (fontSet.size >= 6) break;
  }
  const sizeSet = new Set<string>();
  for (const m of src.matchAll(/font-size\s*:\s*([^;}{]+)/gi)) {
    const s = m[1].trim().slice(0, 20);
    if (s && !/inherit|var\(/i.test(s)) sizeSet.add(s);
    if (sizeSet.size >= 12) break;
  }

  // Class names — bucketed into buttons / cards / sections so the model can reuse
  // the site's own utility classes without us handing it any markup.
  const btn = new Set<string>();
  const card = new Set<string>();
  const section = new Set<string>();
  for (const m of src.matchAll(/class\s*=\s*"([^"]*)"/gi)) {
    for (const cls of m[1].split(/\s+/)) {
      if (!cls || cls.length > 40) continue;
      const l = cls.toLowerCase();
      if (/(^|-)(btn|button|cta)(-|$)/.test(l)) btn.add(cls);
      else if (/(card|tile|feature|box|panel)/.test(l)) card.add(cls);
      else if (/(section|container|wrapper|hero|band|row|grid|col|content)/.test(l)) section.add(cls);
    }
  }

  // Spacing conventions.
  const spaceSet = new Set<string>();
  for (const m of src.matchAll(/(?:padding|margin|gap)\s*:\s*([^;}{]+)/gi)) {
    const s = m[1].trim().slice(0, 30);
    if (s && !/inherit|auto|var\(|^0$/i.test(s)) spaceSet.add(s);
    if (spaceSet.size >= 12) break;
  }

  // Brand voice — short real phrases from headings/paragraphs (tone reference only,
  // never structural markup).
  const voice: string[] = [];
  const seenV = new Set<string>();
  for (const m of src.matchAll(/<(h1|h2|h3|p)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 8 || t.length > 90) continue;
    if (/[{}<>]|lorem ipsum/i.test(t)) continue;
    const key = t.toLowerCase();
    if (seenV.has(key)) continue;
    seenV.add(key);
    voice.push(t);
    if (voice.length >= 10) break;
  }

  return {
    colors: topBy(colors, 10),
    cssVars,
    fonts: [...fontSet],
    fontSizes: [...sizeSet],
    buttonClasses: topBy([...btn], 12),
    cardClasses: topBy([...card], 12),
    sectionClasses: topBy([...section], 15),
    spacing: [...spaceSet],
    voice,
  };
}

/** Extract design tokens from the ingested site source and persist them. */
export function extractAndStoreDesignTokens(): DesignTokens {
  const tokens = extractDesignTokens(getRawBrandSource());
  const db = getDb();
  db.prepare("DELETE FROM facts WHERE category = 'seo_design_tokens'").run();
  db.prepare(`INSERT INTO facts (content, category, keywords, strength) VALUES (?, 'seo_design_tokens', 'design', 1.0)`)
    .run(JSON.stringify(tokens));
  const classCount = tokens.buttonClasses.length + tokens.cardClasses.length + tokens.sectionClasses.length;
  console.log(TAG, `Design tokens: ${tokens.colors.length} colors, ${tokens.fonts.length} fonts, ${classCount} classes, ${tokens.spacing.length} spacing, ${tokens.voice.length} voice phrases`);
  return tokens;
}

export function getDesignTokens(): DesignTokens | null {
  const db = getDb();
  const row = db.prepare("SELECT content FROM facts WHERE category = 'seo_design_tokens' ORDER BY created_at DESC LIMIT 1").get() as
    | { content: string }
    | undefined;
  if (!row?.content) return null;
  try {
    return JSON.parse(row.content) as DesignTokens;
  } catch {
    return null;
  }
}

/** Render design tokens as a compact, prompt-friendly block. */
export function formatDesignTokensPrompt(t: DesignTokens | null): string {
  if (!t) return '';
  const lines: string[] = [];
  if (t.colors.length) lines.push(`COLOR PALETTE (hex, most-used first): ${t.colors.join(', ')}`);
  if (t.cssVars.length) lines.push(`CSS VARIABLES: ${t.cssVars.map((v) => `${v.name}: ${v.value}`).join('; ')}`);
  if (t.fonts.length) lines.push(`FONT FAMILIES: ${t.fonts.join(' | ')}`);
  if (t.fontSizes.length) lines.push(`FONT SIZES IN USE: ${t.fontSizes.join(', ')}`);
  if (t.buttonClasses.length) lines.push(`BUTTON CLASSES (reuse for CTAs): ${t.buttonClasses.join(', ')}`);
  if (t.cardClasses.length) lines.push(`CARD/TILE CLASSES: ${t.cardClasses.join(', ')}`);
  if (t.sectionClasses.length) lines.push(`SECTION/LAYOUT CLASSES: ${t.sectionClasses.join(', ')}`);
  if (t.spacing.length) lines.push(`SPACING CONVENTIONS: ${t.spacing.join(', ')}`);
  if (t.voice.length) lines.push(`BRAND VOICE (sample phrases — match this tone, do NOT copy verbatim): ${t.voice.map((v) => `"${v}"`).join(' ')}`);
  return lines.join('\n');
}

export function getBrandContext(): string {
  const db = getDb();
  const brief = db.prepare("SELECT content FROM facts WHERE category = 'seo_brand_brief' ORDER BY created_at DESC LIMIT 1").get() as
    | { content: string }
    | undefined;
  if (brief?.content) return brief.content.slice(0, 14000);
  return getRawBrandSource().slice(0, 14000);
}

export function getRepoTemplateHtml(): string {
  const raw = getRawBrandSource();
  const indexMatch = raw.match(/=== REPO FILE: ([^\n]*index\.html) ===\n([\s\S]*?)(?=\n=== |$)/i);
  if (indexMatch?.[2]) return indexMatch[2].slice(0, 50000);
  const firstHtml = raw.match(/=== REPO FILE: ([^\n]+\.html) ===\n([\s\S]*?)(?=\n=== |$)/i);
  return firstHtml?.[2]?.slice(0, 50000) ?? '';
}

function enrichPreviewHtml(html: string): string {
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  if (!repo || /<base\s/i.test(html)) return html;
  const base = `https://raw.githubusercontent.com/${repo}/${branch}/`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
  }
  return `<head><base href="${base}"></head>${html}`;
}

export function htmlForPreview(content: string, type: string): string {
  let cleaned = extractHtmlContent(content).trim();
  if (!/<!doctype|<html/i.test(cleaned)) {
    if (type === 'city_page' || type === 'blog') {
      cleaned = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Preview</title></head><body>${cleaned}</body></html>`;
    } else {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;padding:24px;background:#111;color:#eee;}pre{white-space:pre-wrap;}</style></head><body><pre>${cleaned.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body></html>`;
    }
  }
  return enrichPreviewHtml(cleaned);
}

export function wipeSeoWorkspace(): { content: number; plan: number; keywords: number; competitors: number; images: number } {
  const db = getDb();
  db.prepare("DELETE FROM facts WHERE category LIKE 'seo_%'").run();
  // Drop generated image bytes tied to uncommitted drafts (published pages keep theirs).
  let images = 0;
  try {
    images = db.prepare(
      'DELETE FROM seo_images WHERE content_id IS NULL OR content_id IN (SELECT id FROM seo_content WHERE committed = 0)',
    ).run().changes;
  } catch { /* table may not exist on older DBs */ }
  return {
    content: db.prepare('DELETE FROM seo_content WHERE committed = 0').run().changes,
    plan: db.prepare('DELETE FROM seo_weekly_plan').run().changes,
    keywords: db.prepare('DELETE FROM seo_keywords').run().changes,
    competitors: db.prepare('DELETE FROM seo_competitors').run().changes,
    images,
  };
}
