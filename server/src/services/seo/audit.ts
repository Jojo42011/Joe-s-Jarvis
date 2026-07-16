// ─── Full-page SEO audit + 0–100 scoring ───
// Deterministic, dependency-free HTML analysis. Produces an overall score, a
// per-dimension breakdown, an E-E-A-T sub-score, local-SEO signals, and a
// prioritized issue list — the QA gate every generated page passes through.

import { getBusinessProfile } from './businessProfile';
import { scoreMeta, textHasKeyword } from './meta';
import { validateSchema } from './schema';
import { countInternalLinks } from './internalLinks';

export interface AuditIssue {
  level: 'error' | 'warn' | 'ok';
  msg: string;
}
export interface AuditDimension {
  label: string;
  score: number;
  max: number;
}
export interface SeoReport {
  score: number;            // 0–100 overall
  grade: string;            // A / B / C / D / F
  passed: boolean;          // ≥ threshold
  dimensions: AuditDimension[];
  issues: AuditIssue[];
  eeat: { score: number; experience: boolean; expertise: boolean; authority: boolean; trust: boolean };
  meta: { title: string; description: string; titleLen: number; descLen: number };
  schema: { valid: boolean; types: string[]; errors: string[]; warnings: string[] };
  signals: {
    wordCount: number;
    h1Count: number;
    h2Count: number;
    internalLinks: number;
    images: number;
    imagesWithAlt: number;
    hasLocalNap: boolean;
    hasPhone: boolean;
    answerBlocks: number;
  };
  generatedAt: string;
}

const PASS_THRESHOLD = 75;

function textContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTitle(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
}
function getMetaDescription(html: string): string {
  const m = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  return (m?.[1] || '').trim();
}
function getH1s(html: string): string[] {
  return [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => textContent(m[1]));
}

function grade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

export interface AuditOptions {
  keyword?: string;
  type?: string;       // city_page | blog | ...
  city?: string;
}

export function auditPage(html: string, opts: AuditOptions = {}): SeoReport {
  const p = getBusinessProfile();
  const issues: AuditIssue[] = [];
  const dims: AuditDimension[] = [];
  const body = textContent(html);
  const bodyLower = body.toLowerCase();
  const kw = (opts.keyword || '').toLowerCase().trim();
  const type = opts.type || 'blog';

  // ── Meta (18) ──
  const title = getTitle(html);
  const desc = getMetaDescription(html);
  const meta = scoreMeta(title, desc, opts.keyword);
  const metaPts = Math.round((meta.score / 100) * 18);
  dims.push({ label: 'Meta tags', score: metaPts, max: 18 });
  meta.issues.filter((i) => i.level !== 'ok').forEach((i) => issues.push({ level: i.level, msg: `Meta: ${i.msg}` }));

  // ── Headings (12) ──
  const h1s = getH1s(html);
  const h2Count = (html.match(/<h2[\b>]/gi) || []).length || (html.match(/<h2[\s>]/gi) || []).length;
  let headingPts = 0;
  if (h1s.length === 1) headingPts += 6;
  else if (h1s.length === 0) issues.push({ level: 'error', msg: 'No <h1> heading' });
  else issues.push({ level: 'error', msg: `Multiple <h1> headings (${h1s.length}) — use exactly one` });
  if (kw && h1s.some((h) => textHasKeyword(h, opts.keyword))) headingPts += 4;
  else if (kw && h1s.length) issues.push({ level: 'warn', msg: 'Target keyword not in H1' });
  if (h2Count >= 2) headingPts += 2;
  else issues.push({ level: 'warn', msg: 'Add more H2 subheadings for structure' });
  dims.push({ label: 'Headings', score: headingPts, max: 12 });

  // ── Content depth (16) ──
  const wordCount = body ? body.split(/\s+/).length : 0;
  const minWords = type === 'blog' ? 600 : 400;
  let depthPts = 0;
  if (wordCount >= minWords) depthPts += 12;
  else if (wordCount >= minWords * 0.6) { depthPts += 7; issues.push({ level: 'warn', msg: `Thin content: ${wordCount} words (aim ${minWords}+)` }); }
  else { depthPts += 2; issues.push({ level: 'error', msg: `Thin content: ${wordCount} words (need ${minWords}+)` }); }
  // keyword presence in body (word-order independent)
  if (kw && textHasKeyword(body, opts.keyword)) depthPts += 4;
  else if (kw) issues.push({ level: 'warn', msg: 'Target keyword not found in body copy' });
  dims.push({ label: 'Content depth', score: depthPts, max: 16 });

  // ── Internal linking (14) ──
  const internalLinks = countInternalLinks(html, p.url);
  let linkPts = 0;
  if (internalLinks >= 3) linkPts = 14;
  else if (internalLinks === 2) { linkPts = 9; issues.push({ level: 'warn', msg: 'Only 2 internal links (aim 3+)' }); }
  else if (internalLinks === 1) { linkPts = 5; issues.push({ level: 'warn', msg: 'Only 1 internal link — risks orphan page' }); }
  else { linkPts = 0; issues.push({ level: 'error', msg: 'Orphan page: no internal links' }); }
  dims.push({ label: 'Internal links', score: linkPts, max: 14 });

  // ── Schema (16) ──
  const schema = validateSchema(html);
  let schemaPts = 0;
  if (schema.valid && schema.types.length) {
    schemaPts = 12;
    if (schema.types.some((t) => /LocalBusiness|GeneralContractor/.test(t))) schemaPts += 2;
    if (schema.types.includes('BreadcrumbList')) schemaPts += 2;
  } else if (schema.blocks > 0) { schemaPts = 5; }
  schemaPts = Math.min(16, schemaPts);
  dims.push({ label: 'Structured data', score: schemaPts, max: 16 });
  schema.errors.forEach((e) => issues.push({ level: 'error', msg: `Schema: ${e}` }));

  // ── Images (8) ──
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const images = imgTags.length;
  const imagesWithAlt = imgTags.filter((t) => /\balt\s*=\s*["'][^"']*\S[^"']*["']/i.test(t)).length;
  let imgPts = 8;
  if (images > 0) {
    const ratio = imagesWithAlt / images;
    imgPts = Math.round(ratio * 8);
    if (ratio < 1) issues.push({ level: 'warn', msg: `${images - imagesWithAlt}/${images} images missing alt text` });
  }
  dims.push({ label: 'Images & alt', score: imgPts, max: 8 });

  // ── Local SEO signals (10) ──
  const hasPhone = bodyLower.includes(p.phoneDigits) || new RegExp(p.phone.replace(/[()\-.\s]/g, '[()\\-.\\s]*')).test(body);
  const hasCity = !!opts.city && bodyLower.includes(opts.city.toLowerCase());
  const hasState = bodyLower.includes('arizona') || /\baz\b/i.test(body);
  const hasServiceArea = /service area|serving|areas we serve|proudly serve/i.test(bodyLower);
  const hasNap = hasPhone && (hasCity || bodyLower.includes(p.city.toLowerCase()));
  let localPts = 0;
  if (hasPhone) localPts += 4; else issues.push({ level: 'error', msg: 'No phone number on page (local trust signal)' });
  if (hasCity || type !== 'city_page') localPts += 3; else issues.push({ level: 'warn', msg: 'Target city not mentioned in copy' });
  if (hasState) localPts += 2; else issues.push({ level: 'warn', msg: 'State (Arizona/AZ) not referenced' });
  if (hasServiceArea) localPts += 1;
  localPts = Math.min(10, localPts);
  dims.push({ label: 'Local signals', score: localPts, max: 10 });

  // ── E-E-A-T (10) ──
  const experience = /\b\d+\+?\s*(years|pools)\b/i.test(body) || bodyLower.includes('we built') || bodyLower.includes('our team');
  const expertise = new RegExp(`${p.projectsCompleted.replace('+', '\\+?')}|licensed|certified|design`, 'i').test(body);
  const authority = /award|featured|review|rated|testimonial|reputation/i.test(bodyLower) || (getBusinessProfile().socials.length > 0);
  const trust = hasPhone && /family owned|licensed|insured|warranty|guarantee|free consultation/i.test(bodyLower);
  const eeatBools = [experience, expertise, authority, trust];
  const eeatScore = Math.round((eeatBools.filter(Boolean).length / 4) * 100);
  const eeatPts = Math.round((eeatScore / 100) * 10);
  dims.push({ label: 'E-E-A-T', score: eeatPts, max: 10 });
  if (!experience) issues.push({ level: 'warn', msg: 'E-E-A-T: add first-hand experience (years, projects built)' });
  if (!trust) issues.push({ level: 'warn', msg: 'E-E-A-T: add trust signals (licensed, family owned, warranty)' });

  // ── GEO/AEO answer blocks (6) ──
  // Self-contained 40–120 word passages under question headings are citable by AI search.
  const answerBlocks = [...html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .filter((m) => /\?|how|what|why|cost|much|best/i.test(textContent(m[1]))).length;
  let geoPts = 0;
  if (answerBlocks >= 2) geoPts = 6;
  else if (answerBlocks === 1) geoPts = 3;
  else issues.push({ level: 'warn', msg: 'No question-style headings for AI search (GEO/AEO)' });
  dims.push({ label: 'AI search (GEO)', score: geoPts, max: 6 });

  const score = Math.min(100, dims.reduce((n, d) => n + d.score, 0));

  return {
    score,
    grade: grade(score),
    passed: score >= PASS_THRESHOLD,
    dimensions: dims,
    issues: issues.sort((a, b) => (a.level === 'error' ? -1 : 1) - (b.level === 'error' ? -1 : 1)),
    eeat: { score: eeatScore, experience, expertise, authority, trust },
    meta: { title, description: desc, titleLen: meta.titleLen, descLen: meta.descLen },
    schema: { valid: schema.valid, types: schema.types, errors: schema.errors, warnings: schema.warnings },
    signals: {
      wordCount,
      h1Count: h1s.length,
      h2Count,
      internalLinks,
      images,
      imagesWithAlt,
      hasLocalNap: hasNap,
      hasPhone,
      answerBlocks,
    },
    generatedAt: new Date().toISOString(),
  };
}

export { PASS_THRESHOLD };
