// ─── Internal linking: hub-and-spoke architecture + orphan detection ───
// City pages must form a web, not a field of orphans. Every spoke links up to
// the Service Areas hub, sideways to 2–3 sibling cities, and out to contact.

import { getBusinessProfile } from './businessProfile';

const LINKS_START = '<!-- atlas:related:start -->';
const LINKS_END = '<!-- atlas:related:end -->';

function cityToUrl(slug: string): string {
  // City pages live under /locations/<slug>.html (see inferFilePath in seoAgent.ts).
  return `/locations/${slug}.html`;
}

/** Pick up to `n` sibling service-area cities other than the current one. */
function siblingCities(currentSlug: string, n: number): { city: string; slug: string }[] {
  const areas = getBusinessProfile().serviceAreas.filter((a) => a.slug !== currentSlug);
  // Deterministic spread so the same page always links the same siblings.
  const out: { city: string; slug: string }[] = [];
  const step = Math.max(1, Math.floor(areas.length / n));
  for (let i = 0; i < areas.length && out.length < n; i += step) {
    out.push({ city: areas[i].city, slug: areas[i].slug });
  }
  return out;
}

/** Build a "Related Service Areas" block (city pages) or a "Helpful Links" block (blog). */
export function buildRelatedBlock(opts: { type: string; citySlug?: string }): string {
  const p = getBusinessProfile();
  const inner: string[] = [];

  if (opts.type === 'city_page' && opts.citySlug) {
    inner.push(`<a href="/service-areas">All ${p.stateFull} Service Areas</a>`);
    for (const s of siblingCities(opts.citySlug, 3)) {
      inner.push(`<a href="${cityToUrl(s.slug)}">Landscaping in ${s.city}</a>`);
    }
    inner.push(`<a href="/contact">Free Estimate</a>`);
  } else {
    inner.push(`<a href="/">${p.name}</a>`);
    inner.push(`<a href="/service-areas">Service Areas</a>`);
    inner.push(`<a href="/contact">Get a Free Quote</a>`);
  }

  const heading = opts.type === 'city_page' ? 'Related Service Areas' : 'Explore More';
  const linkStyle = 'color:#0f3d3e;text-decoration:none;font-weight:600;font-size:1rem;border-bottom:2px solid rgba(204,85,0,0.5);padding-bottom:2px;';
  const links = inner
    .map((a) => a.replace(/^<a /, `<a style="${linkStyle}" `))
    .map((a) => `      <li style="margin:0;">${a}</li>`)
    .join('\n');

  // Self-contained band: solid light background + real spacing so it reads as its
  // own section and can never visually merge with a fixed header or hero.
  return `${LINKS_START}
<section class="lauren-related" aria-label="${heading}" style="display:block;clear:both;position:relative;z-index:1;background:#f5f1ea;color:#1a1a1a;padding:56px 24px;margin:0;border-top:1px solid rgba(0,0,0,0.08);">
  <div style="max-width:1100px;margin:0 auto;">
    <h2 style="font-size:1.6rem;font-weight:800;margin:0 0 20px;color:#12343b;">${heading}</h2>
    <ul style="list-style:none;display:flex;flex-wrap:wrap;gap:16px 32px;padding:0;margin:0;">
${links}
    </ul>
  </div>
</section>
${LINKS_END}`;
}

export function stripRelatedBlock(html: string): string {
  const re = new RegExp(`${LINKS_START}[\\s\\S]*?${LINKS_END}\\s*`, 'gi');
  return html.replace(re, '');
}

/** Inject the related block just before the footer (or </main> / </body>). Idempotent. */
export function injectRelatedBlock(html: string, block: string): string {
  let out = stripRelatedBlock(html);
  if (/<footer[\s>]/i.test(out)) {
    return out.replace(/<footer([\s>])/i, `${block}\n<footer$1`);
  }
  if (/<\/main>/i.test(out)) {
    return out.replace(/<\/main>/i, `${block}\n</main>`);
  }
  if (/<\/body>/i.test(out)) {
    return out.replace(/<\/body>/i, `${block}\n</body>`);
  }
  return out + '\n' + block;
}

/** Count internal (same-site) links in a page body. */
export function countInternalLinks(html: string, siteUrl?: string): number {
  const p = getBusinessProfile();
  const base = (siteUrl || p.url).replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
  let count = 0;
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) { count++; continue; }
    const lower = href.toLowerCase();
    if (/^https?:\/\//.test(lower)) {
      if (lower.replace(/^https?:\/\//, '').startsWith(base)) count++;
    } else {
      count++; // relative path without leading slash
    }
  }
  return count;
}
