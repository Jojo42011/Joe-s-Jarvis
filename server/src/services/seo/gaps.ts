// ─── Content gap analysis: what does the site actually NEED next? ───
// Lauren plans from real coverage gaps, not blindly. Compares the target
// service-area cities, core services, and high-opportunity keywords against the
// pages that already exist (live sitemap + published content).

import { getDb } from '../../db/schema';
import { getBusinessProfile } from './businessProfile';
import { getExistingSitePages } from '../websiteContext';

export interface ContentGaps {
  missingCities: string[];
  coveredCities: string[];
  missingServices: string[];
  keywordGaps: { keyword: string; opportunity: number; volume: string }[];
  brief: string;
}

function tokenize(s: string): string {
  return (s || '').toLowerCase();
}

export function computeContentGaps(): ContentGaps {
  const p = getBusinessProfile();
  const db = getDb();

  // Corpus of everything we already have: live sitemap + published/queued pages.
  const existingPages = getExistingSitePages().map(tokenize);
  let contentRows: { title: string; file_path: string | null; target_keyword: string | null; type: string }[] = [];
  try {
    contentRows = db.prepare(
      "SELECT title, file_path, target_keyword, type FROM seo_content WHERE status != 'denied'",
    ).all() as typeof contentRows;
  } catch { contentRows = []; }

  const haystack = existingPages
    .concat(contentRows.map((r) => tokenize(`${r.title} ${r.file_path || ''} ${r.target_keyword || ''}`)))
    .join(' \n ');

  const has = (needle: string) => haystack.includes(needle.toLowerCase());

  // City coverage.
  const missingCities: string[] = [];
  const coveredCities: string[] = [];
  for (const area of p.serviceAreas) {
    const covered = has(area.slug) || has(area.city.toLowerCase());
    (covered ? coveredCities : missingCities).push(area.city);
  }

  // Service coverage (match on the distinctive word of each service).
  const missingServices: string[] = [];
  for (const svc of p.services) {
    const key = svc.toLowerCase().split(/\s+/).filter((w) => w.length > 4)[0] || svc.toLowerCase();
    if (!has(key)) missingServices.push(svc);
  }

  // Keyword gaps: high-opportunity tracked keywords with no matching page.
  let keywordGaps: ContentGaps['keywordGaps'] = [];
  try {
    const kws = db.prepare(
      'SELECT keyword, opportunity_score, monthly_volume FROM seo_keywords ORDER BY opportunity_score DESC LIMIT 40',
    ).all() as { keyword: string; opportunity_score: number | null; monthly_volume: string | null }[];
    keywordGaps = kws
      .filter((k) => k.keyword && !has(k.keyword))
      .slice(0, 10)
      .map((k) => ({
        keyword: k.keyword,
        opportunity: Math.round((k.opportunity_score || 0) * 100),
        volume: k.monthly_volume || 'unknown',
      }));
  } catch { keywordGaps = []; }

  const brief = [
    coveredCities.length
      ? `COVERED CITIES (do not duplicate): ${coveredCities.join(', ')}.`
      : 'No city pages exist yet.',
    missingCities.length
      ? `MISSING CITY PAGES (highest local-SEO priority): ${missingCities.slice(0, 8).join(', ')}.`
      : 'All target cities have pages.',
    missingServices.length
      ? `MISSING SERVICE PAGES: ${missingServices.join(', ')}.`
      : 'All core services have pages.',
    keywordGaps.length
      ? `HIGH-OPPORTUNITY KEYWORDS WITHOUT A PAGE: ${keywordGaps.map((k) => `${k.keyword} (${k.opportunity}%)`).join('; ')}.`
      : '',
  ].filter(Boolean).join('\n');

  return { missingCities, coveredCities, missingServices, keywordGaps, brief };
}
