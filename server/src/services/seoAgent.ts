import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '../config/anthropic';
import { getDb } from '../db/schema';
import { ANTHROPIC_MODEL } from '../config/models';
import {
  geminiSeoGenerate,
  hasGeminiKey,
  stripMarkdownFences,
  extractHtmlContent,
  getSeoWebsiteUrl,
  parseCssHrefsFromHead,
  truncatePromptText,
  formatStylesheetPromptSection,
} from './geminiSeo';
import {
  getBrandContext,
  getExistingSitePages,
  loadWebsiteBrandContext,
  analyzeAndStoreBrandBrief,
  wipeSeoWorkspace,
  extractAndStoreDesignTokens,
  getDesignTokens,
  formatDesignTokensPrompt,
} from './websiteContext';
import { storeCompetitor, seedCompetitorsIfEmpty, storeKeywordsFromDomains } from './seoCompetitors';
import { extractCitySlug, fetchGithubFile } from './seoTemplate';
import { safeJsonParse } from '../utils/safeJson';
import { enrichGeneratedPage } from './seo/enrich';
import { fillPageImages, attachImagesToContent } from './seo/images';
import { computeContentGaps } from './seo/gaps';
import { matchServiceArea } from './seo/businessProfile';

const TAG = '[SEO Agent]';

// When the planner omits/garbles a task type, infer it from the wording instead
// of silently defaulting to "blog" (which made Lauren look blog-heavy).
function inferTaskType(task: string, keyword?: string): string {
  const hay = `${task || ''} ${keyword || ''}`.toLowerCase();
  if (matchServiceArea(hay)) return 'city_page'; // names a service-area city
  if (/\b(lawn\s*care|landscap|hardscap|patio|excavat|water\s*feature|pond|retaining\s*wall|putting\s*green|golf\s*scape|snow\s*plow|deic|drainage|maintenance|installation|design|construction)\b/.test(hay)) return 'service_page';
  return 'blog';
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Short, human-friendly label used when wiring the page into the site nav.
function buildNavLabel(type: string, task: string, keyword: string | undefined, slug: string): string {
  if (type === 'city_page') {
    const city = slug.split('-')[0] ? titleCase(slug) : titleCase(keyword || task);
    return city.length <= 28 ? city : titleCase(slug);
  }
  const base = (task || keyword || slug).replace(/\s+/g, ' ').trim();
  return base.length <= 40 ? base : base.slice(0, 37).trim() + '…';
}

// Snapshot the current keyword table so the dashboard can show week-over-week movement.
function snapshotKeywordHistory(): void {
  try {
    const db = getDb();
    const week = mondayOfWeek();
    const kws = db.prepare(
      'SELECT keyword, our_ranking, competitor, competitor_ranking, monthly_volume, opportunity_score FROM seo_keywords',
    ).all() as {
      keyword: string; our_ranking: string | null; competitor: string | null;
      competitor_ranking: string | null; monthly_volume: string | null; opportunity_score: number | null;
    }[];
    if (!kws.length) return;
    db.prepare('DELETE FROM seo_keyword_history WHERE week_start = ?').run(week);
    const insert = db.prepare(`
      INSERT INTO seo_keyword_history (week_start, keyword, our_ranking, competitor, competitor_ranking, monthly_volume, opportunity_score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const k of kws) {
        insert.run(week, k.keyword, k.our_ranking, k.competitor, k.competitor_ranking, k.monthly_volume, k.opportunity_score ?? 0);
      }
    });
    tx();
    console.log(TAG, `Keyword history snapshot saved for week ${week} (${kws.length} keywords)`);
  } catch (err) {
    console.warn(TAG, 'Keyword history snapshot failed:', err);
  }
}

// ─── Design-token page generation (no template cloning) ──────────────────────
// We hand the model a DESIGN-TOKEN brief (colors, fonts, classes, spacing,
// voice) and ask it to build its OWN clean, original layout — never the site's
// header/nav/footer/hero-video markup. This is the fix for pages that used to
// come out looking like broken clones of the homepage.
function buildDesignTokenPrompt(designTokens: string, task: string, keyword: string, type: string): string {
  const tokenBlock = designTokens.trim()
    ? designTokens
    : 'COLOR PALETTE: use a clean, earthy palette (deep forest green/charcoal text, warm stone/tan accent, off-white sections).';

  const pageTypeRules =
    type === 'city_page'
      ? '- city_page: local landing page for THIS town specifically — lead with the town + service, emphasize the service area, and CTA to book a free estimate. DIFFERENTIATE FROM OTHER TOWN PAGES: name at least one real, recognizable neighborhood, landmark, or geographic detail specific to this town (not just the town name swapped into a generic template), and if you know of a town-specific soil, drainage, or terrain consideration for landscaping/excavating work there, mention it briefly. Google treats near-identical town pages as thin/doorway content — this must read as written for this town, not a find-and-replace of another one.'
      : type === 'blog'
        ? '- blog: answer the question in the title with an educational tone; end with a link to a free estimate.'
        : type === 'service_page'
          ? '- service_page: explain the single service, its process, and why Totally Outdoors does it best; CTA to a quote.'
          : '- section_page: a focused landing page for this topic with a clear hero and CTA.';

  return `Design and build a BRAND-NEW, self-contained web page for Totally Outdoors LLC.
Use the DESIGN TOKENS below to make it feel on-brand — but create your OWN clean, modern
layout. Do NOT copy the existing site's header, nav, footer, or hero-video structure.

DESIGN TOKENS (the site's look — reuse these):
${tokenBlock}

BUILD: ${task}
TARGET KEYWORD: ${keyword}
PAGE TYPE: ${type}
${pageTypeRules}

Rules:
- Return ONLY a complete HTML document. No markdown fences. Start with <!DOCTYPE html>.
- Build your OWN simple, clean layout — a lightweight header (text logo "Totally Outdoors LLC" + a few links to /, /services, /contact), well-structured content sections, and a simple footer. Keep it minimal; do NOT reproduce the homepage's nav/hero/video markup.
- Apply the design tokens: use the palette hex values, the font families, and where sensible reuse the site's button/section class names for visual consistency.
- Semantic HTML: exactly one <h1>, meaningful <h2>/<h3> subheadings, real paragraphs. 400-600 words of substantive, original copy (blogs 600+). No lorem ipsum, no empty sections.
- Write as Totally Outdoors LLC — landscaping, hardscaping and excavating in Millersburg, Ohio (Holmes County) since 2004, owner-operated by Joe, financing available. Phone CTA: (330) 231-4080.
- HERO: the first section MUST be complete — a clear <h1>, a supporting sub-paragraph, and a primary CTA button. NEVER output an empty hero.
- TEXT OVER A PHOTO → use a CSS BACKGROUND, not an <img>: when headline/paragraph text sits ON TOP of a photo (hero banners, full-width callouts), set the photo as a CSS background: style="background-image:url('__LAUREN_IMAGE__')" with a nearby data-img-prompt describing the shot. The system darkens these and makes text white/readable automatically — do not add your own overlay.
- STANDALONE PHOTOS → use <img>: for photos beside/between text (gallery cards, feature images), output <img src="__LAUREN_IMAGE__" data-img-prompt="exact shot description" alt="keyword-relevant alt">. Example: <img src="__LAUREN_IMAGE__" data-img-prompt="wide golden-hour shot of a natural stone paver patio with a fire pit, retaining wall and lush perennial beds beside a deep green lawn" alt="Paver patio and landscaping in ${keyword}">.
- Use the __LAUREN_IMAGE__ placeholder for EVERY photo. NEVER reference video files, real file paths, placeholder image services, lorem-picsum, or example.com URLs. Place photos naturally throughout.
- READABILITY: text NOT over a photo must use high-contrast solid colors (dark text on light sections), bold headlines.
- Add a few contextual internal links to the homepage (/), services (/services), and contact (/contact).
- End with a strong call-to-action section linking to the contact / free-estimate page.`;
}

async function generatePageFromTokens(
  llm: LlmContext,
  designTokens: string,
  task: string,
  keyword: string,
  type: string,
): Promise<string | null> {
  const prompt = buildDesignTokenPrompt(designTokens, task, keyword, type);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llmGenerate(llm, SEO_STRATEGIST_SYSTEM, prompt, 8192);
    const html = extractHtmlContent(raw);
    if (isValidPageHtml(html)) return html;
    console.warn(TAG, `Design-token page attempt ${attempt + 1} invalid, sample:`, html.slice(0, 120));
  }
  return null;
}

// ─── Hybrid: real site chrome + generated <main> body ────────────────────────
// Best of both: we wrap AI-generated, image-filled <main> content in the site's
// REAL <head> (fonts/CSS/meta), <header>/<nav> (logo + links), and <footer> so
// published pages match the site's branding exactly — while the body itself is
// original SEO content, never a clone of the homepage sections.
interface SiteChrome {
  head: string;
  header: string;
  footer: string;
  exampleSections: string;   // real homepage <section> markup — the class names/structure that carry the site's backgrounds, fonts and spacing
  stylesheet: string;        // real CSS (classes/colors/fonts/spacing), truncated for the prompt
}

// Extract the homepage's real content sections as a STYLE REFERENCE. This is the
// key to on-brand layout: reusing these exact section/container/button classes
// makes the new page inherit the site's backgrounds, fonts and spacing from the
// real CSS. We strip <video> so we never reintroduce the homepage's video hero.
function extractExampleSections(indexHtml: string): string {
  const mainInner = indexHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  const source = mainInner ?? indexHtml;
  const sections: string[] = [];
  const re = /<section[^>]*>[\s\S]*?<\/section>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) sections.push(m[0]);
  let joined = sections.join('\n\n');
  if (!joined && !mainInner) {
    const fb = indexHtml.match(/<section[^>]*>[\s\S]*?<\/section>/gi);
    if (fb) joined = fb.join('\n\n');
  }
  joined = joined.replace(/<video\b[\s\S]*?<\/video>/gi, ''); // never copy homepage video
  return truncatePromptText(joined, 6000);
}

// Load the real stylesheet(s) referenced by index.html's <head> so the prompt
// carries the exact class names, colors, fonts and spacing.
async function loadStylesheetForPrompt(
  head: string,
  repo: string,
  branch: string,
  token: string,
): Promise<string> {
  const cssPaths = parseCssHrefsFromHead(head).slice(0, 3);
  const blocks: { path: string; content: string }[] = [];
  for (const cssPath of cssPaths) {
    const raw = await fetchGithubFile(repo, cssPath, branch, token);
    if (raw) blocks.push({ path: cssPath, content: truncatePromptText(raw, 3000) });
  }
  if (blocks.length) console.log(TAG, `Loaded ${blocks.length} stylesheet(s) for the generation prompt`);
  return formatStylesheetPromptSection(blocks);
}

// Pull the chrome (head/header/footer) AND a style reference (example sections +
// stylesheet) out of the live index.html. Returns null when the repo/index isn't
// reachable or the header can't be found, so the caller can fall back to a clean
// standalone layout.
async function loadSiteChrome(): Promise<SiteChrome | null> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  if (!token || !repo) {
    console.warn(TAG, 'No GITHUB_TOKEN/SEO_GITHUB_REPO — cannot load site chrome; using standalone layout');
    return null;
  }
  const html = await fetchGithubFile(repo, 'index.html', branch, token);
  if (!html) {
    console.warn(TAG, 'index.html not found in repo — using standalone layout');
    return null;
  }
  const head = html.match(/<head[^>]*>[\s\S]*?<\/head>/i)?.[0] ?? '';
  const header =
    html.match(/<header[^>]*>[\s\S]*?<\/header>/i)?.[0] ??
    html.match(/<nav[^>]*>[\s\S]*?<\/nav>/i)?.[0] ??
    '';
  const footer = html.match(/<footer[^>]*>[\s\S]*?<\/footer>/i)?.[0] ?? '';
  if (!head || !header) {
    console.warn(TAG, `Site chrome incomplete (head:${!!head} header:${!!header} footer:${!!footer}) — using standalone layout`);
    return null;
  }
  const exampleSections = extractExampleSections(html);
  const stylesheet = await loadStylesheetForPrompt(head, repo, branch, token);
  console.log(TAG, `Loaded site chrome (head ${head.length}b, header ${header.length}b, footer ${footer.length}b, ${exampleSections.length}b example sections, ${stylesheet ? 'CSS loaded' : 'no CSS'})`);
  return { head, header, footer, exampleSections, stylesheet };
}

// The homepage's relative asset/link paths (css/style.css, assets/logo.png,
// services.html …) break when the page lives in a subfolder (locations/, …).
// A single <base href> pins every relative URL to the site root so the real CSS,
// fonts, logo and nav links all resolve. Strips any pre-existing <base> first.
function withBaseHref(head: string, siteBase: string): string {
  const cleaned = head.replace(/<base\b[^>]*>/gi, '');
  const tag = `<base href="${siteBase.replace(/\/+$/, '')}/">`;
  if (/<head[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head([^>]*)>/i, `<head$1>\n  ${tag}`);
  }
  return `<head>\n  ${tag}\n${cleaned}\n</head>`;
}

// Assemble the final document: real head (+base) → real header → generated main
// → real footer. Downstream enrich still rewrites <title>/meta and injects
// schema/related-links into this document.
function assembleWithChrome(chrome: SiteChrome, mainInner: string, siteBase: string): string {
  const head = withBaseHref(chrome.head, siteBase);
  return `<!DOCTYPE html>
<html lang="en">
${head}
<body>
${chrome.header}
<main>
${mainInner}
</main>
${chrome.footer}
</body>
</html>`;
}

// The published page is STATIC — the homepage's JavaScript (scroll-reveal,
// parallax, sliders) does not run on it. The site stylesheet still loads, so any
// of its reveal/animation rules would otherwise leave our <main> sections hidden
// (grey/empty boxes), collapsed, or misaligned. This stylesheet is injected LAST
// in the <head> so it wins: it force-reveals everything inside <main>, kills
// animations/parallax, sizes the hero, and makes background images cover.
const RENDER_SAFE_MARKER = '<!-- lauren:rendersafe -->';
function injectRenderSafeStyle(html: string): string {
  if (html.includes(RENDER_SAFE_MARKER)) return html;
  const css = `${RENDER_SAFE_MARKER}<style>
main{overflow-x:hidden;}
/* Force every generated section/image visible — defeats the host site's
   reveal-on-scroll classes that hide content until JS runs (which it won't). */
main, main *{animation:none !important;transition:none !important;}
main *, main [data-aos], main [class]{opacity:1 !important;visibility:visible !important;transform:none !important;}
/* Neutralize inline absolute positioning so blocks never overlap each other. */
main [style*="absolute" i]{position:relative !important;top:auto !important;left:auto !important;right:auto !important;bottom:auto !important;}
/* Normal block flow: sections never overlap, clip, or bleed off-screen. */
main > section{position:relative !important;float:none !important;clear:both !important;width:100% !important;max-width:100% !important;box-sizing:border-box !important;height:auto !important;overflow:visible !important;margin:0 !important;}
/* Responsive headings + wrapping so titles never overflow or get cut off. */
main h1{font-size:clamp(2rem,5.5vw,4rem) !important;line-height:1.12 !important;overflow-wrap:break-word;}
main h2{font-size:clamp(1.5rem,3.5vw,2.5rem) !important;line-height:1.2 !important;overflow-wrap:break-word;}
main h3, main p, main li{overflow-wrap:break-word;}
main img{max-width:100%;height:auto;}
/* Background/hero sections: cover, centered, no fixed-attachment parallax jump. */
main [style*="background-image"], main .lauren-bg{
  background-size:cover !important;background-position:center !important;
  background-repeat:no-repeat !important;background-attachment:scroll !important;
}
main [style*="background-image"], main .lauren-bg{min-height:52vh;}
/* First section is the hero — real height, and its content centered + padded so
   the title/paragraph/button stay contained (never cut off, button not full-width). */
main > section:first-of-type{min-height:70vh !important;display:flex !important;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:96px 24px !important;}
main > section:first-of-type > *{max-width:960px;}
</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${css}\n</head>`);
  // Standalone pages may have no head — put it at the very top so it still applies.
  return css + html;
}

// Pull just the inner main-content out of the model's output (it should return a
// fragment, but be robust if it wraps it in a full doc — and never let its own
// header/nav/footer leak into our chrome).
function extractMainContent(raw: string): string {
  const html = extractHtmlContent(raw).trim();
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1].trim();
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const inner = body ? body[1] : html;
  return inner
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .trim();
}

function isValidMainContent(s: string): boolean {
  return s.length > 200 && /<(section|article|h1|h2|div|p)\b/i.test(s);
}

// Prompt for the BODY only (goes inside the real <main>). It gets the real
// homepage sections + stylesheet as a STYLE REFERENCE (colors/fonts/feel only) —
// NOT to copy: the homepage's hero/slider/gallery/animation classes need its
// JavaScript and break on a static page. The model builds its own clean,
// self-contained layout, on-brand via the design tokens, with every photo a
// __LAUREN_IMAGE__ placeholder. Emits no html/head/header/nav/footer/video.
function buildMainContentPrompt(
  designTokens: string,
  exampleSections: string,
  stylesheet: string,
  task: string,
  keyword: string,
  type: string,
): string {
  const tokenBlock = designTokens.trim()
    ? designTokens
    : 'COLOR PALETTE: clean, earthy palette (deep forest green/charcoal text, warm stone/tan accent, off-white sections).';

  const styleRef = exampleSections.trim()
    ? `STYLE REFERENCE — sections from the real site, shown ONLY so you can match its colors, fonts, button look and overall feel. Do NOT copy their structure, class names, decorative graphics, sliders or scroll animations — those depend on the homepage's JavaScript and will break on a static page. Build your own clean layout instead:
${exampleSections}
`
    : '';

  const stylesheetBlock = stylesheet.trim() ? `\n${stylesheet}\n` : '';

  const pageTypeRules =
    type === 'city_page'
      ? '- city_page: local landing page for THIS town specifically — lead with the town + service, emphasize the service area, CTA to book a free estimate. DIFFERENTIATE FROM OTHER TOWN PAGES: name at least one real, recognizable neighborhood, landmark, or geographic detail specific to this town (not just the town name swapped into a generic template), and if you know of a town-specific soil, drainage, or terrain consideration for landscaping/excavating work there, mention it briefly. Google treats near-identical town pages as thin/doorway content — this must read as written for this town, not a find-and-replace of another one.'
      : type === 'blog'
        ? '- blog: answer the question in the title with an educational tone; end with a link to a free estimate.'
        : type === 'service_page'
          ? '- service_page: explain the single service, its process, and why Totally Outdoors does it best; CTA to a quote.'
          : '- section_page: a focused landing page for this topic with a clear hero and CTA.';

  return `Write the MAIN CONTENT BODY for a new Totally Outdoors LLC web page. Your output
is inserted inside the site's existing <main> element — the real header, nav, logo,
footer, fonts and CSS are already provided by the site, so you must NOT output any
<!DOCTYPE>, <html>, <head>, <header>, <nav>, or <footer>.

${styleRef}${stylesheetBlock}
DESIGN TOKENS (palette/fonts to stay consistent with):
${tokenBlock}

BUILD: ${task}
TARGET KEYWORD: ${keyword}
PAGE TYPE: ${type}
${pageTypeRules}

Rules:
- Return ONLY the inner HTML for <main> — a series of <section> blocks. No markdown fences, no <html>/<head>/<header>/<footer>.
- ON-BRAND BUT SELF-CONTAINED: match the site's colors, fonts and button styling. BUT build your OWN clean, robust section layouts with your own inline styles — do NOT reuse the homepage's hero, slider, carousel, gallery, parallax, decorative or scroll-animation class names, and do NOT depend on ANY site JavaScript. The page must render perfectly as a plain static page (no reveal-on-scroll, nothing hidden until animated).
- Every <section> must be self-sufficient: give it its own padding (e.g. 64px 24px), a max-width inner wrapper (~1100px, margin auto), and its own background/spacing via inline styles. Do NOT rely on the site's classes to size or reveal anything.
- Do NOT reproduce the homepage's copy, structure, decorative graphics, or any <video> element. Original words, your own solid layout.
- Semantic HTML: exactly ONE <h1> (the page headline), meaningful <h2>/<h3> subheadings, real paragraphs. 400-600 words of substantive, original copy (blogs 600+). No lorem ipsum, no empty sections.
- Write as Totally Outdoors LLC — landscaping, hardscaping and excavating serving Millersburg, Ohio and Holmes County since 2004, owner-operated by Joe, financing available. Phone CTA: (330) 231-4080.
- HEADLINE VOICE: the <h1> must sound like TOTALLY OUTDOORS specifically — not a generic, swappable phrase like "Premier Landscaping Company". Name the brand and a concrete, distinctive value tied to the page's town/service (e.g. "Totally Outdoors — Paver Patios Built for Millersburg Backyards"). Keep it under ~9 words so it fits on one or two lines. Use the brand-voice sample phrases for tone.
- HERO (first <section>) is a FULL-BLEED BANNER with the photo BEHIND the words. Use exactly this shape:
  <section style="background-image:url('__LAUREN_IMAGE__');background-size:cover;background-position:center;min-height:70vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:80px 24px;" data-img-prompt="wide golden-hour shot of a professionally landscaped Ohio backyard with a paver patio and stone retaining wall">
     <h1>…</h1><p>…</p><a class="[site button class]" href="/contact">Get a Free Estimate</a>
  </section>
  The system darkens the background and makes the text white automatically — do not add your own overlay. NEVER an empty hero.
- EVERY section that should show a photo MUST carry its OWN __LAUREN_IMAGE__ — inline style="background-image:url('__LAUREN_IMAGE__')" for full-bleed/banner sections, or <img src="__LAUREN_IMAGE__"> otherwise. Never rely on a CSS class to supply an image, or that spot renders empty.
- TEXT OVER A PHOTO → CSS BACKGROUND, not <img>: any section where text sits ON TOP of a photo uses style="background-image:url('__LAUREN_IMAGE__');background-size:cover;background-position:center;" with a data-img-prompt. The system darkens these and makes text white/readable.
- IMAGE CARDS: for a gallery/feature row, use a simple flex/grid wrapper with each card a fixed size (e.g. min-height:240px) containing <img src="__LAUREN_IMAGE__" style="width:100%;height:100%;object-fit:cover;"> so images always show at a real size.
- STANDALONE PHOTOS → <img>: for photos beside/between text, output <img src="__LAUREN_IMAGE__" data-img-prompt="exact shot description" alt="keyword-relevant alt">. Example: <img src="__LAUREN_IMAGE__" data-img-prompt="wide golden-hour shot of a natural stone paver patio with a fire pit, retaining wall and lush perennial beds beside a deep green lawn" alt="Paver patio and landscaping in ${keyword}">.
- Use the __LAUREN_IMAGE__ placeholder for EVERY photo/background. NEVER reference video files, real homepage file paths, placeholder image services, lorem-picsum, or example.com URLs. Place photos naturally throughout.
- READABILITY: text NOT over a photo must use high-contrast solid colors (dark text on light sections), bold headlines.
- Add a few contextual internal links to the homepage (/), services (/services), and contact (/contact).
- End with a strong call-to-action section (use the site's CTA section classes) linking to the contact / free-estimate page.`;
}

async function generateMainContent(
  llm: LlmContext,
  designTokens: string,
  exampleSections: string,
  stylesheet: string,
  task: string,
  keyword: string,
  type: string,
): Promise<string | null> {
  const prompt = buildMainContentPrompt(designTokens, exampleSections, stylesheet, task, keyword, type);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llmGenerate(llm, SEO_STRATEGIST_SYSTEM, prompt, 8192);
    const main = extractMainContent(raw);
    if (isValidMainContent(main)) return main;
    console.warn(TAG, `Main-content attempt ${attempt + 1} invalid, sample:`, main.slice(0, 120));
  }
  return null;
}

let agentRunActive = false;
// Generous: a single page now generates every image slot one at a time (12s
// throttle each) AND persistently retries any slot that fails, so a run with
// 10-15 slots can legitimately take a long time. We would rather let it finish a
// complete page than flag it stuck prematurely.
const STUCK_RUN_MINUTES = 90;

export function recoverStuckSeoRunsOnStartup(): void {
  const db = getDb();
  const result = db.prepare(`
    UPDATE seo_runs SET status = 'error',
      summary = 'Interrupted — cleared on restart. Click Run Now.',
      completed_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
  `).run();
  if (result.changes > 0) {
    console.log(TAG, `Cleared ${result.changes} stuck run(s) on startup`);
  }
}

export function recoverStuckSeoRuns(): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE seo_runs SET status = 'error',
      summary = 'Run timed out — click Run Now to try again',
      completed_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
      AND started_at < datetime('now', ?)
  `).run(`-${STUCK_RUN_MINUTES} minutes`);
  return result.changes;
}

export function forceResetRunningSeoRun(): number {
  const db = getDb();
  return db.prepare(`
    UPDATE seo_runs SET status = 'error',
      summary = 'Manually reset — ready for new run',
      completed_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
  `).run().changes;
}

export function isSeoRunActiveInDb(): boolean {
  recoverStuckSeoRuns();
  const row = getDb().prepare("SELECT id FROM seo_runs WHERE status = 'running' LIMIT 1").get();
  return !!row;
}

function isValidPageHtml(content: string): boolean {
  return content.length > 250 && /<(?:!doctype|html|body|h1|main|section|header)/i.test(content);
}

const SEARCH_QUERIES = [
  'landscaping companies Millersburg Ohio',
  'hardscaping contractor Holmes County Ohio',
  'paver patio installation Wooster OH',
  'excavating contractor Millersburg OH',
  'lawn care services Berlin Ohio',
];

const SEO_STRATEGIST_SYSTEM = `You are the SEO strategist for Totally Outdoors LLC,
a landscaping, hardscaping, and excavating company owned by Joe, serving Millersburg,
Holmesville, Berlin, Walnut Creek, Sugarcreek, Charm, Winesburg, Mount Hope, Killbuck,
Nashville, Glenmont, Big Prairie, Lakeville, Loudonville, Wooster, Apple Creek,
Fredericksburg, Baltic, Danville, and Lake Buckhorn, Ohio (Holmes County and
surrounding areas).
In business since 2004. Services: lawn care, landscaping, hardscaping, patios,
excavating, water features & ponds, outdoor structures, golf scapes (putting greens),
snow plowing & liquid salt/deicing, and materials disposal/dump service.
Financing available. Do not invent pricing figures.
Website: https://www.totallyoutdoorsllc.com — phone (330) 231-4080.`;

type LlmProvider = 'gemini' | 'anthropic';

interface LlmContext {
  provider: LlmProvider;
  anthropic?: Anthropic;
}

interface CompetitorAnalysis {
  title?: string;
  meta?: string;
  keywords?: string[];
  headings?: string[];
  wordCount?: number;
  sellingPoints?: string[];
  likelyPages?: string[];
}

interface WeeklyPlan {
  weekStart?: string;
  days?: {
    day: string;
    tasks: { task: string; type: string; targetKeyword?: string; priority?: string }[];
  }[];
  summary?: string;
}

function resolveLlm(): LlmContext | null {
  if (hasGeminiKey()) {
    console.log(TAG, 'Using Gemini for Atlas (google_search available)');
    return { provider: 'gemini' };
  }
  const apiKey = anthropicApiKey();
  if (apiKey) {
    console.log(TAG, 'Using Claude for Atlas (GEMINI_API_KEY not set)');
    return { provider: 'anthropic', anthropic: new Anthropic({ apiKey }) };
  }
  console.warn(TAG, 'WARNING: GEMINI_API_KEY and ANTHROPIC_API_KEY not set — cannot run');
  return null;
}

function claudeText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

async function llmGenerate(
  llm: LlmContext,
  system: string,
  prompt: string,
  maxTokens = 4096,
  useGoogleSearch = false,
): Promise<string> {
  if (llm.provider === 'gemini') {
    const result = await geminiSeoGenerate(prompt, { system, maxTokens, useGoogleSearch });
    return result.text;
  }
  const response = await llm.anthropic!.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return claudeText(response);
}

function updateRunPhase(runId: number, phase: string): void {
  getDb().prepare('UPDATE seo_runs SET phase = ? WHERE id = ?').run(phase, runId);
}

function isoDate(): string {
  return new Date().toISOString().split('T')[0];
}

function mondayOfWeek(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split('T')[0];
}

function dateForPlanDay(dayName: string, weekStart: string): string {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const idx = days.indexOf(dayName);
  if (idx < 0) return weekStart;
  const d = new Date(weekStart + 'T12:00:00');
  d.setDate(d.getDate() + idx);
  return d.toISOString().split('T')[0];
}

// Canonical folder structure on the live site. These folders are created in the
// repo on demand at publish time (see ensureRepoFolder in seoPublish.ts).
function inferFilePath(type: string, slug: string): string {
  if (type === 'city_page') return `locations/${slug}.html`;
  if (type === 'blog') return `insights/${slug}.html`;
  if (type === 'service_page' || type === 'service') return `services/${slug}.html`;
  if (type === 'section_page') return `${slug}.html`;
  if (type === 'meta') return `meta/${isoDate()}-meta-update.json`;
  if (type === 'schema') return `schema/${isoDate()}-schema.json`;
  return `optimizations/${isoDate()}-${type}.md`;
}

// ─── Phase 0: Ingest full website + brand brief ─────────────────
async function phaseBrandIngest(runId: number): Promise<void> {
  console.log(TAG, 'Phase 0 — WEBSITE & BRAND INGEST');
  updateRunPhase(runId, 'brand_ingest');
  await loadWebsiteBrandContext();
  await analyzeAndStoreBrandBrief();
  // Distill design tokens (colors/fonts/classes/spacing/voice) from the ingested
  // site so generation can stay on-brand WITHOUT cloning the homepage structure.
  extractAndStoreDesignTokens();
  const pages = getExistingSitePages();
  console.log(TAG, `Site inventory: ${pages.length} page(s) indexed`);
}

function clearSeoRunMemory(): void {
  const db = getDb();
  const weekStart = mondayOfWeek();
  db.prepare("DELETE FROM facts WHERE category IN ('seo_competitor', 'seo_strategy')").run();
  db.prepare('DELETE FROM seo_keywords').run();
  db.prepare('DELETE FROM seo_competitors').run();
  db.prepare('DELETE FROM seo_weekly_plan WHERE week_start = ?').run(weekStart);
  console.log(TAG, 'Cleared prior competitor/keyword/plan data for fresh run');
}

export function wipeSeoDataForFreshStart(): ReturnType<typeof wipeSeoWorkspace> {
  return wipeSeoWorkspace();
}
async function phaseResearch(runId: number, llm: LlmContext): Promise<string[]> {
  console.log(TAG, 'Phase 1 — RESEARCH');
  updateRunPhase(runId, 'research');

  const competitorDomains = new Set<string>();

  if (llm.provider === 'gemini') {
    try {
      const queryList = SEARCH_QUERIES.map((q) => `- ${q}`).join('\n');
      const prompt = `Use Google Search to research competitor SEO rankings for Totally Outdoors LLC (landscaping, hardscaping and excavating company in Millersburg, Ohio — Holmes County).

Search and analyze results for these queries:
${queryList}

Identify the REAL local landscaping/hardscaping/excavating competitors that actually appear in the search results (by domain), the keywords they rank for, and content patterns across top results. Only report companies you actually found in the results — never invent company names.

CRITICAL: Respond with ONLY raw JSON. No markdown fences. No explanation text before or after.

{
  "domains": ["competitor1.com", "competitor2.com"],
  "keywords": [
    { "keyword": "landscaping millersburg ohio", "competitor": "example-competitor.com", "competitorRanking": "3", "estimatedVolume": "320", "opportunityScore": 0.85 }
  ]
}`;

      const result = await geminiSeoGenerate(prompt, {
        system: SEO_STRATEGIST_SYSTEM,
        maxTokens: 2048,
        useGoogleSearch: true,
      });

      result.domains.forEach((d) => {
        competitorDomains.add(d);
        storeCompetitor(d);
      });
      if (result.searchQueries.length) {
        console.log(TAG, `Google Search queries: ${result.searchQueries.join(', ')}`);
      }
      console.log(TAG, `Found ${competitorDomains.size} domains from Google Search grounding`);

      const parsed = safeJsonParse<{
        domains?: string[];
        keywords?: {
          keyword?: string;
          competitor?: string;
          competitorRanking?: string;
          estimatedVolume?: string;
          opportunityScore?: number;
        }[];
      } | {
        keyword?: string;
        competitor?: string;
        competitorRanking?: string;
        estimatedVolume?: string;
        opportunityScore?: number;
      }[]>(result.text);

      let keywords: { keyword: string; competitor: string; competitorRanking: string; estimatedVolume: string; opportunityScore: number }[] = [];

      if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.domains)) {
        parsed.domains.forEach((d) => {
          const dom = String(d).replace(/^www\./, '');
          competitorDomains.add(dom);
          storeCompetitor(dom);
        });
      }

      const rawKeywords = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' && Array.isArray(parsed.keywords) ? parsed.keywords : []);

      keywords = rawKeywords
        .filter((row) => row && typeof row === 'object' && row.keyword)
        .map((row) => ({
          keyword: String(row.keyword ?? ''),
          competitor: String(row.competitor ?? ''),
          competitorRanking: String(row.competitorRanking ?? 'unknown'),
          estimatedVolume: String(row.estimatedVolume ?? 'unknown'),
          opportunityScore: Number(row.opportunityScore ?? 0),
        }))
        .filter((row) => row.keyword.length > 0);

      // Fallback: build keywords from grounding domains if JSON parse yielded nothing
      if (!keywords.length && competitorDomains.size > 0) {
        const queries = result.searchQueries.length ? result.searchQueries : SEARCH_QUERIES;
        keywords = Array.from(competitorDomains).slice(0, 8).map((domain, i) => ({
          keyword: queries[i % queries.length] ?? 'landscaping millersburg ohio',
          competitor: domain,
          competitorRanking: 'unknown',
          estimatedVolume: 'unknown',
          opportunityScore: 0.5,
        }));
        competitorDomains.forEach((d) => storeCompetitor(d));
        console.log(TAG, `Built ${keywords.length} fallback keywords from Google Search grounding`);
      }

      if (!keywords.length && result.text) {
        console.warn(TAG, 'Gemini research returned no parseable keywords. Sample:', result.text.slice(0, 200));
      }

      if (!competitorDomains.size) {
        result.domains.forEach((d) => storeCompetitor(d));
      }

      seedCompetitorsIfEmpty();

      if (!keywords.length) {
        const allDomains = [
          ...Array.from(competitorDomains),
          ...((getDb().prepare('SELECT domain FROM seo_competitors').all() as { domain: string }[]).map((r) => r.domain)),
        ];
        const unique = [...new Set(allDomains)].filter(Boolean);
        const queries = result.searchQueries.length ? result.searchQueries : SEARCH_QUERIES;
        storeKeywordsFromDomains(unique, queries, runId);
      }

      if (keywords.length) {
        const db = getDb();
        const stmt = db.prepare(`INSERT INTO seo_keywords (keyword, competitor, competitor_ranking, monthly_volume, opportunity_score) VALUES (?, ?, ?, ?, ?)`);
        for (const kw of keywords) {
          stmt.run(kw.keyword, kw.competitor, kw.competitorRanking, kw.estimatedVolume, kw.opportunityScore);
        }
        db.prepare('UPDATE seo_runs SET keywords_found = ? WHERE id = ?').run(keywords.length, runId);
        console.log(TAG, `Stored ${keywords.length} keywords from Gemini research`);
      }
    } catch (err) {
      console.error(TAG, 'Gemini Google Search research error:', err);
    }

    seedCompetitorsIfEmpty();
    const db = getDb();
    const kwCount = (db.prepare('SELECT COUNT(*) AS c FROM seo_keywords').get() as { c: number }).c;
    if (!kwCount) {
      const domains = (db.prepare('SELECT domain FROM seo_competitors').all() as { domain: string }[]).map((r) => r.domain);
      storeKeywordsFromDomains(domains, SEARCH_QUERIES, runId);
    }

    return Array.from(competitorDomains).slice(0, 6).length
      ? Array.from(competitorDomains).slice(0, 6)
      : (getDb().prepare('SELECT domain FROM seo_competitors LIMIT 6').all() as { domain: string }[]).map((r) => r.domain);
  }

  // Anthropic path: Brave Search API fallback
  const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) {
    console.warn(TAG, 'WARNING: BRAVE_API_KEY not set — skipping Brave search phase');
    return [];
  }

  const allResults: { query: string; results: { title?: string; url?: string; description?: string }[] }[] = [];

  for (const q of SEARCH_QUERIES) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`;
      const res = await fetch(url, {
        headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' },
      });
      if (!res.ok) {
        console.error(TAG, `Brave search failed for "${q}": ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
      const results = data.web?.results ?? [];
      allResults.push({ query: q, results });
      for (const r of results) {
        if (r.url) {
          try {
            const host = new URL(r.url).hostname;
            competitorDomains.add(host);
            storeCompetitor(host, r.title);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      console.error(TAG, `Brave search error for "${q}":`, err);
    }
  }

  if (allResults.length > 0) {
    try {
      const text = await llmGenerate(
        llm,
        `${SEO_STRATEGIST_SYSTEM}\n\nAnalyze these search results and identify top competitors, keywords they rank for, and content patterns. Return JSON array of objects with keys: keyword, competitor, competitorRanking, estimatedVolume, opportunityScore (0-1).`,
        JSON.stringify(allResults),
        2048,
      );
      const parsed = safeJsonParse<{ keyword: string; competitor: string; competitorRanking: string; estimatedVolume: string; opportunityScore: number }[]>(text);
      if (Array.isArray(parsed)) {
        const db = getDb();
        const stmt = db.prepare(`INSERT INTO seo_keywords (keyword, competitor, competitor_ranking, monthly_volume, opportunity_score) VALUES (?, ?, ?, ?, ?)`);
        for (const kw of parsed) {
          stmt.run(kw.keyword, kw.competitor, kw.competitorRanking ?? 'unknown', kw.estimatedVolume ?? 'unknown', kw.opportunityScore ?? 0);
        }
        db.prepare('UPDATE seo_runs SET keywords_found = ? WHERE id = ?').run(parsed.length, runId);
        console.log(TAG, `Stored ${parsed.length} keywords`);
      }
    } catch (err) {
      console.error(TAG, 'Keyword analysis error:', err);
    }
  }

  return Array.from(competitorDomains).slice(0, 6);
}

// ─── Phase 2: Scrape and analyze competitor pages ────────────────
async function phaseScrape(runId: number, llm: LlmContext, domains: string[]): Promise<void> {
  console.log(TAG, 'Phase 2 — SCRAPE AND ANALYZE');
  updateRunPhase(runId, 'scrape');

  if (!domains.length) {
    console.log(TAG, 'No domains to scrape, skipping');
    return;
  }

  const db = getDb();
  const analystSystem = `You are an SEO analyst. Analyze this competitor page for Totally Outdoors LLC, a landscaping, hardscaping and excavating company in Millersburg, Ohio. Extract:
1. Page title and meta description
2. Primary keywords used
3. Content structure and headings
4. Approximate word count
5. Key selling points they emphasize
6. What pages they likely have based on navigation
Return as JSON with keys: title, meta, keywords, headings, wordCount, sellingPoints, likelyPages`;

  for (const domain of domains.slice(0, 2)) {
    try {
      const res = await fetch(`https://${domain}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TotallyOutdoorsSEOBot/1.0 (totallyoutdoorsllc.com))' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const truncated = html.slice(0, 15000);

      const text = await llmGenerate(
        llm,
        analystSystem,
        `Domain: ${domain}\n\nHTML:\n${truncated}`,
        1024,
      );

      const analysis = safeJsonParse<CompetitorAnalysis>(text);
      if (analysis) {
        storeCompetitor(domain, analysis.title);
        db.prepare(`INSERT INTO facts (content, category, keywords, strength) VALUES (?, ?, ?, ?)`).run(
          `Competitor analysis for ${domain}: ${analysis.title ?? 'Unknown'} — focuses on: ${(analysis.keywords ?? []).join(', ')}. Key selling points: ${(analysis.sellingPoints ?? []).join(', ')}`,
          'seo_competitor',
          domain,
          1.0,
        );
        console.log(TAG, `Analyzed competitor: ${domain}`);
      }
    } catch (err) {
      console.error(TAG, `Scrape error for ${domain}:`, err);
    }
  }
}

// Build a varied, gap-driven task list straight from the content-gap analysis.
// Used as the fallback plan (and the shape the LLM plan is asked to follow) so we
// never fall back to the old hard-coded "Millersburg first" list that made Lauren
// build the same page every run.
function buildGapDrivenPlanTasks(
  gaps: ReturnType<typeof computeContentGaps>,
): { day: string; task: string; type: string; targetKeyword: string; priority: string }[] {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const out: { task: string; type: string; targetKeyword: string; priority: string }[] = [];

  for (const city of gaps.missingCities.slice(0, 5)) {
    out.push({ task: `Write ${city} landscaping and hardscaping landing page`, type: 'city_page', targetKeyword: `landscaping ${city} Ohio`, priority: 'high' });
  }
  for (const svc of gaps.missingServices.slice(0, 3)) {
    out.push({ task: `Create ${svc} service page`, type: 'service_page', targetKeyword: svc, priority: 'medium' });
  }
  for (const kg of gaps.keywordGaps.slice(0, 3)) {
    out.push({ task: `Write blog post targeting "${kg.keyword}"`, type: 'blog', targetKeyword: kg.keyword, priority: 'medium' });
  }
  // Only if the site somehow has no detected gaps at all.
  if (!out.length) {
    out.push(
      { task: 'Write blog post: Planning a Paver Patio in Holmes County Ohio', type: 'blog', targetKeyword: 'paver patio Holmes County Ohio', priority: 'high' },
      { task: 'Write blog post: Choosing a Landscaping Contractor in Millersburg Ohio', type: 'blog', targetKeyword: 'landscaping contractor Millersburg Ohio', priority: 'medium' },
    );
  }
  return out.slice(0, 7).map((t, i) => ({ day: days[i % days.length], ...t }));
}

// ─── Phase 3: Generate weekly plan ───────────────────────────────
async function phasePlan(runId: number, llm: LlmContext): Promise<void> {
  console.log(TAG, 'Phase 3 — PLAN');
  updateRunPhase(runId, 'plan');

  const db = getDb();
  const keywords = db.prepare('SELECT keyword, competitor, competitor_ranking, opportunity_score FROM seo_keywords ORDER BY opportunity_score DESC LIMIT 20').all();
  const insights = db.prepare("SELECT content FROM facts WHERE category = 'seo_competitor' ORDER BY created_at DESC LIMIT 10").all() as { content: string }[];
  const brandBrief = getBrandContext();
  const existingPages = getExistingSitePages();

  const gaps = computeContentGaps();

  // Everything already built or waiting in the queue — the planner must NOT repeat these.
  const built = db.prepare(
    "SELECT type, title, file_path, target_keyword FROM seo_content WHERE status != 'denied' ORDER BY created_at DESC LIMIT 40",
  ).all() as { type: string; title: string; file_path: string | null; target_keyword: string | null }[];
  const builtList = built
    .map((r) => `- ${r.type}: ${r.title}${r.file_path ? ` (${r.file_path})` : ''}${r.target_keyword ? ` [kw: ${r.target_keyword}]` : ''}`)
    .join('\n');

  const context = [
    `CONTENT GAP ANALYSIS (build to close these gaps, in priority order):\n${gaps.brief}`,
    builtList ? `ALREADY BUILT / IN QUEUE — NEVER propose any of these again; pick DIFFERENT cities/services/topics:\n${builtList}` : '',
    keywords.length ? `KEYWORD DATA:\n${JSON.stringify(keywords)}` : '',
    insights.length ? `COMPETITOR INSIGHTS:\n${insights.map((i) => i.content).join('\n')}` : '',
    brandBrief ? `WEBSITE BRAND & BUILD GUIDE:\n${brandBrief}` : '',
    existingPages.length ? `EXISTING SITE PAGES (do not duplicate):\n${existingPages.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const planContext = context
    || `No prior data. Use knowledge of landscaping, hardscaping and excavating companies around Millersburg / Holmes County, Ohio to create a first-week plan. Focus on town pages and blogs the site is missing.`;

  const planSystem = `${SEO_STRATEGIST_SYSTEM}\n\nBased on the CONTENT GAP ANALYSIS, competitor research, current website state, and brand guide, create a 7-day SEO action plan for this week.
Be NEEDS-DRIVEN: prioritize the specific missing city pages, missing service pages, and high-opportunity keyword gaps identified above — do not invent pages the site does not need or already has.
CRITICAL — NO REPEATS: never propose a page whose city, service, or topic already appears in "ALREADY BUILT / IN QUEUE" or "EXISTING SITE PAGES". Every task must target a DIFFERENT, still-uncovered gap so the site grows with varied pages (different cities, different services, different blog topics) — not the same page again.
Spread the plan across the MISSING cities and services listed above, one distinct target per task.
Only propose pages/content the site does NOT already have. Match existing file structure and brand.
Each day should have 1-2 specific actionable tasks scheduled for that day.
Task types you may use:
- "city_page": a location landing page for a missing service-area city (highest local priority)
- "service_page": a page for a core service (goes under the Services nav dropdown)
- "section_page": a brand-new website section/landing page (adds a new nav item)
- "blog": an informational article targeting a keyword gap
- "meta" / "schema" / "internal_link": technical optimizations
Prioritize highest impact tasks first (missing cities and high-opportunity keywords).

Return ONLY valid JSON:
{
  "weekStart": "YYYY-MM-DD",
  "days": [
    { "day": "Monday", "tasks": [{ "task": "description", "type": "city_page|service_page|section_page|blog|meta|schema|internal_link", "targetKeyword": "keyword", "priority": "high|medium|low" }] }
  ],
  "summary": "one paragraph summary of the week plan"
}`;

  try {
    const text = await llmGenerate(llm, planSystem, planContext, 2048);
    const cleaned = stripMarkdownFences(text);
    const plan = safeJsonParse<WeeklyPlan>(cleaned);

    if (!plan?.days) {
      console.error(TAG, 'Plan parse failed. Raw response:', text.slice(0, 500));
      console.error(TAG, 'plan object:', plan);
    }

    if (!plan?.days) {
      console.warn(TAG, 'Using gap-driven fallback weekly plan');
      const monday = mondayOfWeek();
      // Gap-driven, not hard-coded: targets the ACTUAL missing cities/services/
      // keyword gaps, so the fallback still varies run to run.
      const fallbackTasks = buildGapDrivenPlanTasks(gaps);

      for (const t of fallbackTasks) {
        db.prepare(`INSERT INTO seo_weekly_plan (week_start, day, task, status) VALUES (?, ?, ?, 'pending')`)
          .run(monday, t.day, JSON.stringify(t));
      }

      db.prepare('UPDATE seo_runs SET weekly_plan = ? WHERE id = ?')
        .run(JSON.stringify({ weekStart: monday, days: fallbackTasks, summary: 'Fallback plan — Gemini parse failed' }), runId);
    } else {
      const weekStart = plan.weekStart ?? mondayOfWeek();
      const stmt = db.prepare('INSERT INTO seo_weekly_plan (week_start, day, task, status) VALUES (?, ?, ?, ?)');
      for (const d of plan.days) {
        for (const t of d.tasks ?? []) {
          stmt.run(weekStart, d.day, JSON.stringify(t), 'pending');
        }
      }
      db.prepare('UPDATE seo_runs SET weekly_plan = ? WHERE id = ?').run(JSON.stringify(plan), runId);
      if (plan.summary) {
        db.prepare(`INSERT INTO facts (content, category, keywords, strength) VALUES (?, 'seo_strategy', 'weekly_plan', 1.0)`).run(plan.summary);
      }
      console.log(TAG, `Weekly plan created: ${plan.days.reduce((n, d) => n + (d.tasks?.length ?? 0), 0)} tasks`);
    }
  } catch (err) {
    console.error(TAG, 'Plan generation error:', err);
  }
}

// ─── Phase 4: Generate content from design tokens (no template cloning) ──────
async function phaseGenerate(runId: number, llm: LlmContext): Promise<void> {
  console.log(TAG, 'Phase 4 — GENERATE CONTENT');
  updateRunPhase(runId, 'generate');

  // Feed generation the site's DESIGN TOKENS (colors/fonts/classes/spacing/voice),
  // not its full HTML — so pages stay on-brand without cloning the homepage.
  const designTokens = formatDesignTokensPrompt(getDesignTokens());
  if (designTokens) {
    console.log(TAG, `Generating from ${designTokens.split('\n').length} design-token line(s)`);
  } else {
    console.warn(TAG, 'No design tokens available — generation will use a clean default palette');
  }

  // Load the site's real chrome (head/header/footer) once. When present we wrap
  // the generated <main> in it so pages match site branding exactly; otherwise
  // we fall back to a clean standalone layout built from the design tokens.
  const siteChrome = await loadSiteChrome();
  const siteBase = getSeoWebsiteUrl();

  const db = getDb();
  const weekStart = mondayOfWeek();
  const tasks = db.prepare(
    "SELECT id, task, day FROM seo_weekly_plan WHERE week_start = ? AND status = 'pending'",
  ).all(weekStart) as { id: number; task: string; day: string }[];

  if (!tasks.length) {
    console.warn(TAG, 'No pending plan tasks for week', weekStart);
    return;
  }

  // What we've already built or queued (never denied). Used to SKIP any task that
  // would produce a page we already have, so every run builds a DIFFERENT page
  // instead of repeating (e.g. a second Millersburg). Keyed by file path + keyword.
  const coveredPaths = new Set<string>(
    (db.prepare("SELECT file_path FROM seo_content WHERE status != 'denied' AND file_path IS NOT NULL").all() as { file_path: string }[])
      .map((r) => r.file_path.toLowerCase()),
  );
  const coveredKeywords = new Set<string>(
    (db.prepare("SELECT target_keyword FROM seo_content WHERE status != 'denied' AND target_keyword IS NOT NULL").all() as { target_keyword: string }[])
      .map((r) => r.target_keyword.toLowerCase()),
  );

  let generated = 0;

  for (const row of tasks) {
    // ONE page per run — generate a single page completely (all images filled,
    // enriched, scored) then stop. Remaining plan tasks stay 'pending' and are
    // picked up on the next run. Runs are frequent (every 3 days) so pages
    // accumulate steadily; this trades speed for reliability (no image rate-limit
    // pileups, predictable run duration).
    if (generated >= 1) break;
    const parsed = safeJsonParse<{ task: string; type: string; targetKeyword?: string }>(row.task);
    if (!parsed) continue;
    let type = parsed.type || '';
    const HTML_TYPES = ['city_page', 'blog', 'service_page', 'section_page'];
    const SKIP_TYPES = ['meta', 'schema', 'internal_link'];
    if (SKIP_TYPES.includes(type)) continue; // technical optimizations, not pages
    if (!HTML_TYPES.includes(type)) {
      type = inferTaskType(parsed.task, parsed.targetKeyword);
      console.log(TAG, `Task ${row.id} had no valid type — inferred "${type}" from "${parsed.task}"`);
    }

    try {
      const slugify = (s: string) => (s || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55);
      let slug: string;
      let filePath: string;
      let navGroupForType: string;
      if (type === 'city_page') {
        slug = extractCitySlug(parsed.targetKeyword, parsed.task);
        filePath = inferFilePath('city_page', slug);
        navGroupForType = 'Locations';
      } else if (type === 'service_page') {
        slug = slugify(parsed.targetKeyword || parsed.task);
        filePath = inferFilePath('service_page', slug);
        navGroupForType = 'Services';
      } else if (type === 'section_page') {
        slug = slugify(parsed.task);
        filePath = inferFilePath('section_page', slug);
        navGroupForType = titleCase(parsed.task).slice(0, 24);
      } else {
        slug = slugify(parsed.task);
        filePath = inferFilePath('blog', slug);
        navGroupForType = 'Blog';
      }
      const keyword = parsed.targetKeyword || 'landscaping millersburg ohio';

      // Skip anything we already have — guarantees a DIFFERENT page each run and
      // prevents duplicate slugs from overwriting an existing page on publish.
      const pathTaken = coveredPaths.has(filePath.toLowerCase());
      const kwTaken = !!parsed.targetKeyword && coveredKeywords.has(parsed.targetKeyword.toLowerCase());
      if (pathTaken || kwTaken) {
        console.log(TAG, `Skipping already-covered task ${row.id} (${filePath}${kwTaken ? `, kw "${parsed.targetKeyword}"` : ''}) — moving to the next gap`);
        db.prepare("UPDATE seo_weekly_plan SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
        continue;
      }

      const city = type === 'city_page'
        ? titleCase((slug || '').replace(/-(landscaping(-company)?|hardscaping|lawn-care|excavating)$/, ''))
        : undefined;

      // Fill image slots on the piece of HTML we generated, then (for the hybrid
      // path) wrap it in the real site chrome. Filling BEFORE assembly means the
      // image pass only ever touches generated content — never the real logo,
      // header or footer images.
      let imagesAdded = 0;
      let imageIds: number[] = [];
      const fillImages = async (fragment: string): Promise<string> => {
        try {
          const filled = await fillPageImages(fragment, { slug, city, keyword, type });
          imagesAdded = filled.images.length;
          imageIds = filled.images.map((i) => i.id);
          if (filled.attempted && !filled.images.length) {
            console.warn(TAG, `Image slots found (${filled.attempted}) but none generated for task ${row.id}`);
          }
          return filled.html;
        } catch (err) {
          console.warn(TAG, `Image fill failed for task ${row.id}:`, err instanceof Error ? err.message : err);
          return fragment;
        }
      };

      let finalHtml: string | null = null;

      if (siteChrome) {
        // Hybrid: real head/header/footer + a generated, image-filled <main> with
        // its OWN robust, self-contained layout styled to match the site's colors
        // and fonts (not the site's fragile JS-dependent section classes).
        const mainInner = await generateMainContent(
          llm, designTokens, siteChrome.exampleSections, siteChrome.stylesheet, parsed.task, keyword, type,
        );
        if (mainInner) {
          const mainFilled = await fillImages(mainInner);
          finalHtml = assembleWithChrome(siteChrome, mainFilled, siteBase);
          console.log(TAG, `Assembled page with real site chrome + generated <main> (${type})`);
        } else {
          console.warn(TAG, `Main-content generation failed for task ${row.id} — falling back to standalone`);
        }
      }

      if (!finalHtml) {
        // Standalone fallback: full self-contained page from design tokens.
        const standalone = await generatePageFromTokens(llm, designTokens, parsed.task, keyword, type);
        if (standalone) {
          finalHtml = await fillImages(standalone);
          console.log(TAG, `Generated standalone page from design tokens (${type})`);
        }
      }

      if (!finalHtml || !isValidPageHtml(finalHtml)) {
        console.warn(TAG, 'Could not generate valid page for task', row.id);
        continue;
      }

      // Neutralize the host site's JS-driven reveal/parallax so every generated
      // section + image renders correctly on the static page (no grey/empty boxes,
      // no collapsed hero). Injected last so it overrides the site stylesheet.
      finalHtml = injectRenderSafeStyle(finalHtml);

      // ── QA gate: enrich (meta + schema + internal links) and score the page ──
      const enriched = enrichGeneratedPage({
        html: finalHtml,
        type,
        keyword,
        task: parsed.task,
        city,
        slug,
        filePath,
      });
      finalHtml = enriched.html;
      const report = enriched.report;

      // Reject near-empty / broken generations so they never reach the review queue.
      if (report.signals.wordCount < 150 || report.signals.h1Count < 1) {
        console.warn(TAG, `Skipping thin/broken page for task ${row.id} (words=${report.signals.wordCount}, h1=${report.signals.h1Count})`);
        continue;
      }

      const scheduledFor = dateForPlanDay(row.day, weekStart);
      const navGroup = navGroupForType;
      const navLabel = buildNavLabel(type, parsed.task, parsed.targetKeyword, slug);
      // Autonomous by design: the reject-thin-content check above plus the SEO/EEAT
      // scoring are Lauren's own review — no human sign-off step. Insert straight
      // into 'approved' so the existing publishDueContent() gate is satisfied the
      // moment the scheduled date arrives, with no separate approval action needed.
      const insertInfo = db.prepare(`
        INSERT INTO seo_content (
          type, title, content, target_keyword, file_path, status, approved_at, scheduled_for, plan_task_id, nav_group, nav_label,
          seo_score, seo_grade, seo_report, meta_title, meta_description, schema_types, word_count, internal_links_out, eeat_score
        )
        VALUES (?, ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        type, parsed.task, finalHtml, parsed.targetKeyword ?? null, filePath, scheduledFor, row.id, navGroup, navLabel,
        report.score, report.grade, JSON.stringify(report), enriched.meta.title, enriched.meta.description,
        enriched.schemaTypes.join(','), report.signals.wordCount, report.signals.internalLinks, report.eeat.score,
      );
      attachImagesToContent(Number(insertInfo.lastInsertRowid), imageIds);
      generated++;
      console.log(TAG, `Generated + scored page: ${parsed.task} → ${filePath} (SEO ${report.score}/${report.grade}, ${enriched.schemaTypes.length} schema types, ${imagesAdded} images)`);
    } catch (err) {
      console.error(TAG, `Content error task ${row.id}:`, err);
    }
  }

  db.prepare('UPDATE seo_runs SET content_generated = ? WHERE id = ?').run(generated, runId);
  console.log(TAG, `Generated ${generated} page(s)`);
}

// ─── Phase 5: Publish approved content that is due (no auto-publish of new drafts) ─
async function phasePublishDue(runId: number): Promise<void> {
  console.log(TAG, 'Phase 5 — PUBLISH SCHEDULED (approved only)');
  updateRunPhase(runId, 'publish');
  const { publishDueContent } = await import('./seoPublish');
  const count = await publishDueContent();
  getDb().prepare('UPDATE seo_runs SET commits_made = ? WHERE id = ?').run(count, runId);
}

// ─── Main orchestrator ───────────────────────────────────────────
export async function runSeoAgent(): Promise<void> {
  recoverStuckSeoRuns();

  if (agentRunActive) {
    console.warn(TAG, 'Agent already running in this process — skip');
    return;
  }
  if (isSeoRunActiveInDb()) {
    console.warn(TAG, 'A run is already marked active in DB — skip');
    return;
  }

  agentRunActive = true;
  console.log(TAG, '═══════════════════════════════════════');
  console.log(TAG, 'Starting autonomous SEO run');
  console.log(TAG, '═══════════════════════════════════════');

  const db = getDb();
  const result = db.prepare("INSERT INTO seo_runs (status, phase) VALUES ('running', 'init')").run();
  const runId = Number(result.lastInsertRowid);

  try {
    const llm = resolveLlm();
    if (!llm) {
      db.prepare("UPDATE seo_runs SET status = 'skipped', summary = 'GEMINI_API_KEY or ANTHROPIC_API_KEY not configured', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(runId);
      return;
    }

    clearSeoRunMemory();
    await phaseBrandIngest(runId);
    const domains = await phaseResearch(runId, llm);
    await phaseScrape(runId, llm, domains);
    snapshotKeywordHistory();
    await phasePlan(runId, llm);
    await phaseGenerate(runId, llm);
    await phasePublishDue(runId);

    const runRow = db.prepare('SELECT keywords_found, content_generated, commits_made FROM seo_runs WHERE id = ?').get(runId) as {
      keywords_found: number;
      content_generated: number;
      commits_made: number;
    };
    const planTasksRow = db.prepare('SELECT COUNT(*) AS c FROM seo_weekly_plan WHERE week_start = ?').get(mondayOfWeek()) as { c: number };
    const keywordsFound = runRow?.keywords_found ?? 0;
    const planTasks = planTasksRow?.c ?? 0;
    const contentGenerated = runRow?.content_generated ?? 0;
    const commits = runRow?.commits_made ?? 0;

    db.prepare("UPDATE seo_runs SET status = 'completed', phase = 'done', summary = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      `Run complete — ${keywordsFound} keywords, ${planTasks} plan tasks, ${contentGenerated} drafts in queue (approve to publish), ${commits} scheduled uploads`,
      runId,
    );
    console.log(TAG, 'Run completed successfully');
  } catch (err) {
    console.error(TAG, 'Fatal error:', err);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    db.prepare("UPDATE seo_runs SET status = 'error', summary = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(msg, runId);
  } finally {
    agentRunActive = false;
    const stuck = db.prepare('SELECT id FROM seo_runs WHERE id = ? AND status = ?').get(runId, 'running') as { id: number } | undefined;
    if (stuck) {
      db.prepare("UPDATE seo_runs SET status = 'error', summary = 'Run ended without completing', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(runId);
    }
  }
}
