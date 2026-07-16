// ─── Site-level SEO health score (0–100) for the Atlas command-center hero ───
// Aggregates per-page audit scores, schema coverage, orphan pages, and ranked
// keywords into one health number plus a component breakdown.

import { getDb } from '../../db/schema';

export interface SiteHealth {
  score: number;
  grade: string;
  components: { label: string; score: number; weight: number; detail: string }[];
  avgPageScore: number | null;
  schemaCoverage: number;     // % of published pages with valid schema
  orphanPages: number;        // published pages with < 2 internal links
  pagesScored: number;
  pagesNeedingWork: number;   // scored pages below pass threshold
}

interface ContentScoreRow {
  seo_score: number | null;
  schema_types: string | null;
  internal_links_out: number | null;
  committed: number;
  status: string;
}

function grade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

export function computeSiteHealth(): SiteHealth {
  const db = getDb();
  let rows: ContentScoreRow[] = [];
  try {
    rows = db.prepare(
      `SELECT seo_score, schema_types, internal_links_out, committed, status
       FROM seo_content WHERE status != 'denied'`,
    ).all() as ContentScoreRow[];
  } catch {
    rows = [];
  }

  const scored = rows.filter((r) => typeof r.seo_score === 'number');
  const published = rows.filter((r) => r.committed === 1);

  const avgPageScore = scored.length
    ? Math.round(scored.reduce((n, r) => n + (r.seo_score || 0), 0) / scored.length)
    : null;

  const withSchema = published.filter((r) => (r.schema_types || '').trim().length > 0).length;
  const schemaCoverage = published.length ? Math.round((withSchema / published.length) * 100) : 0;

  const orphanPages = published.filter((r) => (r.internal_links_out ?? 0) < 2).length;
  const orphanScore = published.length ? Math.round((1 - orphanPages / published.length) * 100) : 100;

  const pagesNeedingWork = scored.filter((r) => (r.seo_score || 0) < 75).length;

  // Ranked-keyword component
  let rankedScore = 0;
  try {
    const kws = db.prepare('SELECT our_ranking FROM seo_keywords').all() as { our_ranking: string | null }[];
    const ranked = kws.filter((k) => k.our_ranking && /\d/.test(k.our_ranking)).length;
    rankedScore = kws.length ? Math.round((ranked / kws.length) * 100) : 0;
  } catch { /* table may be empty */ }

  const components = [
    { label: 'Page quality', score: avgPageScore ?? 0, weight: 0.5, detail: avgPageScore != null ? `${scored.length} pages avg ${avgPageScore}` : 'No pages scored yet' },
    { label: 'Schema coverage', score: schemaCoverage, weight: 0.2, detail: `${withSchema}/${published.length} published pages` },
    { label: 'Link architecture', score: orphanScore, weight: 0.2, detail: orphanPages ? `${orphanPages} orphan page(s)` : 'No orphans' },
    { label: 'Keyword visibility', score: rankedScore, weight: 0.1, detail: 'Ranked vs tracked' },
  ];

  const score = Math.round(components.reduce((n, c) => n + c.score * c.weight, 0));

  return {
    score,
    grade: grade(score),
    components,
    avgPageScore,
    schemaCoverage,
    orphanPages,
    pagesScored: scored.length,
    pagesNeedingWork,
  };
}
