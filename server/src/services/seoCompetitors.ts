import { getDb } from '../db/schema';

const TAG = '[SEO Agent]';

export const SEED_COMPETITORS: { domain: string; title: string }[] = [
  { domain: 'holmeslandscaping.com', title: 'Holmes Landscaping' },
  { domain: 'buckeyelandscapes.com', title: 'Buckeye Landscapes' },
  { domain: 'countrysidelawnandlandscape.com', title: 'Countryside Lawn & Landscape' },
  { domain: 'hillsidehardscapes.com', title: 'Hillside Hardscapes' },
  { domain: 'greenacreslawncareohio.com', title: 'Green Acres Lawn Care' },
  { domain: 'valleyviewexcavating.com', title: 'Valley View Excavating' },
];

export function normalizeDomain(input: string): string {
  return input
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
}

export function storeCompetitor(domain: string, title?: string): void {
  const d = normalizeDomain(domain);
  if (!d || d.length < 4) return;
  if (d.includes('google.') || d.includes('vertexaisearch') || d.includes('wikipedia.')) return;
  if (d.includes('totallyoutdoors')) return;
  const url = `https://${d}`;
  const db = getDb();
  db.prepare(`
    INSERT INTO seo_competitors (domain, url, title) VALUES (?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET title = COALESCE(excluded.title, seo_competitors.title)
  `).run(d, url, title ?? d);
}

export function seedCompetitorsIfEmpty(): number {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM seo_competitors').get() as { c: number }).c;
  if (count > 0) return count;

  for (const c of SEED_COMPETITORS) storeCompetitor(c.domain, c.title);
  console.log(TAG, `Seeded ${SEED_COMPETITORS.length} Holmes County landscaping competitors`);
  return SEED_COMPETITORS.length;
}

export function storeKeywordsFromDomains(
  domains: string[],
  queries: string[],
  runId: number,
): number {
  if (!domains.length) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO seo_keywords (keyword, competitor, competitor_ranking, monthly_volume, opportunity_score) VALUES (?, ?, ?, ?, ?)`,
  );
  let n = 0;
  domains.slice(0, 10).forEach((domain, i) => {
    const keyword = queries[i % queries.length] ?? 'landscaping millersburg ohio';
    stmt.run(keyword, domain, 'top 10', 'unknown', 0.7 - i * 0.03);
    n++;
  });
  db.prepare('UPDATE seo_runs SET keywords_found = ? WHERE id = ?').run(n, runId);
  return n;
}
