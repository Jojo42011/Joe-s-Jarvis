import { getSystemState, setSystemState } from '../db/queries';
import {
  insertFact,
  upsertRule,
  findOrCreateNode,
  insertEdge,
} from '../db/memory';
import {
  SERVICE_AREA_IN,
  CLIENT_NAME,
  COMPANY_NAME,
} from '../config/constants';

/**
 * Founder seed — the initial founder layer poured into memory from Joe's
 * business profile (Totally Outdoors LLC, Millersburg, Ohio). Idempotent:
 * runs once, guarded by a system_state flag. Seeded facts ship without
 * embeddings; the startup backfill vectorizes them on first boot.
 *
 * Bump SEED_VERSION to re-seed after editing the content below.
 */
const SEED_VERSION = 'founder_seeded_v2';

interface SeedFact {
  content: string;
  category: string;
  keywords: string;
  importance: number; // 1-10
}

const FACTS: SeedFact[] = [
  // Identity / origin
  { content: 'Joe owns Totally Outdoors LLC, a landscaping, hardscaping, and excavating company serving Holmes County, Ohio and surrounding areas, in business since 2004 — over two decades in the outdoor trades.', category: 'identity', keywords: 'origin,story,joe,history,founded,2004,holmes county', importance: 10 },
  { content: 'Totally Outdoors\' reputation IS the product. Holmes County is tight-knit — word of mouth travels faster than any ad, and every job either builds the company\'s name or risks it.', category: 'identity', keywords: 'reputation,word of mouth,legacy,community', importance: 9 },
  { content: 'Joe knows the work from the seat of the machine — grading, drainage, base prep, retaining walls, Ohio freeze-thaw — not from a catalog. Practical field knowledge, earned since 2004.', category: 'identity', keywords: 'expertise,excavating,grading,drainage,experience', importance: 8 },

  // Values
  { content: 'Joe\'s top values are integrity with every customer, respect for their property/money/dreams, and dignity and pride in the craft.', category: 'identity', keywords: 'values,integrity,respect,dignity,pride', importance: 10 },
  { content: 'Joe judges people by actions over words. Trust is earned by honesty and someone whose actions match their mouth; instant distrust comes from dodging calls, showing up late, or lying about work or schedule.', category: 'identity', keywords: 'trust,red flags,people,actions,honesty', importance: 8 },

  // Business scope
  { content: 'Totally Outdoors does the full spectrum of outdoor work: lawn care, landscaping, hardscaping, patios, excavating, water features and ponds, outdoor structures, golf scapes (putting greens), snow plowing and liquid salt/deicing, plus a materials disposal/dump service. Financing is available — call the office for details.', category: 'business', keywords: 'services,scope,lawn care,landscaping,hardscaping,excavating,snow plowing,ponds,patios', importance: 9 },
  { content: 'The dump service: $10 minimum, $25 per yard unloading fee, or free self-service; two unloading sites, 9am–3pm daily or by appointment. Accepts sticks, wood, greenery, dead plants, leaves, debris, rocks, and furniture. Rejects hazardous materials, plastics, rubber, tires, paint, and batteries.', category: 'business', keywords: 'dump,disposal,materials,unloading,fees', importance: 7 },
  { content: 'Location and hours: 2855 State Route 83, Millersburg, Ohio 44654 (south of Millersburg just off State Route 83); second yard at Lake Buckhorn; other locations by appointment. Phone 330-231-4080, email totallyoutdoors@gmail.com. Monday–Friday 8am–6pm, Saturday by appointment, closed Sunday.', category: 'business', keywords: 'address,location,hours,phone,email,millersburg,lake buckhorn', importance: 9 },

  // Sales process
  { content: 'Project pricing varies widely by scope — never quote a number without Joe. Capture the vision, the site details, and the timeline; Joe prices the work.', category: 'business', keywords: 'pricing,price,budget,cost,quote', importance: 9 },
  { content: 'Qualify a lead on: scope/vision (lawn care, landscaping, hardscape, patio, excavating, water feature/pond, structure, snow), one-time project vs recurring service, lead source (referral, internet, social), timeline, and budget. The three tells for a serious buyer: other estimates, timeline, and budget.', category: 'business', keywords: 'qualify,lead,scope,timeline,budget,source,recurring', importance: 8 },

  // Clients
  { content: 'Ideal client: easygoing, decisive, trusts the company, values communication and transparency, expects high-tier quality (not impossible perfection).', category: 'business', keywords: 'ideal client,customer', importance: 7 },
  { content: 'Red-flag client: wants champagne work on a beer budget, uses the company to shop quotes, is indecisive and questions every detail after it\'s explained, and nags for free time and materials.', category: 'business', keywords: 'red flag,nightmare client,warning', importance: 7 },

  // Operations
  { content: 'Weather runs the schedule in Ohio: rain moves dirt work, frost windows gate concrete and planting, and the business flips to snow operations in winter. Set expectations by milestones, not hard dates.', category: 'business', keywords: 'weather,schedule,seasons,snow,frost,timeline', importance: 8 },
  { content: 'Mid-project change orders: charge for the change and warn the client it can add time.', category: 'business', keywords: 'change order,mid-project,delay', importance: 7 },
  { content: 'Conflict rule: stay calm, question the crew member or sub patiently, and correct the mistake immediately even if it costs time or money. If they refuse to fix it, replace them and cut them off from further work.', category: 'business', keywords: 'conflict,mistake,subs,quality', importance: 7 },
  { content: 'Joe treats crew and subs like partners in the brand — high expectations with full backing. The fastest way to lose him: lack of communication, lying, no-shows, and disrespecting the quality of work.', category: 'business', keywords: 'subs,crew,partners,communication,craftsmanship', importance: 7 },

  // Service area
  { content: `Totally Outdoors serves Holmes County, Ohio and surrounding areas: ${SERVICE_AREA_IN.join(', ')}. It does NOT chase work in the far metros — Columbus, Cleveland, Akron, Canton, Mansfield, or Youngstown.`, category: 'business', keywords: 'service area,cities,holmes county,ohio,coverage', importance: 8 },
];

interface SeedRule { rule: string; confidence: number; }

const RULES: SeedRule[] = [
  { rule: 'Never make promises on pricing, timelines, or design approvals — escalate those to Joe.', confidence: 0.95 },
  { rule: 'Never ask the homeowner personal questions; keep every conversation strictly about the project.', confidence: 0.9 },
  { rule: 'Stay unshakably cordial — never match a hostile caller\'s energy; de-escalate with politeness.', confidence: 0.9 },
  { rule: 'Decline out-of-area leads politely and do not qualify or schedule them.', confidence: 0.9 },
  { rule: 'Route qualified leads into a scheduled on-site estimate with a team member.', confidence: 0.85 },
  { rule: 'For an upset existing client: validate, take a detailed message, and route straight to Joe — never guess.', confidence: 0.9 },
  { rule: 'Never use defeatist words ("I can\'t", "I\'m trying", "It\'s impossible") — always offer solutions.', confidence: 0.9 },
  { rule: 'Never quote project prices — pricing varies by scope and site; capture details and let Joe price the work.', confidence: 0.85 },
];

interface SeedNode { name: string; type: string; }
interface SeedEdge { from: string; rel: string; to: string; strength?: number; }

const NODES: SeedNode[] = [
  { name: CLIENT_NAME, type: 'person' },
  { name: COMPANY_NAME, type: 'company' },
  { name: 'Integrity', type: 'concept' },
  { name: 'Respect', type: 'concept' },
  { name: 'Dignity & Pride', type: 'concept' },
  { name: 'Legacy', type: 'concept' },
  { name: 'Landscaping', type: 'project' },
  { name: 'Hardscaping & Patios', type: 'project' },
  { name: 'Excavating', type: 'project' },
  { name: 'Water Features & Ponds', type: 'project' },
  { name: 'Lawn Care', type: 'project' },
  { name: 'Snow Plowing & Deicing', type: 'project' },
  { name: 'Outdoor Structures', type: 'project' },
];

function buildEdges(): SeedEdge[] {
  const edges: SeedEdge[] = [
    { from: CLIENT_NAME, rel: 'owns', to: COMPANY_NAME, strength: 1.5 },
    { from: CLIENT_NAME, rel: 'is building', to: 'Legacy', strength: 1.4 },
    { from: CLIENT_NAME, rel: 'values', to: 'Integrity', strength: 1.3 },
    { from: CLIENT_NAME, rel: 'values', to: 'Respect', strength: 1.3 },
    { from: CLIENT_NAME, rel: 'values', to: 'Dignity & Pride', strength: 1.3 },
    { from: COMPANY_NAME, rel: 'offers', to: 'Landscaping' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Hardscaping & Patios' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Excavating' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Water Features & Ponds' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Lawn Care' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Snow Plowing & Deicing' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Outdoor Structures' },
  ];
  // Anchor the service area (a few representative towns to keep the map legible).
  for (const city of ['Millersburg', 'Berlin', 'Walnut Creek', 'Sugarcreek', 'Wooster']) {
    edges.push({ from: COMPANY_NAME, rel: 'serves', to: city });
  }
  return edges;
}

export function seedFounderMemory(): void {
  if (getSystemState(SEED_VERSION)) return;

  try {
    for (const f of FACTS) {
      insertFact(f.content, f.category, f.keywords, 1.3, f.importance, null);
    }

    for (const r of RULES) {
      // upsertRule seeds new rules at 0.5 + delta; delta lifts them to target.
      upsertRule(r.rule, Math.max(0, r.confidence - 0.5));
    }

    // Ensure city nodes exist so "serves" edges have real endpoints.
    for (const city of ['Millersburg', 'Berlin', 'Walnut Creek', 'Sugarcreek', 'Wooster']) {
      findOrCreateNode(city, 'concept');
    }
    const nodeIds = new Map<string, number>();
    for (const n of NODES) {
      nodeIds.set(n.name, findOrCreateNode(n.name, n.type));
    }

    for (const e of buildEdges()) {
      const src = nodeIds.get(e.from) ?? findOrCreateNode(e.from, 'concept');
      const dst = nodeIds.get(e.to) ?? findOrCreateNode(e.to, 'concept');
      insertEdge(src, dst, e.rel, e.strength ?? 1.0);
    }

    setSystemState(SEED_VERSION, new Date().toISOString());
    console.log(`[Founder Seed] Seeded ${FACTS.length} facts, ${RULES.length} rules, ${NODES.length}+ nodes into memory`);
  } catch (err) {
    console.error('[Founder Seed] error:', err instanceof Error ? err.message : err);
  }
}
