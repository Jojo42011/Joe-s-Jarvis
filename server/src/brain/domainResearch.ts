import Anthropic from "@anthropic-ai/sdk";
import {
  countDomainResearchMemories,
  getMemoryByCategoryKey,
  insertDomainResearchLog,
  saveMemory,
  setSystemState,
  getSystemState
} from "../db/queries";
import {
  RESEARCH_DOMAINS,
  getResearchDomainById,
  type ResearchDomain
} from "../config/researchDomains";
import { findFastWorkingModel, findWorkingModel } from "../services/claude";
import { claudeCircuit } from "../services/circuitBreaker";
import { logServiceError, logServiceWarn } from "../utils/logError";
import {
  searchNews,
  searchWeather,
  searchWeb,
  shouldUseNewsSearch,
  shouldUseWeatherSearch
} from "../services/braveSearch";
import { insertWorldIntel } from "./worldIntelStore";
import { getOhioDateTimeString } from "../routes/chat/utils";
import { invalidateDynamicPromptCache } from "../config/systemPrompt";

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const SEARCH_DELAY_MS = 500;
const OHIO_TZ = "America/New_York";

export type DomainResearchResult = {
  domain: string;
  queries_run: number;
  results_saved: number;
  memories_promoted: number;
  world_intel_ids: number[];
  success: boolean;
  error?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ohioDateKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OHIO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export function shouldDomainRun(domain: ResearchDomain): boolean {
  const last = getSystemState(domain.system_state_key);
  if (!last?.trim()) return true;
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return true;
  const intervalMs = domain.interval_days * 24 * 60 * 60 * 1000;
  return Date.now() - lastMs >= intervalMs;
}

async function runBraveForQuery(query: string): Promise<string> {
  if (shouldUseWeatherSearch(query)) {
    const weather = await searchWeather(query);
    return JSON.stringify({ source: "weather", results: weather });
  }
  if (shouldUseNewsSearch(query)) {
    const results = await searchNews(query);
    const fallback = results.length ? results : await searchWeb(query);
    return JSON.stringify({ source: "news", results: fallback });
  }
  const results = await searchWeb(query);
  const fallback = results.length ? results : await searchNews(query);
  return JSON.stringify({ source: "web", results: fallback });
}

async function generateDomainQueries(domain: ResearchDomain, ohioTime: string): Promise<string[]> {
  if (!anthropic) return [...domain.seed_queries].slice(0, 6);

  const model = await findFastWorkingModel();
  if (!model) return [...domain.seed_queries].slice(0, 6);

  const system = `You are a research query generator for JARVIS,
AI operator for Joe Stewart's landscaping business in Ohio.
Generate 4-6 highly specific search queries for this domain.
Return JSON array of query strings only.

Domain: ${domain.label}
Research focus: ${domain.query_guidance}
Seed topics: ${domain.seed_queries.join("; ")}
Today's date: ${ohioTime}

Make queries specific and timely. Include year when relevant.
Prioritize actionable business intelligence over general news.`;

  try {
    const response = await claudeCircuit.execute("domain-research-queries", () =>
      anthropic.messages.create({
        model,
        max_tokens: 800,
        temperature: 0.3,
        system,
        messages: [{ role: "user", content: "Return the JSON array of search queries." }]
      })
    );
    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.text?.trim() || "[]";
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const start = jsonText.indexOf("[");
    const end = jsonText.lastIndexOf("]");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as unknown;
    if (!Array.isArray(parsed)) return [...domain.seed_queries].slice(0, 6);
    return parsed
      .map((q) => String(q).trim())
      .filter((q) => q.length > 2)
      .slice(0, 6);
  } catch (error) {
    logServiceWarn("domain-research", `query generation ${domain.id}`, error);
    return [...domain.seed_queries].slice(0, 6);
  }
}

type DomainInsight = {
  key: string;
  value: string;
  confidence: number;
  importance: number;
};

async function extractDomainInsights(
  domain: ResearchDomain,
  combinedResults: Array<{ query: string; resultsJson: string }>
): Promise<DomainInsight[]> {
  if (!anthropic || !combinedResults.length) return [];

  const model = await findWorkingModel();
  if (!model) return [];

  const payload = combinedResults.map((r) => ({
    query: r.query,
    results: (() => {
      try {
        return JSON.parse(r.resultsJson);
      } catch {
        return r.resultsJson;
      }
    })()
  }));

  const system = `You are JARVIS's domain intelligence engine.
Read these search results and extract 3-5 key insights
that would make JARVIS smarter about ${domain.label}
for Joe Stewart's landscaping business in Ohio.

Each insight should be:
- Specific and actionable, not generic
- Worth remembering for ${domain.interval_days} days or more
- Directly relevant to Joe's business operations

Return JSON array:
[{
  "key": string,
  "value": string,
  "confidence": 0.8,
  "importance": number
}]

Return [] if nothing genuinely valuable found.`;

  try {
    const response = await claudeCircuit.execute("domain-research-insights", () =>
      anthropic.messages.create({
        model,
        max_tokens: 1500,
        temperature: 0.2,
        system,
        messages: [
          {
            role: "user",
            content: `Search results:\n${JSON.stringify(payload).slice(0, 14000)}`
          }
        ]
      })
    );
    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.text?.trim() || "[]";
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const start = jsonText.indexOf("[");
    const end = jsonText.lastIndexOf("]");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: DomainInsight[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const key = String(rec.key || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 120);
      const value = String(rec.value || "").trim().slice(0, 8000);
      if (!key || !value) continue;
      out.push({
        key,
        value,
        confidence: Math.min(1, Math.max(0.5, Number(rec.confidence) || 0.8)),
        importance: Math.min(1, Math.max(0.1, Number(rec.importance) || domain.importance))
      });
    }
    return out.slice(0, 5);
  } catch (error) {
    logServiceWarn("domain-research", `insights ${domain.id}`, error);
    return [];
  }
}

export async function runDomainResearch(domain: ResearchDomain): Promise<DomainResearchResult> {
  const ohioTime = getOhioDateTimeString();
  const dateKey = ohioDateKey();
  const worldIntelIds: number[] = [];
  let queriesRun = 0;
  let resultsSaved = 0;
  let memoriesPromoted = 0;

  if (!process.env.BRAVE_API_KEY?.trim()) {
    return {
      domain: domain.id,
      queries_run: 0,
      results_saved: 0,
      memories_promoted: 0,
      world_intel_ids: [],
      success: false,
      error: "BRAVE_API_KEY missing"
    };
  }

  try {
    const queries = await generateDomainQueries(domain, ohioTime);
    const combinedResults: Array<{ query: string; resultsJson: string }> = [];

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      queriesRun += 1;
      try {
        const resultsJson = await runBraveForQuery(query);
        const id = insertWorldIntel({
          query,
          resultsJson,
          domain: domain.id
        });
        worldIntelIds.push(id);
        resultsSaved += 1;
        combinedResults.push({ query, resultsJson });
      } catch (error) {
        logServiceWarn("domain-research", `search ${domain.id}: ${query}`, error);
      }
      if (i < queries.length - 1) await sleep(SEARCH_DELAY_MS);
    }

    const insights = await extractDomainInsights(domain, combinedResults);
    for (const insight of insights) {
      const memoryKey = `${domain.id}_${insight.key}_${dateKey}`.slice(0, 200);
      if (getMemoryByCategoryKey(domain.memory_category, memoryKey)) continue;
      saveMemory({
        category: domain.memory_category,
        key: memoryKey,
        value: insight.value,
        confidence: insight.confidence,
        importance: insight.importance,
        source: "domain_research",
        isSynthesized: 0
      });
      memoriesPromoted += 1;
    }

    const now = new Date().toISOString();
    setSystemState(domain.system_state_key, now);
    const summary = `${queriesRun} queries, ${resultsSaved} cached, ${memoriesPromoted} memories`;
    insertDomainResearchLog({
      domain: domain.id,
      ohioTime,
      queriesRun,
      resultsSaved,
      memoriesPromoted,
      summary
    });
    invalidateDynamicPromptCache();

    console.log(`[domain-research] ${domain.id} complete — ${summary}`);

    return {
      domain: domain.id,
      queries_run: queriesRun,
      results_saved: resultsSaved,
      memories_promoted: memoriesPromoted,
      world_intel_ids: worldIntelIds,
      success: true
    };
  } catch (error) {
    logServiceError("domain-research", domain.id, error);
    return {
      domain: domain.id,
      queries_run: queriesRun,
      results_saved: resultsSaved,
      memories_promoted: memoriesPromoted,
      world_intel_ids: worldIntelIds,
      success: false,
      error: error instanceof Error ? error.message : "unknown"
    };
  }
}

export type DomainStatus = {
  id: string;
  label: string;
  memory_category: string;
  interval_days: number;
  last_run: string | null;
  next_due: string;
  is_due: boolean;
  memories_count: number;
};

export function getDomainStatuses(): DomainStatus[] {
  const now = Date.now();
  return RESEARCH_DOMAINS.map((domain) => {
    const lastRunRaw = getSystemState(domain.system_state_key);
    const lastRunMs = lastRunRaw ? Date.parse(lastRunRaw) : NaN;
    const intervalMs = domain.interval_days * 24 * 60 * 60 * 1000;
    const hasRun = lastRunRaw && !Number.isNaN(lastRunMs);
    const isDue = !hasRun || now - lastRunMs >= intervalMs;
    const nextDueMs = hasRun ? lastRunMs + intervalMs : now;
    return {
      id: domain.id,
      label: domain.label,
      memory_category: domain.memory_category,
      interval_days: domain.interval_days,
      last_run: lastRunRaw,
      next_due: new Date(nextDueMs).toISOString(),
      is_due: isDue,
      memories_count: countDomainResearchMemories(domain.id)
    };
  });
}

export async function runDueDomainResearch(): Promise<DomainResearchResult[]> {
  const results: DomainResearchResult[] = [];
  const allWorldIntelIds: number[] = [];

  for (const domain of RESEARCH_DOMAINS) {
    if (!shouldDomainRun(domain)) continue;
    try {
      const result = await runDomainResearch(domain);
      results.push(result);
      allWorldIntelIds.push(...result.world_intel_ids);
    } catch (error) {
      logServiceError("domain-research", `due loop ${domain.id}`, error);
      results.push({
        domain: domain.id,
        queries_run: 0,
        results_saved: 0,
        memories_promoted: 0,
        world_intel_ids: [],
        success: false,
        error: error instanceof Error ? error.message : "unknown"
      });
    }
  }

  if (allWorldIntelIds.length) {
    try {
      const { Judgment } = await import("./judgment");
      const judgment = new Judgment();
      await judgment.judgeWorldIntel(allWorldIntelIds);
    } catch (error) {
      logServiceWarn("domain-research", "judgeWorldIntel", error);
    }
  }

  if (results.length) {
    console.log(
      `[domain-research] Due run finished — ${results.length} domain(s), ${allWorldIntelIds.length} world_intel row(s)`
    );
  }

  return results;
}

export { getResearchDomainById };
