// ─── Enrichment pipeline: the QA gate every generated page passes through ───
// Takes raw LLM-generated HTML and returns production-grade HTML:
//   1. Optimize <title> + meta description (length-safe, keyword + CTA)
//   2. Inject LocalBusiness/Service/Breadcrumb/(FAQ) JSON-LD
//   3. Guarantee hub-and-spoke internal links (no orphans)
//   4. Audit the result → 0–100 score + full report
// Pure string transforms — deterministic, no network, no LLM.

import { optimizeMeta } from './meta';
import { injectSchema, SchemaContext } from './schema';
import { buildRelatedBlock, injectRelatedBlock } from './internalLinks';
import { auditPage, SeoReport } from './audit';
import { getBusinessProfile } from './businessProfile';
import { liveUrlForPath } from '../seoNav';

export interface EnrichInput {
  html: string;
  type: string;           // city_page | blog | ...
  keyword?: string;
  task?: string;
  city?: string;
  slug?: string;
  filePath?: string;
}
export interface EnrichResult {
  html: string;
  report: SeoReport;
  meta: { title: string; description: string };
  schemaTypes: string[];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/** Replace or insert <title>. */
function applyTitle(html: string, title: string): string {
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n  <title>${escapeHtml(title)}</title>`);
  }
  return html;
}

/** Replace or insert <meta name="description">. */
function applyDescription(html: string, description: string): string {
  const tag = `<meta name="description" content="${escapeAttr(description)}">`;
  const re = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*>/i;
  if (re.test(html)) return html.replace(re, tag);
  if (/<\/title>/i.test(html)) return html.replace(/<\/title>/i, `</title>\n  ${tag}`);
  if (/<head([^>]*)>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>\n  ${tag}`);
  return html;
}

/** Extract any visible FAQ pairs so they can be promoted to FAQPage schema. */
export function extractFaqs(html: string): { question: string; answer: string }[] {
  const faqs: { question: string; answer: string }[] = [];
  const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Pattern: a question heading followed by a paragraph answer.
  const re = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && faqs.length < 10) {
    const q = text(m[1]);
    const a = text(m[2]);
    if (/\?$/.test(q) && a.length > 30) faqs.push({ question: q, answer: a });
  }
  return faqs;
}

export function enrichGeneratedPage(input: EnrichInput): EnrichResult {
  const p = getBusinessProfile();
  let html = input.html;

  // 1. Meta optimization
  const meta = optimizeMeta({ type: input.type, keyword: input.keyword, city: input.city, task: input.task });
  html = applyTitle(html, meta.title);
  html = applyDescription(html, meta.description);

  // 2. Internal links (hub-and-spoke) — do before audit so links count
  const relatedBlock = buildRelatedBlock({ type: input.type, citySlug: input.slug });
  html = injectRelatedBlock(html, relatedBlock);

  // 3. Schema injection
  const pageUrl = input.filePath ? (liveUrlForPath(input.filePath) || `${p.url}`) : p.url;
  const faqs = extractFaqs(html);
  const ctx: SchemaContext = {
    type: input.type,
    pageUrl,
    title: meta.title,
    description: meta.description,
    city: input.city,
    keyword: input.keyword,
    faqs: faqs.length ? faqs : undefined,
  };
  const injected = injectSchema(html, ctx);
  html = injected.html;

  // 4. Audit final result
  const report = auditPage(html, { keyword: input.keyword, type: input.type, city: input.city });

  return { html, report, meta, schemaTypes: injected.types };
}
