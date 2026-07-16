// ─── Single source of truth for Aquatic Pool & Spa's local business identity ───
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
  poolsBuilt: string;
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
  'Phoenix', 'Scottsdale', 'Paradise Valley', 'Chandler', 'Goodyear', 'Buckeye',
  'Tempe', 'Mesa', 'Gilbert', 'Peoria', 'Glendale', 'Sun City', 'Surprise',
  'Ahwatukee', 'Avondale',
];

function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The website's Contact Us page — the ONE link the business points people at.
 *  Override with SEO_CONTACT_URL if the site's contact path is different. */
export function contactPageUrl(): string {
  const explicit = env('SEO_CONTACT_URL', '').replace(/\/+$/, '');
  if (explicit) return explicit;
  const site = env('SEO_WEBSITE_URL', 'https://aquaticpoolaz.com').replace(/\/+$/, '');
  return `${site}/contact`;
}

export function getBusinessProfile(): BusinessProfile {
  const url = env('SEO_WEBSITE_URL', 'https://aquaticpoolaz.com').replace(/\/+$/, '');
  const phone = env('SEO_BIZ_PHONE', '(623) 225-0537');
  const currentYear = new Date().getFullYear();
  const foundingYear = parseInt(env('SEO_BIZ_FOUNDING_YEAR', '2007'), 10);

  return {
    name: env('SEO_BIZ_NAME', 'Aquatic Pool and Spa'),
    legalName: env('SEO_BIZ_LEGAL_NAME', 'Aquatic Pool and Spa LLC'),
    phone,
    phoneDigits: phone.replace(/[^\d]/g, ''),
    email: env('SEO_BIZ_EMAIL', 'info@aquaticpoolaz.com'),
    url,
    logo: env('SEO_BIZ_LOGO', `${url}/assets/logo.png`),
    image: env('SEO_BIZ_IMAGE', `${url}/assets/hero.jpg`),
    priceRange: env('SEO_BIZ_PRICE_RANGE', '$$$$'),
    foundingYear,
    yearsExperience: Math.max(1, currentYear - foundingYear),
    poolsBuilt: env('SEO_BIZ_POOLS_BUILT', '400+'),
    minProject: env('SEO_BIZ_MIN_PROJECT', '$40,000'),
    street: env('SEO_BIZ_STREET', ''),
    city: env('SEO_BIZ_CITY', 'Phoenix'),
    state: env('SEO_BIZ_STATE', 'AZ'),
    stateFull: env('SEO_BIZ_STATE_FULL', 'Arizona'),
    zip: env('SEO_BIZ_ZIP', '85001'),
    lat: parseFloat(env('SEO_BIZ_LAT', '33.4484')),
    lng: parseFloat(env('SEO_BIZ_LNG', '-112.0740')),
    hours: [
      { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '08:00', closes: '17:00' },
      { days: ['Saturday'], opens: '09:00', closes: '14:00' },
    ],
    gbpCategories: [
      'Swimming pool contractor',
      'Pool cleaning service',
      'Construction company',
    ],
    services: [
      'Custom Pool Construction',
      'Luxury Pool Design',
      'Pool Remodeling',
      'Spa & Hot Tub Installation',
      'Water Features',
      'Pool Renovation',
    ],
    serviceAreas: SERVICE_AREA_CITIES.map((c) => ({ city: c, slug: toSlug(c) })),
    excludedAreas: ['Maricopa', 'San Tan Valley'],
    socials: (process.env.SEO_BIZ_SOCIALS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    tagline: env(
      'SEO_BIZ_TAGLINE',
      'Luxury resort-style custom pool builder serving the Phoenix Valley',
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
