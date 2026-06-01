import Anthropic from "@anthropic-ai/sdk";
import { normalizeMemoryCategory } from "../config/memoryCategories";
import {
  getMemoryByCategoryKey,
  getTopMemoriesForExtraction,
  insertMemoryExtractionLog,
  type JarvisMemory,
  upsertExtractedMemory
} from "../db/queries";
import { invalidateDynamicPromptCache } from "../config/systemPrompt";
import { findFastWorkingModel } from "../services/claude";
import { claudeCircuit } from "../services/circuitBreaker";
import { applyImportanceHeuristics, shouldSkipExtraction } from "./judgmentRules";

const extractAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export type MemorySummary = {
  category: string;
  key: string;
  value: string;
  confidence: number;
};

export type ExtractedMemory = {
  category: string;
  key: string;
  value: string;
  confidence: number;
  importance: number;
  is_update: boolean;
  updates_key?: string;
};

const EXTRACTION_SYSTEM = `You are a memory extraction engine for JARVIS, an AI operator for Joe Stewart who runs a multimillion dollar landscaping business in Ohio.

Your job: read the conversation turn and extract ONLY information worth remembering long term. Be selective. Not everything is worth saving. Ask yourself: would knowing this make JARVIS smarter about Joe's business 6 months from now?

EXTRACT — things worth remembering:
- Client names, details, issues, preferences, payment behavior
- Crew member names, reliability, skills, problems
- Vendor names, terms, relationships, issues
- Job names, locations, status, special notes
- How Joe thinks, decides, prefers things done
- Business patterns (seasonal, financial, operational)
- Specific numbers that matter (amounts, dates, quantities)
- Problems Joe is dealing with
- Things Joe explicitly asks you to remember

DO NOT EXTRACT — noise:
- Generic weather or news already in world_intel
- Things Joe said in passing with no business relevance
- Questions Joe asked that you answered (the answer isn't a memory)
- Anything that would be outdated in 30 days
- Duplicate information already in existing memories (check the list)
- JARVIS's own responses or reasoning

CATEGORIES (pick the best fit):
- business_context: operations, jobs, revenue, strategy
- client_relations: specific clients, their details and behavior
- operator_preferences: how Joe likes things done, his style
- crew_labor: crew members, their roles, performance
- vendor_supplier: vendors, their terms, reliability
- financial_operations: money, invoices, costs, cash flow
- industry: landscaping industry knowledge Joe shared
- document_facts: facts from documents Joe uploaded

For each memory worth saving, return:
{
  "category": string,
  "key": string,
  "value": string,
  "confidence": number,
  "importance": number,
  "is_update": boolean,
  "updates_key": string
}

Return a JSON array only. No preamble. No explanation.
Empty array [] if nothing worth saving.
Max 5 memories per turn — be selective.`;

function toMemorySummaries(memories: JarvisMemory[]): MemorySummary[] {
  return memories.map((m) => ({
    category: m.category,
    key: m.key,
    value: m.value,
    confidence: m.confidence
  }));
}

function formatExistingList(memories: MemorySummary[]): string {
  if (!memories.length) return "(none)";
  return memories
    .slice(0, 20)
    .map((m) => `${m.key}: ${m.value.slice(0, 120)}`)
    .join("\n");
}

function parseExtractedArray(text: string): ExtractedMemory[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  const slice = start >= 0 && end >= start ? text.slice(start, end + 1) : text;
  const parsed = JSON.parse(slice) as unknown;
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedMemory[] = [];
  for (const row of parsed.slice(0, 5)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const key = String(r.key || "").trim().slice(0, 200);
    const value = String(r.value || "").trim().slice(0, 8000);
    const category = normalizeMemoryCategory(String(r.category || "business_context"));
    if (!key || !value) continue;
    out.push({
      category,
      key,
      value,
      confidence: Math.min(1, Math.max(0.1, Number(r.confidence) || 0.75)),
      importance: Math.min(1, Math.max(0.1, Number(r.importance) || 0.5)),
      is_update: Boolean(r.is_update),
      updates_key: r.updates_key ? String(r.updates_key).trim().slice(0, 200) : undefined
    });
  }
  return out;
}

async function callClaudeExtraction(
  userMessage: string,
  jarvisResponse: string,
  existingMemories: MemorySummary[]
): Promise<ExtractedMemory[]> {
  if (!extractAnthropic) return [];

  const model = await findFastWorkingModel();
  if (!model) return [];

  const responseSummary = jarvisResponse.slice(0, 200);
  const userPrompt = `Conversation turn:
Joe said: ${userMessage.slice(0, 2000)}
JARVIS responded: ${responseSummary}

Existing memories to check for duplicates:
${formatExistingList(existingMemories)}`;

  const response = await claudeCircuit.execute("memory_extraction", () =>
    extractAnthropic.messages.create({
      model,
      max_tokens: 900,
      temperature: 0.15,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: "user", content: userPrompt }]
    })
  );

  const text = response.content.find((b) => b.type === "text")?.text?.trim() || "[]";
  try {
    return parseExtractedArray(text);
  } catch {
    return [];
  }
}

function writeExtractedMemory(item: ExtractedMemory): boolean {
  const targetKey =
    item.is_update && item.updates_key ? item.updates_key.slice(0, 200) : item.key;

  const duplicate = getMemoryByCategoryKey(item.category, targetKey);
  if (
    duplicate &&
    duplicate.value.trim().toLowerCase() === item.value.trim().toLowerCase()
  ) {
    return false;
  }

  const importance = applyImportanceHeuristics({
    category: item.category,
    key: targetKey,
    value: item.value,
    importance: item.importance,
    source: "conversation_extraction"
  });

  upsertExtractedMemory({
    category: item.category,
    key: targetKey,
    value: item.value,
    confidence: item.confidence,
    importance,
    source: "conversation_extraction"
  });
  return true;
}

export async function extractMemoriesFromTurn(
  userMessage: string,
  jarvisResponse: string,
  sessionId: string,
  existingMemories?: MemorySummary[]
): Promise<ExtractedMemory[]> {
  if (shouldSkipExtraction(userMessage, jarvisResponse)) return [];

  const contextMemories =
    existingMemories ?? toMemorySummaries(getTopMemoriesForExtraction(20));

  let extracted: ExtractedMemory[] = [];
  try {
    extracted = await callClaudeExtraction(userMessage, jarvisResponse, contextMemories);
  } catch (error) {
    console.error("[memory-extract] Claude call failed", error);
    return [];
  }

  const categoriesHit = new Set<string>();
  let written = 0;

  for (const item of extracted) {
    try {
      if (writeExtractedMemory(item)) {
        written += 1;
        categoriesHit.add(item.category);
      }
    } catch (error) {
      console.error("[memory-extract] write failed", error);
    }
  }

  if (written > 0) {
    invalidateDynamicPromptCache();
  }

  insertMemoryExtractionLog({
    sessionId,
    turnSummary: `${userMessage.slice(0, 120)} → ${jarvisResponse.slice(0, 80)}`,
    memoriesExtracted: written,
    categoriesHit: [...categoriesHit]
  });

  return extracted;
}

export function scheduleMemoryExtraction(
  userMessage: string,
  jarvisResponse: string,
  sessionId: string
) {
  setImmediate(() => {
    void (async () => {
      try {
        const relevantMemories = getTopMemoriesForExtraction(20);
        await extractMemoriesFromTurn(
          userMessage,
          jarvisResponse,
          sessionId,
          toMemorySummaries(relevantMemories)
        );
      } catch (err) {
        console.error("[memory-extract]", err);
      }
    })();
  });
}
