export type BraveWebResult = {
  title: string;
  url: string;
  description: string;
  age?: string;
};

export type BraveNewsResult = {
  title: string;
  url: string;
  description: string;
  age?: string;
};

import { braveCircuit, CircuitOpenError } from "./circuitBreaker";
import { logServiceWarn } from "../utils/logError";

export type BraveWeatherResult = {
  query: string;
  raw: Record<string, unknown>;
  summary: string;
};

const WEB_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const NEWS_ENDPOINT = "https://api.search.brave.com/res/v1/news/search";
const RICH_ENDPOINT = "https://api.search.brave.com/res/v1/web/rich";
const MAX_RESULTS = 5;

function getApiKey(): string | null {
  const key = process.env.BRAVE_API_KEY?.trim();
  return key || null;
}

function mapWebResult(row: Record<string, unknown>): BraveWebResult | null {
  const title = String(row.title || "").trim();
  const url = String(row.url || "").trim();
  if (!title || !url) return null;
  const description = String(row.description || row.snippet || "").trim();
  const age = row.age != null ? String(row.age) : undefined;
  return { title, url, description, age };
}

function mapNewsResult(row: Record<string, unknown>): BraveNewsResult | null {
  const title = String(row.title || "").trim();
  const url = String(row.url || "").trim();
  if (!title || !url) return null;
  const description = String(row.description || row.snippet || "").trim();
  const age = row.age != null ? String(row.age) : row.page_age != null ? String(row.page_age) : undefined;
  return { title, url, description, age };
}

function extractCallbackKey(payload: Record<string, unknown>): string | null {
  const rich = payload.rich as Record<string, unknown> | undefined;
  if (!rich) return null;
  const hint = rich.hint as Record<string, unknown> | undefined;
  const fromHint = hint?.callback_key;
  if (fromHint != null && String(fromHint).trim()) return String(fromHint).trim();
  const direct = rich.callback_key;
  if (direct != null && String(direct).trim()) return String(direct).trim();
  return null;
}

function buildWeatherSummary(raw: Record<string, unknown>): string {
  const parts: string[] = [];

  const weather = raw.weather as Record<string, unknown> | undefined;
  const data = (weather?.data ?? raw.data ?? raw) as Record<string, unknown>;
  const main = data.main as Record<string, unknown> | undefined;

  const temp = data.temp ?? data.temperature ?? main?.temp;
  if (temp != null) parts.push(`Temperature: ${temp}`);

  let conditions = data.conditions ?? data.description;
  if (!conditions && Array.isArray(data.weather)) {
    const first = data.weather[0] as Record<string, unknown> | undefined;
    conditions = first?.description;
  }
  if (conditions) parts.push(`Conditions: ${conditions}`);

  const precip = data.precipitation ?? data.rain ?? data.snow;
  if (precip != null && String(precip).trim()) parts.push(`Precipitation: ${precip}`);

  const humidity = data.humidity;
  if (humidity != null) parts.push(`Humidity: ${humidity}`);

  const wind = data.wind_speed ?? data.wind;
  if (wind != null) parts.push(`Wind: ${wind}`);

  return parts.join(". ").slice(0, 500);
}

async function braveFetch(
  endpoint: string,
  query: string,
  extraParams?: Record<string, string>
): Promise<Record<string, unknown> | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logServiceWarn("Brave", "config", "BRAVE_API_KEY not set");
    return null;
  }

  if (braveCircuit.isOpen()) {
    return null;
  }

  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(MAX_RESULTS));
  url.searchParams.set("freshness", endpoint === NEWS_ENDPOINT ? "pd" : "pw");

  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      url.searchParams.set(key, value);
    }
  }

  try {
    return await braveCircuit.execute(`fetch_${endpoint}`, async () => {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey
        }
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 120)}`);
      }

      return (await response.json()) as Record<string, unknown>;
    });
  } catch (error) {
    if (error instanceof CircuitOpenError) return null;
    logServiceWarn("Brave", "request", error);
    return null;
  }
}

async function braveFetchRich(callbackKey: string): Promise<Record<string, unknown> | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logServiceWarn("Brave", "config", "BRAVE_API_KEY not set");
    return null;
  }

  const url = new URL(RICH_ENDPOINT);
  url.searchParams.set("callback_key", callbackKey);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logServiceWarn("Brave", "rich callback", `HTTP ${response.status}: ${body.slice(0, 120)}`);
      return null;
    }

    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    logServiceWarn("Brave", "rich callback", error);
    return null;
  }
}

export async function searchWeb(query: string): Promise<BraveWebResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const payload = await braveFetch(WEB_ENDPOINT, trimmed);
  if (!payload) return [];

  const web = payload.web as Record<string, unknown> | undefined;
  const results = (web?.results || payload.results) as unknown;
  if (!Array.isArray(results)) return [];

  return results
    .map((row) => (row && typeof row === "object" ? mapWebResult(row as Record<string, unknown>) : null))
    .filter((r): r is BraveWebResult => r !== null)
    .slice(0, MAX_RESULTS);
}

export async function searchNews(query: string): Promise<BraveNewsResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const payload = await braveFetch(NEWS_ENDPOINT, trimmed);
  if (!payload) return [];

  const news = payload.news as Record<string, unknown> | undefined;
  const results = (news?.results || payload.results) as unknown;
  if (!Array.isArray(results)) return [];

  return results
    .map((row) => (row && typeof row === "object" ? mapNewsResult(row as Record<string, unknown>) : null))
    .filter((r): r is BraveNewsResult => r !== null)
    .slice(0, MAX_RESULTS);
}

export async function searchWeather(query: string): Promise<BraveWeatherResult> {
  const trimmed = query.trim();
  const empty: BraveWeatherResult = { query: trimmed, raw: {}, summary: "" };
  if (!trimmed) return empty;

  try {
    const payload = await braveFetch(WEB_ENDPOINT, trimmed, { enable_rich_callback: "1" });
    if (!payload) {
      logServiceWarn("Brave", "searchWeather", "initial request failed, falling back to searchWeb");
      await searchWeb(trimmed);
      return empty;
    }

    const callbackKey = extractCallbackKey(payload);
    if (!callbackKey) {
      logServiceWarn("Brave", "searchWeather", "no callback_key, falling back to searchWeb");
      await searchWeb(trimmed);
      return empty;
    }

    const rich = await braveFetchRich(callbackKey);
    if (!rich) {
      logServiceWarn("Brave", "searchWeather", "rich fetch failed, falling back to searchWeb");
      await searchWeb(trimmed);
      return empty;
    }

    return {
      query: trimmed,
      raw: rich,
      summary: buildWeatherSummary(rich)
    };
  } catch (error) {
    logServiceWarn("Brave", "searchWeather", error);
    try {
      await searchWeb(trimmed);
    } catch {
      // ignore fallback errors
    }
    return empty;
  }
}

export function shouldUseWeatherSearch(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /\bweather\b/.test(q) ||
    /\bforecast\b/.test(q) ||
    /\btemperature\b/.test(q) ||
    /\bfrost\b/.test(q) ||
    /\bfreeze\b/.test(q) ||
    /\brain\b/.test(q) ||
    /\bsnow\b/.test(q) ||
    /\bstorm\b/.test(q) ||
    /\bcold\b/.test(q) ||
    /\bheat\b/.test(q) ||
    /\bhumidity\b/.test(q) ||
    /\bwind\b/.test(q)
  );
}

export function shouldUseNewsSearch(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /\bnews\b/.test(q) ||
    /\btariff/.test(q) ||
    /\bregulation/.test(q) ||
    /\bgeopolit/.test(q) ||
    /\bsupply chain/.test(q) ||
    /\beconomy\b/.test(q) ||
    /\bohio\b/.test(q) ||
    /\blocal\b/.test(q)
  );
}
