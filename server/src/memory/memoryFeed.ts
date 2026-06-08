import { MEMORY_CATEGORIES, MEMORY_NEVER_DECAY } from "../config/memoryCategories";

import {

  getAllEntityProfiles,

  getEligibleMemoriesForFeed,

  trackMemoryRetrieval,

  type JarvisMemory

} from "../db/queries";



export type MemoryFeed = {

  domain_headlines: string;

  top_memories: JarvisMemory[];

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



const DOMAIN_HEADLINE_CATEGORIES: Array<{ label: string; category: string }> = [

  { label: "FINANCE", category: MEMORY_CATEGORIES.FINANCIAL_OPERATIONS },

  { label: "INDUSTRY", category: MEMORY_CATEGORIES.INDUSTRY },

  { label: "BUSINESS", category: MEMORY_CATEGORIES.BUSINESS_CONTEXT },

  { label: "DRONES", category: MEMORY_CATEGORIES.DRONE_FAA },

  { label: "WORLD", category: MEMORY_CATEGORIES.WORLD_INTEL }

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



function scoreMemory(

  memory: JarvisMemory,

  message: string,

  detectedEntities: string[],

  detectedCategory: string | null,

  now: Date

): number {

  let score = (memory.confidence || 0.5) * (memory.importance || 0.5);

  const memoryText = `${memory.key} ${memory.value}`.toLowerCase();

  if (message.trim()) {
    const messageWords = message
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    let keywordBoost = 0;
    for (const word of messageWords) {
      if (memoryText.includes(word)) {
        keywordBoost += 0.3;
        if (keywordBoost >= 0.6) break;
      }
    }
    score += keywordBoost;
  }

  if (memory.source === "joe_note" || memory.source === "joe_explicit") {
    score += 0.4;
  }

  const ageHours = (now.getTime() - new Date(memory.createdAt).getTime()) / 3_600_000;
  if (ageHours < 48) score += 0.3;

  const entityMatch = detectedEntities.some((e) => memoryText.includes(e.toLowerCase()));
  if (entityMatch) score += 0.3;

  if (detectedCategory && memory.category === detectedCategory) {
    score += 0.2;
  }

  if ((memory.retrievalCount || 0) >= 3) score += 0.2;

  if (memory.isSynthesized) score += 0.1;

  if (memory.lastRetrievedAt) {
    const daysSinceRetrieved =
      (now.getTime() - new Date(memory.lastRetrievedAt).getTime()) / 86_400_000;
    if (daysSinceRetrieved < 7) score += 0.1;
  }

  if (!memory.lastRetrievedAt) {
    const daysSinceCreated = ageHours / 24;
    if (daysSinceCreated > 60) score -= 0.2;
  }

  if ((memory.confidence || 0.5) < 0.4) score -= 0.3;

  return Math.max(0, Math.min(2, score));
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



function buildDomainHeadlines(

  eligible: JarvisMemory[],

  message: string,

  detectedEntities: string[],

  detectedCategory: string | null,

  now: Date

): string {

  const lines: string[] = [];



  for (const { label, category } of DOMAIN_HEADLINE_CATEGORIES) {

    const synthesized = eligible.filter((m) => m.category === category && m.isSynthesized === 1);

    if (!synthesized.length) continue;



    const top = synthesized

      .map((m) => ({ m, score: scoreMemory(m, message, detectedEntities, detectedCategory, now) }))

      .sort((a, b) => b.score - a.score || b.m.confidence - a.m.confidence)[0]?.m;



    if (!top?.value?.trim()) continue;

    lines.push(`${label}: ${top.value.trim()}`);

  }



  if (!lines.length) return "";

  return `=== DOMAIN HEADLINES (always current) ===\n${lines.join("\n")}\n`;

}



export async function getMemoryFeedForMessage(

  message: string,

  _sessionId: string

): Promise<MemoryFeed> {

  const now = new Date();

  const signal = extractEntitySignal(message);

  const detectedCategory = signal.categories[0] ?? null;

  const detectedEntities = [...signal.entityNames, ...signal.keywords];



  const eligible = getEligibleMemoriesForFeed();



  const scored = eligible

    .map((m) => ({

      m,

      score: scoreMemory(m, message, detectedEntities, detectedCategory, now)

    }))

    .sort((a, b) => b.score - a.score || b.m.importance - a.m.importance);



  const selectedIds = new Set<number>();

  const selected: JarvisMemory[] = [];



  const addMemory = (m: JarvisMemory) => {

    if (selectedIds.has(m.id)) return;

    selectedIds.add(m.id);

    selected.push(m);

  };



  for (const m of eligible.filter((row) => row.source === "joe_explicit" || row.source === "joe_note")) {

    addMemory(m);

  }



  for (const m of eligible

    .filter(

      (row) =>

        MEMORY_NEVER_DECAY.includes(row.category as (typeof MEMORY_NEVER_DECAY)[number]) &&

        row.confidence > 0.8

    )

    .sort((a, b) => b.confidence - a.confidence)

    .slice(0, 5)) {

    addMemory(m);

  }



  for (const { m } of scored.slice(0, 20)) {

    addMemory(m);

  }



  const finalSelected = dedupeById(selected);

  trackMemoryRetrieval(finalSelected.map((m) => m.id));



  const domain_headlines = buildDomainHeadlines(

    eligible,

    message,

    detectedEntities,

    detectedCategory,

    now

  );



  return {

    domain_headlines,

    top_memories: finalSelected,

    total_memories_fed: finalSelected.length

  };

}



export function formatMemoryFeedForPrompt(feed: MemoryFeed): string {

  const memoryLines = feed.top_memories.map((m) => `${m.key}: ${m.value}`).join("\n");

  const memoryBlock = memoryLines

    ? `=== WHAT YOU KNOW ===\n${memoryLines}\n`

    : "=== WHAT YOU KNOW ===\nNo durable memories matched this turn yet.\n";



  const parts = [feed.domain_headlines, memoryBlock].filter(Boolean);



  return `${parts.join("\n")}Total memory context: ${feed.total_memories_fed} items\n`;

}


