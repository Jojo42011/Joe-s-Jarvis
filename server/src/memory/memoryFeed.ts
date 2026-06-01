import { MEMORY_CATEGORIES, MEMORY_NEVER_DECAY } from "../config/memoryCategories";
import {
  getAllEntityProfiles,
  getEligibleMemoriesForFeed,
  getLatestSynthesizedPerCategory,
  getNeverDecayHighConfidenceMemories,
  getRecentFinancialMemories,
  trackMemoryRetrieval,
  type JarvisMemory
} from "../db/queries";

export type MemoryFeed = {
  operator_profile: JarvisMemory[];
  active_entities: JarvisMemory[];
  financial_context: JarvisMemory[];
  operational: JarvisMemory[];
  recent_insights: JarvisMemory[];
  total_memories_fed: number;
};

type EntitySignal = {
  categories: string[];
  entityNames: string[];
  keywords: string[];
};

const CATEGORY_KEYWORDS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(invoice|payment|owe|cost|cash|revenue|billing)\b/i, category: MEMORY_CATEGORIES.FINANCIAL_OPERATIONS },
  { pattern: /\b(crew|employee|foreman|labor|worker)\b/i, category: MEMORY_CATEGORIES.CREW_LABOR },
  { pattern: /\b(client|customer|property owner)\b/i, category: MEMORY_CATEGORIES.CLIENT_RELATIONS },
  { pattern: /\b(vendor|supplier|material|mulch)\b/i, category: MEMORY_CATEGORIES.VENDOR_SUPPLIER },
  { pattern: /\b(prefer|always|never|policy|standard)\b/i, category: MEMORY_CATEGORIES.OPERATOR_PREFERENCES },
  { pattern: /\b(job|project|site|estimate|contract)\b/i, category: MEMORY_CATEGORIES.BUSINESS_CONTEXT }
];

function extractEntitySignal(message: string): EntitySignal {
  const categories = new Set<string>();
  const entityNames = new Set<string>();
  const keywords = new Set<string>();

  for (const { pattern, category } of CATEGORY_KEYWORDS) {
    if (pattern.test(message)) categories.add(category);
  }

  for (const profile of getAllEntityProfiles()) {
    const name = profile.name.trim();
    if (name.length >= 3 && message.toLowerCase().includes(name.toLowerCase())) {
      entityNames.add(name);
      if (profile.entityType === "client") categories.add(MEMORY_CATEGORIES.CLIENT_RELATIONS);
      if (profile.entityType === "crew") categories.add(MEMORY_CATEGORIES.CREW_LABOR);
      if (profile.entityType === "vendor") categories.add(MEMORY_CATEGORIES.VENDOR_SUPPLIER);
    }
  }

  const properNouns = message.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?\b/g) || [];
  for (const noun of properNouns) {
    entityNames.add(noun);
  }

  for (const word of message.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 4) keywords.add(word);
  }

  return {
    categories: [...categories],
    entityNames: [...entityNames],
    keywords: [...keywords]
  };
}

function daysSince(iso: string | null): number {
  if (!iso) return 999;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / (24 * 60 * 60 * 1000)) : 999;
}

function withinDays(iso: string | null, days: number): boolean {
  return daysSince(iso) <= days;
}

function scoreMemory(memory: JarvisMemory, signal: EntitySignal): number {
  let score = memory.confidence * memory.importance;

  if (signal.categories.includes(memory.category)) score += 0.3;

  const hay = `${memory.key} ${memory.value}`.toLowerCase();
  for (const entity of signal.entityNames) {
    if (entity.length >= 3 && hay.includes(entity.toLowerCase())) {
      score += 0.2;
      break;
    }
  }

  if (memory.retrievalCount > 3) score += 0.1;
  if (withinDays(memory.lastRetrievedAt, 7)) score += 0.1;
  if (!memory.lastRetrievedAt && daysSince(memory.createdAt) > 60) score -= 0.2;

  return score;
}

function dedupeById(memories: JarvisMemory[]): JarvisMemory[] {
  const seen = new Set<number>();
  const out: JarvisMemory[] = [];
  for (const m of memories) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function bucketMemories(selected: JarvisMemory[], signal: EntitySignal): MemoryFeed {
  const operator_profile: JarvisMemory[] = [];
  const active_entities: JarvisMemory[] = [];
  const financial_context: JarvisMemory[] = [];
  const operational: JarvisMemory[] = [];
  const recent_insights: JarvisMemory[] = [];

  for (const m of selected) {
    if (m.isSynthesized === 1) {
      recent_insights.push(m);
      continue;
    }
    if (
      m.category === MEMORY_CATEGORIES.OPERATOR_PREFERENCES ||
      MEMORY_NEVER_DECAY.includes(m.category as (typeof MEMORY_NEVER_DECAY)[number])
    ) {
      if (m.category === MEMORY_CATEGORIES.OPERATOR_PREFERENCES) {
        operator_profile.push(m);
        continue;
      }
    }

    if (m.category === MEMORY_CATEGORIES.FINANCIAL_OPERATIONS) {
      financial_context.push(m);
      continue;
    }

    const hay = `${m.key} ${m.value}`.toLowerCase();
    const entityHit = signal.entityNames.some((e) => hay.includes(e.toLowerCase()));
    if (
      entityHit ||
      m.category === MEMORY_CATEGORIES.CLIENT_RELATIONS ||
      m.category === MEMORY_CATEGORIES.CREW_LABOR ||
      m.category === MEMORY_CATEGORIES.VENDOR_SUPPLIER
    ) {
      active_entities.push(m);
      continue;
    }

    if (
      m.category === MEMORY_CATEGORIES.BUSINESS_CONTEXT ||
      m.category === MEMORY_CATEGORIES.INDUSTRY ||
      m.category === MEMORY_CATEGORIES.DOCUMENT_FACTS
    ) {
      operational.push(m);
      continue;
    }

    operational.push(m);
  }

  return {
    operator_profile,
    active_entities,
    financial_context,
    operational,
    recent_insights,
    total_memories_fed: selected.length
  };
}

export async function getMemoryFeedForMessage(
  message: string,
  _sessionId: string
): Promise<MemoryFeed> {
  const signal = extractEntitySignal(message);
  const eligible = getEligibleMemoriesForFeed();

  const scored = eligible
    .map((m) => ({ m, score: scoreMemory(m, signal) }))
    .sort((a, b) => b.score - a.score || b.m.importance - a.m.importance);

  const selected: JarvisMemory[] = [];
  const selectedIds = new Set<number>();

  const addMemory = (m: JarvisMemory) => {
    if (selectedIds.has(m.id)) return;
    selectedIds.add(m.id);
    selected.push(m);
  };

  for (const { m } of scored.slice(0, 15)) {
    addMemory(m);
  }

  for (const m of getNeverDecayHighConfidenceMemories()) {
    addMemory(m);
  }

  for (const entity of signal.entityNames) {
    const needle = entity.toLowerCase();
    for (const m of eligible) {
      const hay = `${m.key} ${m.value}`.toLowerCase();
      if (hay.includes(needle)) addMemory(m);
    }
  }

  for (const m of getRecentFinancialMemories(2)) {
    addMemory(m);
  }

  for (const m of getLatestSynthesizedPerCategory()) {
    addMemory(m);
  }

  const finalSelected = dedupeById(selected).slice(0, 25);
  trackMemoryRetrieval(finalSelected.map((m) => m.id));

  return bucketMemories(finalSelected, signal);
}

export function formatMemoryFeedForPrompt(feed: MemoryFeed): string {
  const formatBlock = (title: string, rows: JarvisMemory[]) => {
    if (!rows.length) return "";
    const lines = rows.map((m) => `${m.key}: ${m.value}`).join("\n");
    return `=== ${title} ===\n${lines}\n`;
  };

  const parts = [
    formatBlock("WHAT YOU KNOW ABOUT JOE", feed.operator_profile),
    formatBlock("ACTIVE CONTEXT (clients/crew/vendors relevant right now)", feed.active_entities),
    formatBlock("FINANCIAL PICTURE", feed.financial_context),
    formatBlock("BUSINESS OPERATIONS", feed.operational),
    formatBlock("RECENT INSIGHTS (synthesized)", feed.recent_insights)
  ].filter(Boolean);

  if (!parts.length) {
    return "=== MEMORY CONTEXT ===\nNo durable memories matched this turn yet.\n";
  }

  return `${parts.join("\n")}Total memory context: ${feed.total_memories_fed} items
Use this knowledge naturally. Don't announce you're using memory.
Just know it — like a human who's been working with Joe for months.\n`;
}
