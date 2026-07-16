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
 * Founder seed — the initial founder layer poured into memory from Arthur's
 * intake. Idempotent: runs once, guarded by a system_state flag. Seeded facts
 * ship without embeddings; the startup backfill vectorizes them on first boot.
 *
 * Bump SEED_VERSION to re-seed after editing the content below.
 */
const SEED_VERSION = 'founder_seeded_v1';

interface SeedFact {
  content: string;
  category: string;
  keywords: string;
  importance: number; // 1-10
}

const FACTS: SeedFact[] = [
  // Identity / origin
  { content: 'Arthur Garcia built Aquatic Pool & Spa from the ground up — from cutting grass and delivering papers as a kid, to warehouse work, the gas company, then learning the pool trade from his uncle doing layouts, then years of repairs/service before earning his builder\'s license.', category: 'identity', keywords: 'origin,story,arthur,history,uncle,license', importance: 8 },
  { content: 'Arthur\'s driving motivation is legacy: to build a legitimate, top three-to-five Arizona pool company on reputation and leave his kids a name and business they can one day run.', category: 'identity', keywords: 'legacy,motivation,vision,kids,family,goal', importance: 10 },
  { content: 'Because Arthur spent years in repairs, service, and layouts before building, he understands how pools work mechanically — hydraulics and construction — not just how they look on paper.', category: 'identity', keywords: 'expertise,mechanical,hydraulics,experience', importance: 8 },

  // Values
  { content: 'Arthur\'s top values are integrity with every customer, respect for their property/money/dreams, and dignity and pride in the craft.', category: 'identity', keywords: 'values,integrity,respect,dignity,pride', importance: 10 },
  { content: 'Arthur judges people by actions over words. Trust is earned by honesty and someone whose actions match their mouth; instant distrust comes from smelling of alcohol, dodging calls, showing up late, or lying about work or schedule.', category: 'identity', keywords: 'trust,red flags,people,actions,honesty', importance: 8 },

  // Business scope + pricing
  { content: 'Aquatic Pool & Spa does the full spectrum: simple to luxury pools, spas, remodels, hardscape, landscape, softscape, water features — residential, commercial, and public.', category: 'business', keywords: 'services,scope,pools,spa,hardscape,landscape,water features', importance: 9 },
  { content: 'Pricing: a basic pool starts around $40,000–$45,000; new builds run $35,000 to $1,000,000; remodels run $5,000 to $100,000. Quote a generic starting price first, then layer add-ons, upgrades, and water features.', category: 'business', keywords: 'pricing,price,budget,cost,quote', importance: 9 },
  { content: 'For luxury builds, Arthur sells a paid 3D design and video rendering. Charging up front is a trust litmus test and the primary closing tool — clients who won\'t invest in the design are usually shopping the layout to cheaper builders.', category: 'business', keywords: 'design,3d,rendering,closing,sales', importance: 9 },

  // Sales process
  { content: 'Arthur\'s sales process: get in the door, walk the backyard and capture the vision, hand creative direction to the designer, present a photorealistic 3D rendering/video that exceeds their imagination, then close to contract. Deals stall when the client doesn\'t fully believe — they must buy Arthur\'s integrity, not just the drawing.', category: 'business', keywords: 'sales,process,close,vision,designer,3d', importance: 8 },
  { content: 'Qualify a lead on: scope/vision (pool, spa, hardscape, landscape, water features), lead source (referral, internet, social), timeline, and budget. The three tells for a serious buyer: other estimates, timeline, and budget.', category: 'business', keywords: 'qualify,lead,scope,timeline,budget,source', importance: 8 },

  // Clients
  { content: 'Ideal client: easygoing, decisive, trusts the company, values communication and transparency, expects high-tier quality (not impossible perfection).', category: 'business', keywords: 'ideal client,customer', importance: 7 },
  { content: 'Red-flag client: wants a $60k pool for $25k, uses the company to shop quotes, is indecisive and questions every detail after it\'s explained, and nags for free time and materials.', category: 'business', keywords: 'red flag,nightmare client,warning', importance: 7 },

  // Operations
  { content: 'Set timelines by milestones: contract, initial payment, engineering and city permits, and only once the permit is in hand, the construction schedule (excavation, rebar, plumbing, shotcrete). Never promise dates a city plan-checker can derail.', category: 'business', keywords: 'timeline,permits,schedule,milestones', importance: 7 },
  { content: 'Mid-build change orders: charge for the change, tell the sub on that phase to hold, capture remobilization cost, and warn the client it can add one to two weeks.', category: 'business', keywords: 'change order,mid-build,delay', importance: 7 },
  { content: 'Conflict rule: stay calm, question the sub patiently, and correct the mistake immediately even if it costs time or money. If a sub refuses to fix it, replace them and cut them off from further work.', category: 'business', keywords: 'conflict,mistake,subs,quality', importance: 7 },

  // Subs
  { content: 'Arthur treats subs and crew like partners in the brand — high expectations with full backing. The fastest way to lose him: lack of communication, lying, no-shows, and disrespecting the quality of work ("writing checks they can\'t cash").', category: 'business', keywords: 'subs,crew,partners,communication,craftsmanship', importance: 7 },

  // Service area
  { content: `Aquatic serves the Phoenix Valley in all directions: ${SERVICE_AREA_IN.join(', ')}. It does NOT currently work in Maricopa, San Tan Valley, Apache Junction, Tucson, Flagstaff, Prescott, or New River.`, category: 'business', keywords: 'service area,cities,phoenix,valley,coverage', importance: 8 },
];

interface SeedRule { rule: string; confidence: number; }

const RULES: SeedRule[] = [
  { rule: 'Never make promises on pricing, timelines, or design approvals — escalate those to Arthur.', confidence: 0.95 },
  { rule: 'Never ask the homeowner personal questions; keep every conversation strictly about the project.', confidence: 0.9 },
  { rule: 'Stay unshakably cordial — never match a hostile caller\'s energy; de-escalate with politeness.', confidence: 0.9 },
  { rule: 'Decline out-of-area leads politely and do not qualify or schedule them.', confidence: 0.9 },
  { rule: 'Route qualified leads into a scheduled on-site inspection with a team member.', confidence: 0.85 },
  { rule: 'For an upset existing client: validate, take a detailed message, and route straight to Arthur — never guess.', confidence: 0.9 },
  { rule: 'Never use defeatist words ("I can\'t", "I\'m trying", "It\'s impossible") — always offer solutions.', confidence: 0.9 },
  { rule: 'Anchor a basic pool at $40,000–$45,000, then explain that upgrades and water features drive the rest.', confidence: 0.8 },
];

interface SeedNode { name: string; type: string; }
interface SeedEdge { from: string; rel: string; to: string; strength?: number; }

const NODES: SeedNode[] = [
  { name: CLIENT_NAME, type: 'person' },
  { name: COMPANY_NAME, type: 'company' },
  { name: '3D Designer', type: 'person' },
  { name: 'Integrity', type: 'concept' },
  { name: 'Respect', type: 'concept' },
  { name: 'Dignity & Pride', type: 'concept' },
  { name: 'Legacy', type: 'concept' },
  { name: 'Luxury Pool Build', type: 'project' },
  { name: 'Pool Remodel', type: 'project' },
  { name: 'Spa Build', type: 'project' },
  { name: 'Hardscape', type: 'project' },
  { name: 'Water Features', type: 'project' },
  { name: '3D Rendering', type: 'tool' },
];

function buildEdges(): SeedEdge[] {
  const edges: SeedEdge[] = [
    { from: CLIENT_NAME, rel: 'owns', to: COMPANY_NAME, strength: 1.5 },
    { from: CLIENT_NAME, rel: 'is building', to: 'Legacy', strength: 1.4 },
    { from: CLIENT_NAME, rel: 'values', to: 'Integrity', strength: 1.3 },
    { from: CLIENT_NAME, rel: 'values', to: 'Respect', strength: 1.3 },
    { from: CLIENT_NAME, rel: 'values', to: 'Dignity & Pride', strength: 1.3 },
    { from: CLIENT_NAME, rel: 'works with', to: '3D Designer', strength: 1.2 },
    { from: COMPANY_NAME, rel: 'closes with', to: '3D Rendering', strength: 1.1 },
    { from: COMPANY_NAME, rel: 'offers', to: 'Luxury Pool Build' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Pool Remodel' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Spa Build' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Hardscape' },
    { from: COMPANY_NAME, rel: 'offers', to: 'Water Features' },
  ];
  // Anchor the service area (a few representative cities to keep the map legible).
  for (const city of ['Scottsdale', 'Paradise Valley', 'Chandler', 'Gilbert', 'Peoria']) {
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
    for (const city of ['Scottsdale', 'Paradise Valley', 'Chandler', 'Gilbert', 'Peoria']) {
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
