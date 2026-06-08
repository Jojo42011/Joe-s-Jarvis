import Anthropic from "@anthropic-ai/sdk";
import { MEMORY_CATEGORIES } from "../config/memoryCategories";
import {
  decayMemoryConfidence,
  enqueueMemoryAuditAction,
  getAllActiveMemoriesForAudit,
  getMemoriesByCategory,
  getMemoryById,
  insertMemorySynthesisLog,
  markMemorySoftDeleted,
  promoteWorldIntelMemory,
  saveMemory,
  setMemoryConfidenceAbsolute,
  setSystemState,
  getSystemState,
  type JarvisMemory
} from "../db/queries";
import { invalidateDynamicPromptCache } from "../config/systemPrompt";
import { findWorkingModel } from "../services/claude";
import { claudeCircuit } from "../services/circuitBreaker";
import { SYNTHESIS_CATEGORIES, MEMORY_NEVER_DECAY } from "./judgmentRules";
import { getOhioDateTimeString } from "../routes/chat/utils";

const synthAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

type SynthesizedInsight = {
  key: string;
  value: string;
  confidence: number;
  importance: number;
  source_ids: number[];
};

type Contradiction = {
  memory_ids: number[];
  issue: string;
  recommended_action: "keep_newest" | "keep_highest_confidence" | "flag_for_joe";
};

type SynthesisResult = {
  synthesized_insights: SynthesizedInsight[];
  contradictions: Contradiction[];
  prune_ids: number[];
  knowledge_gaps: string[];
};

const SYNTHESIS_SYSTEM = `You are JARVIS's synthesis engine. Your job is to read raw memory facts and produce deeper, connected insights.

Think like an experienced business advisor who has been watching Joe's landscaping business for months.
Connect the dots. Find patterns. Surface what matters.`;

async function synthesizeCategory(
  category: string,
  memories: JarvisMemory[],
  ohioTime: string
): Promise<SynthesisResult | null> {
  if (!synthAnthropic || memories.length < 3) return null;

  const model = await findWorkingModel();
  if (!model) return null;

  const list = memories
    .map(
      (m, i) =>
        `${i + 1}. ID ${m.id} | ${m.key} | ${m.value} | conf ${m.confidence.toFixed(2)} | retrievals ${m.retrievalCount} | created ${m.createdAt}`
    )
    .join("\n");

  const userPrompt = `Here are all memories in category ${category} for Joe Stewart's landscaping business. Today is ${ohioTime}.

${list}

Your tasks:

1. SYNTHESIZE: Identify 2-5 key insights that emerge from connecting these memories together.
2. IDENTIFY CONTRADICTIONS: Flag any memories that contradict each other.
3. FLAG FOR PRUNING: Which memories are now outdated, redundant, or low value? List their IDs.
4. IDENTIFY GAPS: What important things about ${category} do you NOT know yet?

Return JSON:
{
  "synthesized_insights": [{
    "key": string,
    "value": string,
    "confidence": 0.85,
    "importance": number,
    "source_ids": number[]
  }],
  "contradictions": [{
    "memory_ids": number[],
    "issue": string,
    "recommended_action": "keep_newest" | "keep_highest_confidence" | "flag_for_joe"
  }],
  "prune_ids": number[],
  "knowledge_gaps": string[]
}`;

  const response = await claudeCircuit.execute("memory_synthesis", () =>
    synthAnthropic.messages.create({
      model,
      max_tokens: 1800,
      temperature: 0.2,
      system: SYNTHESIS_SYSTEM,
      messages: [{ role: "user", content: userPrompt }]
    })
  );

  const text = response.content.find((b) => b.type === "text")?.text?.trim() || "{}";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  try {
    return JSON.parse(start >= 0 && end >= start ? text.slice(start, end + 1) : text) as SynthesisResult;
  } catch {
    return null;
  }
}

function processSynthesisResult(
  category: string,
  result: SynthesisResult
): { created: number; updated: number; pruned: number } {
  let created = 0;
  let updated = 0;
  let pruned = 0;

  for (const insight of result.synthesized_insights || []) {
    const key = String(insight.key || "").trim().slice(0, 200);
    const value = String(insight.value || "").trim().slice(0, 8000);
    if (!key || !value) continue;
    saveMemory({
      category,
      key,
      value,
      confidence: Math.min(1, Number(insight.confidence) || 0.85),
      importance: Math.min(1, Math.max(0.1, Number(insight.importance) || 0.7)),
      source: "synthesis",
      isSynthesized: 1,
      synthesizedFrom: JSON.stringify(insight.source_ids || [])
    });
    created += 1;
  }

  for (const contradiction of result.contradictions || []) {
    const ids = (contradiction.memory_ids || []).filter((id) => Number.isFinite(id));
    if (ids.length < 2) continue;
    const rows = ids.map((id) => getMemoryById(id)).filter(Boolean) as JarvisMemory[];

    if (contradiction.recommended_action === "flag_for_joe") {
      for (const row of rows) {
        enqueueMemoryAuditAction({
          action: "flag",
          category: row.category,
          memoryKey: row.key,
          reason: contradiction.issue || "Synthesis contradiction"
        });
      }
      continue;
    }

    if (contradiction.recommended_action === "keep_newest") {
      const sorted = [...rows].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
      );
      for (const row of sorted.slice(1)) {
        decayMemoryConfidence(row.id, -0.3);
        updated += 1;
      }
      continue;
    }

    if (contradiction.recommended_action === "keep_highest_confidence") {
      const sorted = [...rows].sort((a, b) => b.confidence - a.confidence);
      for (const row of sorted.slice(1)) {
        decayMemoryConfidence(row.id, -0.3);
        updated += 1;
      }
    }
  }

  for (const id of result.prune_ids || []) {
    const row = getMemoryById(Number(id));
    if (!row || row.confidence <= 0.2) continue;
    decayMemoryConfidence(row.id, -0.2);
    pruned += 1;
  }

  return { created, updated, pruned };
}

function cleanupWorldIntelMemories(): { pruned: number; promoted: number } {
  const rows = getMemoriesByCategory(MEMORY_CATEGORIES.WORLD_INTEL, 0.15);
  let pruned = 0;
  let promoted = 0;

  const groups = new Map<string, JarvisMemory[]>();
  for (const row of rows) {
    const prefix = row.key.split("_").slice(0, 3).join("_") || row.key;
    const bucket = groups.get(prefix) || [];
    bucket.push(row);
    groups.set(prefix, bucket);
  }

  for (const [, group] of groups) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => b.confidence - a.confidence);
    for (const row of sorted.slice(1)) {
      decayMemoryConfidence(row.id, -0.15);
      pruned += 1;
    }
  }

  for (const row of rows) {
    if (row.retrievalCount >= 3 && row.source !== "promoted_from_world_intel") {
      saveMemory({
        category: MEMORY_CATEGORIES.BUSINESS_CONTEXT,
        key: `promoted_${row.key}`.slice(0, 200),
        value: row.value,
        confidence: Math.min(1, row.confidence + 0.05),
        importance: Math.max(0.6, row.importance),
        source: "promoted_from_world_intel"
      });
      saveMemory({
        category: MEMORY_CATEGORIES.WORLD_INTEL,
        key: row.key,
        value: row.value,
        confidence: row.confidence,
        importance: row.importance,
        source: "promoted"
      });
      promoted += 1;
    }

    const ageDays = Math.floor(
      (Date.now() - Date.parse(row.createdAt)) / (24 * 60 * 60 * 1000)
    );
    if (!row.lastRetrievedAt && ageDays > 30) {
      decayMemoryConfidence(row.id, -0.2);
      pruned += 1;
    }

    if (row.retrievalCount === 0 && ageDays > 14) {
      saveMemory({
        category: row.category,
        key: row.key,
        value: row.value,
        confidence: row.confidence,
        importance: Math.min(row.importance, 0.3),
        source: row.source
      });
    }

    if (row.confidence < 0.2) {
      markMemorySoftDeleted(row.id);
      pruned += 1;
    }
  }

  return { pruned, promoted };
}

function tokenizeForSimilarity(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
  );
}

function wordSimilarity(a: string, b: string): number {
  const wordsA = tokenizeForSimilarity(a);
  const wordsB = tokenizeForSimilarity(b);
  if (!wordsA.size || !wordsB.size) return 0;
  let shared = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) shared += 1;
  }
  return shared / Math.max(wordsA.size, wordsB.size);
}

function areDuplicateMemories(a: JarvisMemory, b: JarvisMemory): boolean {
  if (a.category !== b.category || a.id === b.id) return false;

  const ak = a.key.toLowerCase();
  const av = a.value.toLowerCase();
  const bk = b.key.toLowerCase();
  const bv = b.value.toLowerCase();

  if (ak.includes(bk) || bk.includes(ak)) return true;
  if (av.includes(bv) || bv.includes(av)) return true;

  return wordSimilarity(a.key, b.key) > 0.6 || wordSimilarity(a.value, b.value) > 0.6;
}

function pickDuplicateKeeper(a: JarvisMemory, b: JarvisMemory): JarvisMemory {
  if (a.retrievalCount !== b.retrievalCount) {
    return a.retrievalCount > b.retrievalCount ? a : b;
  }
  if (a.confidence !== b.confidence) {
    return a.confidence > b.confidence ? a : b;
  }
  return Date.parse(a.createdAt) >= Date.parse(b.createdAt) ? a : b;
}

function daysSinceIso(iso: string | null): number {
  if (!iso) return 999;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / (24 * 60 * 60 * 1000)) : 999;
}

function isOhioSunday(): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long"
  }).format(new Date());
  return weekday === "Sunday";
}

export async function runWeeklyMemoryAudit(): Promise<{
  duplicatesRemoved: number;
  staleDecayed: number;
  softDeleted: number;
  promoted: number;
}> {
  const ohioTime = getOhioDateTimeString();
  const rows = getAllActiveMemoriesForAudit();
  const removedIds = new Set<number>();
  let duplicatesRemoved = 0;
  let staleDecayed = 0;
  let softDeleted = 0;
  let promoted = 0;

  const byCategory = new Map<string, JarvisMemory[]>();
  for (const row of rows) {
    const bucket = byCategory.get(row.category) || [];
    bucket.push(row);
    byCategory.set(row.category, bucket);
  }

  for (const group of byCategory.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (removedIds.has(a.id) || removedIds.has(b.id)) continue;
        if (!areDuplicateMemories(a, b)) continue;

        const keeper = pickDuplicateKeeper(a, b);
        const loser = keeper.id === a.id ? b : a;
        setMemoryConfidenceAbsolute(loser.id, 0);
        removedIds.add(loser.id);
        duplicatesRemoved += 1;
      }
    }
  }

  for (const row of rows) {
    if (removedIds.has(row.id)) continue;
    if (MEMORY_NEVER_DECAY.includes(row.category as (typeof MEMORY_NEVER_DECAY)[number])) {
      continue;
    }

    const staleByCreation = !row.lastRetrievedAt && daysSinceIso(row.createdAt) > 90;
    const staleByRetrieval = row.lastRetrievedAt ? daysSinceIso(row.lastRetrievedAt) > 90 : false;
    if (!staleByCreation && !staleByRetrieval) continue;

    const nextConfidence = Math.max(0, row.confidence - 0.15);
    setMemoryConfidenceAbsolute(row.id, nextConfidence);
    staleDecayed += 1;

    if (nextConfidence < 0.1) {
      setMemoryConfidenceAbsolute(row.id, 0);
      softDeleted += 1;
    }
  }

  for (const row of rows) {
    if (removedIds.has(row.id)) continue;
    if (row.category !== MEMORY_CATEGORIES.WORLD_INTEL) continue;
    if (row.retrievalCount < 3) continue;

    promoteWorldIntelMemory(row.id);
    promoted += 1;
  }

  const summary = `Weekly audit: ${duplicatesRemoved} duplicates removed, ${staleDecayed} stale decayed, ${promoted} promoted`;
  insertMemorySynthesisLog({
    ohioTime,
    category: "weekly_audit",
    memoriesRead: rows.length,
    memoriesCreated: 0,
    memoriesUpdated: staleDecayed + promoted,
    memoriesPruned: duplicatesRemoved + softDeleted,
    synthesisSummary: summary
  });

  console.log(`[memory-audit] ${summary} (${softDeleted} soft deleted)`);
  invalidateDynamicPromptCache();

  return { duplicatesRemoved, staleDecayed, softDeleted, promoted };
}

export async function runDailySynthesis(): Promise<{
  categoriesProcessed: number;
  memoriesCreated: number;
  memoriesUpdated: number;
  memoriesPruned: number;
}> {
  const ohioTime = getOhioDateTimeString();
  let categoriesProcessed = 0;
  let memoriesCreated = 0;
  let memoriesUpdated = 0;
  let memoriesPruned = 0;
  const allGaps: string[] = [];

  for (const category of SYNTHESIS_CATEGORIES) {
    const memories = getMemoriesByCategory(category, 0.25);
    if (memories.length < 3) continue;

    let result: SynthesisResult | null = null;
    try {
      result = await synthesizeCategory(category, memories, ohioTime);
    } catch (error) {
      console.error(`[memory-synthesis] category ${category} failed`, error);
      continue;
    }

    if (!result) continue;
    categoriesProcessed += 1;

    const stats = processSynthesisResult(category, result);
    memoriesCreated += stats.created;
    memoriesUpdated += stats.updated;
    memoriesPruned += stats.pruned;

    for (const gap of result.knowledge_gaps || []) {
      if (gap.trim()) allGaps.push(gap.trim());
    }

    insertMemorySynthesisLog({
      ohioTime,
      category,
      memoriesRead: memories.length,
      memoriesCreated: stats.created,
      memoriesUpdated: stats.updated,
      memoriesPruned: stats.pruned,
      synthesisSummary: JSON.stringify({
        knowledge_gaps: result.knowledge_gaps || [],
        contradictions: (result.contradictions || []).length,
        insights: (result.synthesized_insights || []).length
      })
    });
  }

  const worldCleanup = cleanupWorldIntelMemories();
  memoriesPruned += worldCleanup.pruned;
  memoriesCreated += worldCleanup.promoted;

  insertMemorySynthesisLog({
    ohioTime,
    category: "world_intel_cleanup",
    memoriesRead: getMemoriesByCategory(MEMORY_CATEGORIES.WORLD_INTEL, 0).length,
    memoriesCreated: worldCleanup.promoted,
    memoriesUpdated: 0,
    memoriesPruned: worldCleanup.pruned,
    synthesisSummary: JSON.stringify({ knowledge_gaps: allGaps.slice(0, 10) })
  });

  setSystemState("last_daily_synthesis_run", new Date().toISOString());
  invalidateDynamicPromptCache();

  console.log(
    `[memory-synthesis] Done: ${categoriesProcessed} categories, +${memoriesCreated} created, ${memoriesPruned} pruned`
  );

  if (isOhioSunday()) {
    console.log("[memory-audit] Starting weekly memory audit...");
    await runWeeklyMemoryAudit();
  }

  return { categoriesProcessed, memoriesCreated, memoriesUpdated, memoriesPruned };
}

export function startDailySynthesisScheduler() {
  let lastRunDate = getSystemState("last_daily_synthesis_date") || "";

  setInterval(() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      hour12: false
    }).formatToParts(new Date());

    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
    const dateKey = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;

    if (hour === 2 && dateKey !== lastRunDate) {
      lastRunDate = dateKey;
      setSystemState("last_daily_synthesis_date", dateKey);
      console.log("[memory-synthesis] Starting daily synthesis...");
      void runDailySynthesis().catch((err) => {
        console.error("[memory-synthesis] scheduler error", err);
      });
    }
  }, 60_000);
}
