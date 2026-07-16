// ─── Meta title & description optimization + scoring ───
// Title sweet spot 30–60 chars (pixel-safe ≤ ~60), description 120–160 chars.
// Local intent demands {Service} in {City}, {STATE} | {Brand} and a phone CTA.

import { getBusinessProfile } from './businessProfile';

export interface MetaResult {
  title: string;
  description: string;
}

function clean(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'near', 'best', 'top', 'your', 'our', 'pool', 'pools']);

/** Significant tokens of a keyword (drops stop/filler words, keeps the rest). */
export function keywordTokens(keyword?: string): string[] {
  return (keyword || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** Word-order-independent keyword presence: every significant token appears. */
export function textHasKeyword(text: string, keyword?: string): boolean {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return false;
  const hay = (text || '').toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function titleCaseWord(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build an optimized, length-safe meta title. */
export function buildMetaTitle(opts: { type: string; keyword?: string; city?: string; task?: string }): string {
  const p = getBusinessProfile();
  const brand = p.name.replace(/ and /i, ' & ');
  const kw = clean(opts.keyword || opts.task || 'Custom Pools');

  let core: string;
  if (opts.type === 'city_page' && opts.city) {
    // Strip the city out of the keyword so we don't get "...Scottsdale in Scottsdale".
    const kwNoCity = clean(kw.replace(new RegExp(opts.city, 'ig'), ''));
    const subject = kwNoCity && /pool|builder|spa|design|remodel|contractor/i.test(kwNoCity)
      ? titleCaseWord(kwNoCity)
      : 'Pool Builder';
    core = `${subject} in ${opts.city}, ${p.state}`;
  } else if (opts.type === 'blog') {
    core = titleCaseWord(kw);
  } else {
    core = titleCaseWord(kw);
  }

  let title = `${core} | ${brand}`;
  if (title.length > 60) {
    // Drop the brand if the core alone is already long.
    title = core.length <= 60 ? core : core.slice(0, 57).trim() + '…';
  }
  return title;
}

/** Build an optimized meta description with keyword + local proof + CTA + phone. */
export function buildMetaDescription(opts: { type: string; keyword?: string; city?: string; task?: string }): string {
  const p = getBusinessProfile();
  const where = opts.city ? `${opts.city}, ${p.stateFull}` : `the Phoenix Valley`;
  const proof = `${p.yearsExperience}+ years, ${p.projectsCompleted} projects completed`;

  let desc: string;
  if (opts.type === 'city_page') {
    desc = `Luxury custom pool builder in ${where}. ${proof}, family owned. Free design consultation — call ${p.phone}.`;
  } else if (opts.type === 'blog') {
    const topic = clean(opts.task || opts.keyword || 'pool building');
    desc = `${titleCaseWord(topic)} — expert guidance from ${p.name}. ${proof} across ${p.stateFull}. Call ${p.phone}.`;
  } else {
    desc = `${p.name} — ${p.tagline}. ${proof}. Call ${p.phone} for a free consultation.`;
  }

  desc = clean(desc);
  if (desc.length > 160) desc = desc.slice(0, 157).trim() + '…';
  return desc;
}

export function optimizeMeta(opts: { type: string; keyword?: string; city?: string; task?: string }): MetaResult {
  return {
    title: buildMetaTitle(opts),
    description: buildMetaDescription(opts),
  };
}

export interface MetaScore {
  score: number;       // 0–100
  issues: { level: 'error' | 'warn' | 'ok'; msg: string }[];
  titleLen: number;
  descLen: number;
}

/** Score an existing title/description against best-practice length + content rules. */
export function scoreMeta(title: string, description: string, keyword?: string): MetaScore {
  const issues: MetaScore['issues'] = [];
  const t = clean(title);
  const d = clean(description);
  const hasKw = !!keyword && keywordTokens(keyword).length > 0;
  let score = 0;

  // Title (50 pts)
  if (!t) {
    issues.push({ level: 'error', msg: 'Missing <title>' });
  } else {
    if (t.length >= 30 && t.length <= 60) { score += 25; }
    else if (t.length >= 20 && t.length <= 65) { score += 16; issues.push({ level: 'warn', msg: `Title length ${t.length} (aim 30–60)` }); }
    else { score += 6; issues.push({ level: 'error', msg: `Title length ${t.length} out of range (30–60)` }); }

    if (hasKw && textHasKeyword(t, keyword)) score += 15;
    else if (hasKw) issues.push({ level: 'warn', msg: 'Target keyword not in title' });

    if (/\|/.test(t)) score += 10; // brand separator present
    else issues.push({ level: 'warn', msg: 'No brand in title (add " | Brand")' });
  }

  // Description (50 pts)
  if (!d) {
    issues.push({ level: 'error', msg: 'Missing meta description' });
  } else {
    if (d.length >= 120 && d.length <= 160) { score += 25; }
    else if (d.length >= 90 && d.length <= 170) { score += 15; issues.push({ level: 'warn', msg: `Description length ${d.length} (aim 120–160)` }); }
    else { score += 6; issues.push({ level: 'error', msg: `Description length ${d.length} out of range (120–160)` }); }

    if (hasKw && textHasKeyword(d, keyword)) score += 12;
    else if (hasKw) issues.push({ level: 'warn', msg: 'Target keyword not in description' });

    if (/call|free|book|consultation|\(\d{3}\)|\d{3}[-.\s]\d{4}/i.test(d)) score += 13;
    else issues.push({ level: 'warn', msg: 'No clear CTA/phone in description' });
  }

  return { score: Math.min(100, score), issues, titleLen: t.length, descLen: d.length };
}
