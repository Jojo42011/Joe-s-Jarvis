// ─── JSON-LD structured data generation + validation ───
// JSON-LD is Google's stated preference (microdata/RDFa discouraged). We emit
// LocalBusiness (parent), Service (per page), BreadcrumbList, and optionally
// FAQPage when the page exposes a real Q&A block. Output is wrapped in idempotent
// markers so re-enriching a page replaces rather than duplicates the block.

import { BusinessProfile, getBusinessProfile } from './businessProfile';

const SCHEMA_START = '<!-- atlas:schema:start -->';
const SCHEMA_END = '<!-- atlas:schema:end -->';

export interface SchemaContext {
  type: string;            // city_page | blog | service | ...
  pageUrl: string;         // absolute URL of this page
  title: string;
  description: string;
  city?: string;
  keyword?: string;
  faqs?: { question: string; answer: string }[];
  datePublished?: string;
}

function businessNode(p: BusinessProfile): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@type': ['LocalBusiness', 'GeneralContractor'],
    '@id': `${p.url}/#business`,
    name: p.name,
    legalName: p.legalName,
    url: p.url,
    telephone: p.phone,
    email: p.email,
    image: p.image,
    logo: p.logo,
    priceRange: p.priceRange,
    description: p.tagline,
    foundingDate: String(p.foundingYear),
    areaServed: p.serviceAreas.map((a) => ({ '@type': 'City', name: `${a.city}, ${p.stateFull}` })),
    geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng },
    openingHoursSpecification: p.hours.map((h) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: h.days,
      opens: h.opens,
      closes: h.closes,
    })),
    knowsAbout: p.services,
  };

  const address: Record<string, unknown> = {
    '@type': 'PostalAddress',
    addressLocality: p.city,
    addressRegion: p.state,
    postalCode: p.zip,
    addressCountry: 'US',
  };
  if (p.street) address.streetAddress = p.street;
  node.address = address;

  if (p.socials.length) node.sameAs = p.socials;
  return node;
}

function serviceNode(p: BusinessProfile, ctx: SchemaContext): Record<string, unknown> {
  const areaName = ctx.city ? `${ctx.city}, ${p.stateFull}` : `${p.city}, ${p.stateFull}`;
  return {
    '@type': 'Service',
    '@id': `${ctx.pageUrl}#service`,
    serviceType: ctx.keyword || 'Landscaping',
    name: ctx.title,
    description: ctx.description,
    provider: { '@id': `${p.url}/#business` },
    areaServed: { '@type': 'City', name: areaName },
    url: ctx.pageUrl,
  };
}

function breadcrumbNode(p: BusinessProfile, ctx: SchemaContext): Record<string, unknown> {
  const items: Record<string, unknown>[] = [
    { '@type': 'ListItem', position: 1, name: 'Home', item: p.url },
  ];
  if (ctx.type === 'city_page') {
    items.push({ '@type': 'ListItem', position: 2, name: 'Service Areas', item: `${p.url}/service-areas` });
    items.push({ '@type': 'ListItem', position: 3, name: ctx.city || ctx.title, item: ctx.pageUrl });
  } else if (ctx.type === 'blog') {
    items.push({ '@type': 'ListItem', position: 2, name: 'Blog', item: `${p.url}/blog` });
    items.push({ '@type': 'ListItem', position: 3, name: ctx.title, item: ctx.pageUrl });
  } else {
    items.push({ '@type': 'ListItem', position: 2, name: ctx.title, item: ctx.pageUrl });
  }
  return { '@type': 'BreadcrumbList', itemListElement: items };
}

function faqNode(ctx: SchemaContext): Record<string, unknown> | null {
  if (!ctx.faqs || !ctx.faqs.length) return null;
  return {
    '@type': 'FAQPage',
    mainEntity: ctx.faqs.slice(0, 10).map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}

/** Build the full @graph of JSON-LD nodes for a page. */
export function buildSchemaGraph(ctx: SchemaContext): Record<string, unknown> {
  const p = getBusinessProfile();
  const graph: Record<string, unknown>[] = [businessNode(p)];

  if (ctx.type === 'city_page' || ctx.type === 'service') {
    graph.push(serviceNode(p, ctx));
  }
  graph.push(breadcrumbNode(p, ctx));

  if (ctx.type === 'blog') {
    graph.push({
      '@type': 'BlogPosting',
      '@id': `${ctx.pageUrl}#article`,
      headline: ctx.title,
      description: ctx.description,
      author: { '@id': `${p.url}/#business`, name: p.name },
      publisher: { '@id': `${p.url}/#business` },
      datePublished: ctx.datePublished || new Date().toISOString().split('T')[0],
      mainEntityOfPage: ctx.pageUrl,
    });
  }

  const faq = faqNode(ctx);
  if (faq) graph.push(faq);

  return { '@context': 'https://schema.org', '@graph': graph };
}

/** List the @type names present in a graph (for dashboard badges/coverage). */
export function schemaTypesOf(graph: Record<string, unknown>): string[] {
  const nodes = (graph['@graph'] as Record<string, unknown>[]) || [];
  const types = new Set<string>();
  for (const node of nodes) {
    const t = node['@type'];
    if (Array.isArray(t)) t.forEach((x) => types.add(String(x)));
    else if (t) types.add(String(t));
  }
  return Array.from(types);
}

/** Inject (or replace) the JSON-LD block before </head>. Idempotent. */
export function injectSchema(html: string, ctx: SchemaContext): { html: string; types: string[] } {
  const graph = buildSchemaGraph(ctx);
  const types = schemaTypesOf(graph);
  const block = `${SCHEMA_START}\n<script type="application/ld+json">\n${JSON.stringify(graph, null, 2)}\n</script>\n${SCHEMA_END}`;

  // Strip any prior Atlas-injected block first.
  let out = stripAtlasSchema(html);

  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${block}\n</head>`);
  } else if (/<body[^>]*>/i.test(out)) {
    out = out.replace(/<body[^>]*>/i, (m) => `${m}\n${block}`);
  } else {
    out = `${block}\n${out}`;
  }
  return { html: out, types };
}

export function stripAtlasSchema(html: string): string {
  const re = new RegExp(`${SCHEMA_START}[\\s\\S]*?${SCHEMA_END}\\s*`, 'gi');
  return html.replace(re, '');
}

export interface SchemaValidation {
  valid: boolean;
  types: string[];
  errors: string[];
  warnings: string[];
  blocks: number;
}

/** Lightweight JSON-LD validator: parses every ld+json block, checks required
 *  fields for the types we care about, and flags deprecated types. */
export function validateSchema(html: string): SchemaValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allTypes = new Set<string>();
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  if (!blocks.length) {
    return { valid: false, types: [], errors: ['No JSON-LD structured data found'], warnings: [], blocks: 0 };
  }

  const DEPRECATED = new Set(['HowTo']);

  for (const b of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(b[1].trim());
    } catch (e) {
      errors.push(`Invalid JSON-LD: ${e instanceof Error ? e.message : 'parse error'}`);
      continue;
    }
    const nodes: Record<string, unknown>[] = [];
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(root['@graph'])) nodes.push(...(root['@graph'] as Record<string, unknown>[]));
    else if (Array.isArray(parsed)) nodes.push(...(parsed as Record<string, unknown>[]));
    else nodes.push(root);

    for (const node of nodes) {
      const t = node['@type'];
      const typeList = Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
      typeList.forEach((x) => {
        allTypes.add(x);
        if (DEPRECATED.has(x)) warnings.push(`${x} no longer produces rich results (deprecated by Google)`);
      });

      if (typeList.some((x) => /LocalBusiness|GeneralContractor/.test(x))) {
        if (!node.name) errors.push('LocalBusiness missing required "name"');
        if (!node.telephone) warnings.push('LocalBusiness missing recommended "telephone"');
        if (!node.address) warnings.push('LocalBusiness missing recommended "address"');
        if (!node.areaServed) warnings.push('LocalBusiness missing recommended "areaServed"');
      }
      if (typeList.includes('Service')) {
        if (!node.name) errors.push('Service missing required "name"');
        if (!node.provider) warnings.push('Service missing recommended "provider"');
      }
      if (typeList.includes('FAQPage')) {
        const me = node.mainEntity;
        if (!Array.isArray(me) || !me.length) errors.push('FAQPage has no questions');
        warnings.push('FAQPage rich results are now limited by Google — keep for AEO value, not SERP stars');
      }
      if (typeList.includes('BreadcrumbList')) {
        if (!Array.isArray(node.itemListElement) || !node.itemListElement.length) {
          errors.push('BreadcrumbList missing itemListElement');
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    types: Array.from(allTypes),
    errors,
    warnings,
    blocks: blocks.length,
  };
}
