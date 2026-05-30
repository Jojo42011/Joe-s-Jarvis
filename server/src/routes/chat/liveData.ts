import {
  getActiveAlertPayload,
  getRecentConversation,
  logExecution,
  type ConversationState
} from "../../db/queries";
import { buildChatStateForClaude } from "./memoryOrchestrator";
import { buildDynamicSystemPrompt, invalidateDynamicPromptCache } from "../../config/systemPrompt";
import { findWorkingModel } from "../../services/claude";
import { braveCircuit, claudeCircuit, CircuitOpenError } from "../../services/circuitBreaker";
import {
  searchNews,
  searchWeather,
  searchWeb,
  shouldUseNewsSearch,
  shouldUseWeatherSearch,
  type BraveWeatherResult
} from "../../services/braveSearch";
import { getWorldIntelSinceHours } from "../../brain/worldIntelStore";
import { rememberMemory } from "../../services/memory";
import { REACT_DOMAIN_TO_CATEGORY } from "../../config/memoryCategories";
import { MEMORY_CATEGORIES } from "../../services/memory";
import { logServiceWarn } from "../../utils/logError";
import {
  buildDateTimePromptPrefix,
  chatAnthropic,
  claudeWithTimeout,
  isSendCommand,
  isSendVerification,
  normalizeJarvisResponse,
  parseJsonObject,
  parseTemperatureF,
  CHECKING_SPEECH_PATTERN
} from "./utils";
import type {
  IntentResponse,
  ReactLiveDataResult,
  ReactPromotionContext,
  SearchDecision,
  WeatherPanelData
} from "./types";
import { isOperationalBriefQuery } from "./operationalBrief";
import { routeLog } from "../../utils/requestLog";

export function messageNeedsLiveDataSearch(message: string): boolean {
  if (isOperationalBriefQuery(message)) return false;
  if (isSendCommand(message) || isSendVerification(message)) return false;

  const q = message.toLowerCase();
  if (/\b(brief me|rundown|catch me up|fill me in|last night|overnight|what did you do|what have you done)\b/.test(q)) {
    return false;
  }
  if (shouldUseWeatherSearch(message) || shouldUseNewsSearch(message)) return true;

  const weatherPattern =
    /\b(weather|temperature|temp|cold|hot|warm|frost|freeze|freezing|snow|rain|storm|wind|forecast|conditions|crews|field conditions|humidity|chill|degrees)\b/i;
  const workOutsidePattern = /\b(work outside|outside today|can we work|safe to work)\b/i;
  const newsPattern =
    /\b(news|tariff|supply|price|cost|inflation|economy|world|russia|china|ukraine|headline)\b/i;
  const happeningPattern =
    /what'?s happening|what'?s going on|going on in|what'?s out there|anything going on/i;
  const lookupPattern =
    /\b(look up|lookup|search for|search the|find out|find me|pull up|get me|check the|check on|latest|current|right now|today|this week|this morning)\b/i;
  const questionWord = /\b(what|how|when|where|why|who|can|should|is|are|will|do|does)\b/i;
  const regionalPattern = /\b(ohio|holmes county|millersburg)\b/i;
  const pushbackPattern =
    /\b(you didn'?t|didn'?t you|why didn'?t|try again|look it up|check it|actually check|go check|run that|pull that)\b/i;

  if (weatherPattern.test(q) || workOutsidePattern.test(q)) return true;
  if (newsPattern.test(q) || happeningPattern.test(q)) return true;
  if (lookupPattern.test(q)) return true;
  if (pushbackPattern.test(q) && (weatherPattern.test(q) || lookupPattern.test(q) || newsPattern.test(q)))
    return true;
  if (regionalPattern.test(q) && questionWord.test(q)) return true;

  if (/\b(how cold|how hot|how warm|going to rain|gonna rain|freeze tonight)\b/i.test(q)) return true;

  return /headlines|current events|supply chain|steel price|material cost|how much|price of|internet|outside world|anything else going on|market|commodit/i.test(
    q
  );
}

export function deriveCrewImpact(
  tempF: number | null,
  summary: string
): { crew_impact: WeatherPanelData["crew_impact"]; crew_note: string } {
  const q = summary.toLowerCase();
  const hasPrecip = /rain|snow|precip|ice|sleet|storm|freezing|frost/.test(q);

  if (tempF !== null) {
    if (tempF < 20) {
      return {
        crew_impact: "NO-GO",
        crew_note: "Sub-freezing temps - outdoor crew safety risk."
      };
    }
    if (tempF <= 35 || hasPrecip) {
      return {
        crew_impact: "CAUTION",
        crew_note: hasPrecip
          ? "Cold or wet conditions - plan gear and shorter outdoor blocks."
          : "Cool temps - monitor wind chill and crew comfort."
      };
    }
    return {
      crew_impact: "GO",
      crew_note: "Conditions support normal outdoor operations."
    };
  }

  if (hasPrecip) {
    return { crew_impact: "CAUTION", crew_note: "Precipitation in forecast - plan accordingly." };
  }
  return { crew_impact: "CAUTION", crew_note: "Verify conditions on site before dispatch." };
}

export function buildWeatherPanel(weather: BraveWeatherResult, speech: string): WeatherPanelData {
  const summary = weather.summary || speech;
  const tempF = parseTemperatureF(summary);
  const crew = deriveCrewImpact(tempF, summary);

  let wind = "";
  const windMatch = summary.match(/Wind:\s*([^.;]+)/i);
  if (windMatch) wind = windMatch[1].trim();

  let conditions = "";
  const condMatch = summary.match(/Conditions:\s*([^.;]+)/i);
  if (condMatch) conditions = condMatch[1].trim();

  return {
    location: "Holmes County, OH",
    temperature: tempF != null ? `${tempF}°F` : summary.slice(0, 80) || "See briefing",
    conditions: conditions || summary.slice(0, 120) || "-",
    wind: wind || "-",
    crew_impact: crew.crew_impact,
    crew_note: crew.crew_note
  };
}

export async function decideSearchNeeds(
  message: string,
  history: ReturnType<typeof getRecentConversation>,
  state: unknown
): Promise<SearchDecision> {
  const fallback: SearchDecision = {
    needs_search: messageNeedsLiveDataSearch(message),
    search_type: shouldUseWeatherSearch(message)
      ? "weather"
      : shouldUseNewsSearch(message)
        ? "news"
        : "web",
    query: message.trim(),
    reasoning: "Pattern-based routing"
  };

  if (!chatAnthropic) return fallback;
  const anthropic = chatAnthropic;

  const model = await findWorkingModel();
  if (!model) return fallback;

  const system = `${await buildDynamicSystemPrompt(message)}\n\n${buildDateTimePromptPrefix()}You are the JARVIS tool planner. Return JSON only.`;

  try {
    const response = await claudeCircuit.execute("search-decision", () =>
      claudeWithTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 400,
          temperature: 0.1,
          system,
          messages: [
            {
              role: "user",
              content: `Joe asked: ${message}\n\nOPERATOR STATE:\n${JSON.stringify(state).slice(0, 6000)}\n\nIf this message matches weather, news, world events, lookups, or live facts — needs_search MUST be true. Prefer search_type weather for field/forecast questions, news for headlines, web otherwise.\n\nReturn JSON:\n{"needs_search":true/false,"search_type":"weather"|"news"|"web","query":"exact query","reasoning":"brief"}`
            }
          ]
        }),
        15_000,
        "search-decision"
      )
    );

    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "";
    const parsed = parseJsonObject(text);
    if (!parsed) return fallback;

    const needs_search = Boolean(parsed.needs_search);
    const search_type = String(parsed.search_type || fallback.search_type);
    const query = String(parsed.query || message).trim();
    const reasoning = String(parsed.reasoning || "");

    if (search_type !== "weather" && search_type !== "news" && search_type !== "web") {
      return { ...fallback, needs_search };
    }

    return { needs_search, search_type, query: query || message, reasoning };
  } catch (error) {
    logServiceWarn("chat", "decideSearchNeeds", error);
    return fallback;
  }
}

export async function executeBraveSearchForChat(
  searchType: "weather" | "news" | "web",
  query: string
): Promise<{ source: string; results: unknown; weather?: BraveWeatherResult; empty: boolean }> {
  try {
    return await braveCircuit.execute(`search_${searchType}`, async () => {
      if (searchType === "weather") {
        const weather = await searchWeather(query);
        const empty = !weather.summary && Object.keys(weather.raw).length === 0;
        return { source: "weather", results: weather, weather, empty };
      }
      if (searchType === "news") {
        const results = await searchNews(query);
        return { source: "news", results, empty: !results.length };
      }
      const results = await searchWeb(query);
      return { source: "web", results, empty: !results.length };
    });
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      return { source: searchType, results: [], empty: true };
    }
    throw error;
  }
}

export function getWorldIntelCacheFallback(query: string): unknown[] {
  const cached = getWorldIntelSinceHours(48).filter(
    (w) => w.summary && (w.relevance === "HIGH" || w.relevance === "MEDIUM")
  );
  const q = query.toLowerCase();
  const matched = cached.filter(
    (w) => w.query.toLowerCase().includes(q.slice(0, 20)) || q.includes(w.query.toLowerCase().slice(0, 12))
  );
  return (matched.length ? matched : cached.slice(0, 5)).map((w) => ({
    query: w.query,
    summary: w.summary,
    relevance: w.relevance,
    cached: true
  }));
}

export async function synthesizeLiveDataAnswer(input: {
  message: string;
  searchType: string;
  query: string;
  searchPayload: unknown;
  usedCache: boolean;
  state: unknown;
}): Promise<IntentResponse> {
  const fallbackSpeech =
    input.usedCache && Array.isArray(input.searchPayload) && input.searchPayload.length
      ? `Sir, Brave returned nothing fresh. Using our last intel: ${String((input.searchPayload as { summary?: string }[])[0]?.summary || "see panel")}.`
      : "Sir, I could not pull live results. Try again in a moment.";

  const fallback: IntentResponse = {
    speech: fallbackSpeech,
    intent: "world.intel",
    entities: {},
    ui: { panel: null, data: [], action: null },
    tool: { name: null, args: {} }
  };

  if (!chatAnthropic) return fallback;
  const anthropic = chatAnthropic;

  const model = await findWorkingModel();
  if (!model) return fallback;

  const system = `${await buildDynamicSystemPrompt(input.message)}\n\n${buildDateTimePromptPrefix()}Deliver your complete final answer now. Do not say you are checking. Do not ask Joe to confirm. You have the data. Answer completely in one response. Return JSON only matching the JARVIS response contract.`;

  try {
    const response = await claudeCircuit.execute("search-synthesize", () =>
      claudeWithTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 900,
          temperature: 0.25,
          system,
          messages: [
            {
              role: "user",
              content: `Joe asked: ${input.message}\n\nSearch type: ${input.searchType}\nQuery: ${input.query}\nCache fallback used: ${input.usedCache}\n\nSEARCH RESULTS:\n${JSON.stringify(input.searchPayload).slice(0, 12000)}\n\nReturn JSON with speech, intent (use world.intel), entities, ui, tool.\nWeather: ui.panel "weather", ui.action "show", data: [{ location, temperature, conditions, wind, crew_impact: "GO"|"CAUTION"|"NO-GO", crew_note }].\nComplete answer in speech — no checking language.`
            }
          ]
        }),
        25_000,
        "search-synthesize"
      )
    );

    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "";
    return normalizeJarvisResponse(text || JSON.stringify(fallback));
  } catch (error) {
    logServiceWarn("chat", "synthesizeLiveDataAnswer", error);
    return fallback;
  }
}

export function stripCheckingLanguage(speech: string): string {
  if (!CHECKING_SPEECH_PATTERN.test(speech)) return speech;
  return speech
    .replace(/[^.!?]*\b(checking|look(?:ing)? up|searching|fetching|stand by|one moment|let me check)[^.!?]*[.!?]?\s*/gi, "")
    .trim() || "Sir, here is what I found.";
}

export const REACT_MEMORY_DOMAINS = new Set([
  "weather",
  "supply_chain",
  "local",
  "world",
  "industry",
  "drone_faa",
  "crew_labor"
]);

export const MAX_REACT_MEMORY_WRITES = 2;

export const REACT_MEMORY_PROMOTION_SYSTEM = `You assess whether a Brave search result should become long-term memory for Joe Stewart's landscaping business. Return only JSON.`;

export function summarizeBraveResultsForMemory(payload: unknown): string {
  if (!payload) return "No results.";
  if (typeof payload === "object" && payload !== null && "summary" in payload) {
    const w = payload as BraveWeatherResult;
    return w.summary || JSON.stringify(w.raw).slice(0, 800);
  }
  if (Array.isArray(payload)) {
    return payload
      .slice(0, 3)
      .map((row, i) => {
        if (!row || typeof row !== "object") return `${i + 1}. (empty)`;
        const r = row as Record<string, unknown>;
        return `${i + 1}. ${String(r.title || "-")}: ${String(r.description || r.snippet || "").slice(0, 120)}`;
      })
      .join("\n");
  }
  return JSON.stringify(payload).slice(0, 1200);
}

export function parseReActMemoryDecisions(
  raw: string
): Array<{ remember: true; key: string; value: string; domain: string }> {
  try {
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as unknown;

    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const out: Array<{ remember: true; key: string; value: string; domain: string }> = [];

    for (const row of rows.slice(0, MAX_REACT_MEMORY_WRITES)) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (!r.remember) continue;
      const key = String(r.key || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 200);
      const value = String(r.value || "").trim().slice(0, 8000);
      const domain = String(r.domain || "world").trim();
      if (!key || !value || !REACT_MEMORY_DOMAINS.has(domain)) continue;
      out.push({ remember: true, key, value, domain });
    }
    return out;
  } catch {
    return [];
  }
}

export async function promoteReActMemory(input: ReactPromotionContext): Promise<void> {
  if (!chatAnthropic) return;
  const anthropic = chatAnthropic;

  const model = await findWorkingModel();
  if (!model) return;

  const braveSummary = summarizeBraveResultsForMemory(input.searchPayload);

  try {
    const response = await claudeCircuit.execute("react-memory-promote", () =>
      claudeWithTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 500,
          temperature: 0.15,
          system: REACT_MEMORY_PROMOTION_SYSTEM,
          messages: [
            {
              role: "user",
              content: `You just searched Brave for: ${input.query}
Search type: ${input.searchType}
You found (top results):
${braveSummary}
You answered Joe with: ${input.answer}

Assess: did you just discover something genuinely worth remembering long-term about Joe's business environment, operating conditions, or a domain you are responsible for mastering?

Ask yourself:
- Is this a durable fact that will still matter in 30+ days?
- Would knowing this change how you advise Joe in a future conversation?
- Or is this a transient data point that expires within days (today's temp, yesterday's news)?

Durable examples:
'Ohio OSHA requires crews stop outdoor work below -13°F wind chill under cold stress guidelines'
'Steel tariffs increased 25% - affects hardscape material costs for active quotes'
'Holmes County added new permit requirements for retaining walls over 4 feet - check before quoting'

Transient examples (do NOT save):
'Holmes County was 28°F on May 18 2026'
'There was a snowstorm last Tuesday'
'Mulch prices were $X this week'

If durable: return { "remember": true, "key": "short_snake_case_key", "value": "clean one-two sentence durable fact", "domain": "weather"|"supply_chain"|"local"|"world"|"industry"|"drone_faa"|"crew_labor" }
If transient: return { "remember": false }

Return only JSON. Nothing else.`
            }
          ]
        }),
        15_000,
        "react-memory-promote"
      )
    );

    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "";
    const decisions = parseReActMemoryDecisions(text);

    for (const item of decisions.slice(0, MAX_REACT_MEMORY_WRITES)) {
      const category =
        REACT_DOMAIN_TO_CATEGORY[item.domain] || MEMORY_CATEGORIES.BUSINESS_CONTEXT;
      await rememberMemory({
        category,
        key: item.key,
        value: item.value,
        confidence: 0.85
      });
      logExecution({
        type: "world_intel",
        action: "memory.promote",
        item_id: item.key,
        summary: `ReAct memory promoted: ${item.key} (${item.domain})`,
        result: "success"
      });
      invalidateDynamicPromptCache();
    }
  } catch (error) {
    logServiceWarn("chat", "promoteReActMemory", error);
  }
}

export function scheduleReActMemoryPromotion(ctx: ReactPromotionContext) {
  setImmediate(() => {
    void promoteReActMemory(ctx);
  });
}

export async function runReactLiveDataRoute(
  message: string,
  state: ConversationState,
  alertPayload: ReturnType<typeof getActiveAlertPayload>
): Promise<ReactLiveDataResult | null> {
  if (!messageNeedsLiveDataSearch(message)) return null;
  routeLog("hit: runReactLiveDataRoute");

  if (!process.env.BRAVE_API_KEY?.trim()) {
    return {
      response: {
        speech:
          "Sir, Brave Search is not configured. I cannot pull live data without it.",
        intent: "world.intel",
        entities: {},
        ui: { panel: null, data: [], action: null },
        tool: { name: null, args: {} }
      }
    };
  }

  const operatorState = buildChatStateForClaude(state, alertPayload);
  let decision = await decideSearchNeeds(message, [], operatorState);

  if (!decision.needs_search && messageNeedsLiveDataSearch(message)) {
    logExecution({
      type: "world_intel",
      action: "react.force_search",
      item_id: message.slice(0, 120),
      summary: `[ReAct] Search planner skipped live-data message; forcing search`,
      result: "success"
    });
    decision = {
      needs_search: true,
      search_type: "web",
      query: message.trim(),
      reasoning: "Forced override — message matched live-data patterns"
    };
  }

  if (!decision.needs_search) return null;

  let searchPayload: unknown;
  let usedCache = false;
  let weatherResult: BraveWeatherResult | undefined;

  try {
    const executed = await executeBraveSearchForChat(decision.search_type, decision.query);
    weatherResult = executed.weather;
    searchPayload = executed.results;

    console.log(`[brave] search executed: ${decision.query} (${decision.search_type})`);

    logExecution({
      type: "world_intel",
      action: "brave.search",
      item_id: decision.query.slice(0, 120),
      summary: `Brave search executed: ${decision.query} (${decision.search_type})`,
      result: executed.empty ? "failed" : "success"
    });

    if (executed.empty) {
      const cache = getWorldIntelCacheFallback(decision.query);
      if (cache.length) {
        searchPayload = cache;
        usedCache = true;
        logExecution({
          type: "world_intel",
          action: "brave.search",
          summary: `Brave empty - used world_intel cache for: ${decision.query}`,
          result: "success"
        });
      }
    }
  } catch (error) {
    logServiceWarn("chat", "Brave search", error);
    const cache = getWorldIntelCacheFallback(decision.query);
    if (cache.length) {
      searchPayload = cache;
      usedCache = true;
    } else {
      searchPayload = { error: "Brave search failed" };
    }
  }

  let response = await synthesizeLiveDataAnswer({
    message,
    searchType: decision.search_type,
    query: decision.query,
    searchPayload,
    usedCache,
    state: operatorState
  });

  response.intent = "world.intel";
  response.speech = stripCheckingLanguage(response.speech);

  if (decision.search_type === "weather" && weatherResult) {
    const panel = buildWeatherPanel(weatherResult, response.speech);
    response.ui = {
      panel: "weather",
      action: "show",
      data: [panel]
    };
  } else if (response.ui.panel === "weather" && response.ui.data?.length) {
    response.ui = { ...response.ui, action: "show" };
  }

  return {
    response,
    promote: usedCache
      ? undefined
      : {
          query: decision.query,
          searchType: decision.search_type,
          searchPayload,
          answer: response.speech
        }
  };
}
