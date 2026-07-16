// ─── Single source of truth for Totally Outdoors LLC's local business identity ───
// Used for NAP consistency, LocalBusiness/Service schema, areaServed signals,
// and the local-SEO scoring checks. Everything is env-overridable so the same
// engine can be repointed at another client without code changes.

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}

export interface ServiceArea {
  city: string;
  slug: string;
}

export interface BusinessProfile {
  name: string;
  legalName: string;
  phone: string;
  phoneDigits: string;
  email: string;
  url: string;
  logo: string;
  image: string;
  priceRange: string;
  foundingYear: number;
  yearsExperience: number;
  projectsCompleted: string;
  minProject: string;
  street: string;
  city: string;
  state: string;
  stateFull: string;
  zip: string;
  lat: number;
  lng: number;
  hours: { days: string[]; opens: string; closes: string }[];
  gbpCategories: string[];
  services: string[];
  serviceAreas: ServiceArea[];
  excludedAreas: string[];
  socials: string[];
  tagline: string;
}

const SERVICE_AREA_CITIES = [
  'Millersburg', 'Holmesville', 'Berlin', 'Walnut Creek', 'Sugarcreek',
  'Charm', 'Winesburg', 'Mount Hope', 'Killbuck', 'Nashville', 'Glenmont',
  'Big Prairie', 'Lakeville', 'Loudonville', 'Wooster', 'Apple Creek',
  'Fredericksburg', 'Baltic', 'Danville', 'Lake Buckhorn',
];

function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The website's Contact Us page — the ONE link the business points people at.
 *  Override with SEO_CONTACT_URL if the site's contact path is different. */
export function contactPageUrl(): string {
  const explicit = env('SEO_CONTACT_URL', '').replace(/\/+$/, '');
  if (explicit) return explicit;
  const site = env('SEO_WEBSITE_URL', 'https://www.totallyoutdoorsllc.com').replace(/\/+$/, '');
  return `${site}/contact`;
}

export function getBusinessProfile(): BusinessProfile {
  const url = env('SEO_WEBSITE_URL', 'https://www.totallyoutdoorsllc.com').replace(/\/+$/, '');
  const phone = env('SEO_BIZ_PHONE', '(330) 231-4080');
  const currentYear = new Date().getFullYear();
  const foundingYear = parseInt(env('SEO_BIZ_FOUNDING_YEAR', '2004'), 10);

  return {
    name: env('SEO_BIZ_NAME', 'Totally Outdoors'),
    legalName: env('SEO_BIZ_LEGAL_NAME', 'Totally Outdoors LLC'),
    phone,
    phoneDigits: phone.replace(/[^\d]/g, ''),
    email: env('SEO_BIZ_EMAIL', 'totallyoutdoors@gmail.com'),
    url,
    logo: env('SEO_BIZ_LOGO', `${url}/assets/logo.png`),
    image: env('SEO_BIZ_IMAGE', `${url}/assets/hero.jpg`),
    priceRange: env('SEO_BIZ_PRICE_RANGE', '$$'),
    foundingYear,
    yearsExperience: Math.max(1, currentYear - foundingYear),
    projectsCompleted: env('SEO_BIZ_PROJECTS_COMPLETED', 'hundreds of'),
    minProject: env('SEO_BIZ_MIN_PROJECT', ''),
    street: env('SEO_BIZ_STREET', '2855 State Route 83'),
    city: env('SEO_BIZ_CITY', 'Millersburg'),
    state: env('SEO_BIZ_STATE', 'OH'),
    stateFull: env('SEO_BIZ_STATE_FULL', 'Ohio'),
    zip: env('SEO_BIZ_ZIP', '44654'),
    lat: parseFloat(env('SEO_BIZ_LAT', '40.5545')),
    lng: parseFloat(env('SEO_BIZ_LNG', '-81.9179')),
    hours: [
      { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '08:00', closes: '18:00' },
    ],
    gbpCategories: [
      'Landscaper',
      'Lawn care service',
      'Landscape designer',
      'Excavating contractor',
      'Snow removal service',
    ],
    services: [
      'Landscaping',
      'Hardscaping & Patios',
      'Lawn Care',
      'Excavating',
      'Water Features & Ponds',
      'Outdoor Structures',
      'Golf Scapes & Putting Greens',
      'Snow Plowing & Deicing',
    ],
    serviceAreas: SERVICE_AREA_CITIES.map((c) => ({ city: c, slug: toSlug(c) })),
    excludedAreas: ['Columbus', 'Cleveland', 'Akron', 'Canton'],
    socials: (process.env.SEO_BIZ_SOCIALS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    tagline: env(
      'SEO_BIZ_TAGLINE',
      'Landscaping, hardscaping, and excavating serving Holmes County, Ohio since 2004',
    ),
  };
}

/** Canonical single-line NAP string used for citation-consistency checks. */
export function napLine(p: BusinessProfile = getBusinessProfile()): string {
  const addr = [p.street, p.city, `${p.state} ${p.zip}`].filter(Boolean).join(', ');
  return `${p.name} · ${addr} · ${p.phone}`;
}

/** Find the service area whose city name appears in the supplied text. */
export function matchServiceArea(text: string): ServiceArea | null {
  const hay = (text || '').toLowerCase();
  const sorted = [...getBusinessProfile().serviceAreas].sort((a, b) => b.city.length - a.city.length);
  for (const area of sorted) {
    if (hay.includes(area.city.toLowerCase())) return area;
  }
  return null;
}
