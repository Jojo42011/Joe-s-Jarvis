import Anthropic from "@anthropic-ai/sdk";

import {

  clearGmailAuthAlertIfPresent,

  countHandledQueueItems,

  getCallsAfterRowId,

  getExecutionLogSince,

  getLastCallIntelCursor,

  getQueue,

  getSystemState,

  getTextsSince,

  getTopMemories,

  setLastCallIntelCursor,

  setSystemState

} from "../db/queries";

import { findWorkingModel } from "../services/claude";
import { runMemoryMaintenance } from "../services/memory";
import { logServiceError, logServiceWarn } from "../utils/logError";

import { getGmailMessagesSince } from "../services/gmail";

import {
  searchNews,
  searchWeather,
  searchWeb,
  shouldUseNewsSearch,
  shouldUseWeatherSearch
} from "../services/braveSearch";

import { WORLD_INTEL_SENSE_QUERY_DOMAIN_GUIDANCE } from "./judgment";
import { insertWorldIntel } from "./worldIntelStore";

import type { PerceptionCall, PerceptionEmail, PerceptionPayload, PerceptionText, TimeOfDay } from "./types";



const OHIO_TZ = "America/New_York";

const WORLD_INTEL_SCHEDULER_MS = 60_000;



const anthropic = process.env.ANTHROPIC_API_KEY

  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  : null;



function defaultEmailSinceMs(): number {

  const raw = getSystemState("last_email_check");

  if (!raw) return Date.now() - 60 * 60 * 1000;

  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? Date.now() - 60 * 60 * 1000 : parsed;

}



function defaultTextSinceMs(): number {

  const raw = getSystemState("last_text_check");

  if (!raw) return Date.now() - 24 * 60 * 60 * 1000;

  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? Date.now() - 24 * 60 * 60 * 1000 : parsed;

}



function timeOfDayFromDate(d: Date): TimeOfDay {

  const h = d.getHours();

  if (h < 12) return "morning";

  if (h < 17) return "afternoon";

  if (h < 21) return "evening";

  return "night";

}



function parseStateDate(key: string): Date | null {

  const raw = getSystemState(key);

  if (!raw) return null;

  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? null : new Date(parsed);

}



function isSameCalendarDay(a: Date, b: Date) {

  return (

    a.getFullYear() === b.getFullYear() &&

    a.getMonth() === b.getMonth() &&

    a.getDate() === b.getDate()

  );

}



function ohioNowParts(): { hour: number; minute: number; dateKey: string } {

  const parts = new Intl.DateTimeFormat("en-US", {

    timeZone: OHIO_TZ,

    hour: "numeric",

    minute: "numeric",

    year: "numeric",

    month: "2-digit",

    day: "2-digit",

    hour12: false

  }).formatToParts(new Date());



  const get = (type: string) => parts.find((p) => p.type === type)?.value || "0";

  return {

    hour: Number(get("hour")),

    minute: Number(get("minute")),

    dateKey: `${get("year")}-${get("month")}-${get("day")}`

  };

}



function deriveSeason(month: number): string {

  if (month >= 3 && month <= 5) return "spring";

  if (month >= 6 && month <= 8) return "summer";

  if (month >= 9 && month <= 11) return "fall";

  return "winter";

}



async function claudeJsonArray(system: string, user: string, maxTokens = 1200): Promise<string[]> {

  if (!anthropic) return [];

  const model = await findWorkingModel();

  if (!model) return [];



  try {

    const response = await anthropic.messages.create({

      model,

      max_tokens: maxTokens,

      temperature: 0.3,

      system,

      messages: [{ role: "user", content: user }]

    });

    const textBlock = response.content.find((b) => b.type === "text");

    const raw = textBlock?.text?.trim() || "[]";

    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

    const start = jsonText.indexOf("[");

    const end = jsonText.lastIndexOf("]");

    const parsed = JSON.parse(

      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText

    ) as unknown;

    if (!Array.isArray(parsed)) return [];

    return parsed.map((q) => String(q).trim()).filter((q) => q.length > 2).slice(0, 8);

  } catch (error) {
    logServiceWarn("world-intel", "Claude query generation", error);
    return [];

  }

}



function buildWorldIntelContext(): Record<string, unknown> {

  const since24h = Date.now() - 24 * 60 * 60 * 1000;

  const month = new Date().getMonth() + 1;



  let emailsReceived: unknown[] = [];

  try {

    emailsReceived = [];

    void getGmailMessagesSince(since24h, 30).then((e) => {

      emailsReceived = e.map((m) => ({

        from: m.from,

        subject: m.subject,

        snippet: m.snippet?.slice(0, 200),

        priority: m.priority

      }));

    });

  } catch {

    emailsReceived = [];

  }



  const emailsPromise = getGmailMessagesSince(since24h, 30).catch(() => []);



  return {

    season: deriveSeason(month),

    month,

    priorityQueue: getQueue(false).map((q) => ({

      type: q.type,

      summary: q.summary,

      urgency: q.urgency,

      actionNeeded: q.actionNeeded

    })),

    callsLast24h: getCallsAfterRowId(0, 30)

      .filter((c) => Date.parse(c.timestamp) >= since24h)

      .map((c) => ({

        from: c.from,

        reason: c.reason,

        outcome: c.outcome,

        time: c.time

      })),

    executionLogLast24h: getExecutionLogSince(new Date(since24h)).map((e) => ({

      type: e.type,

      action: e.action,

      summary: e.summary,

      result: e.result

    })),

    memories: getTopMemories(15).map((m) => ({

      category: m.category,

      key: m.key,

      value: m.value?.slice(0, 200)

    })),

    activeAlert: getSystemState("active_alert"),

    emailsReceived: [] as unknown[]

  };

}



async function buildWorldIntelContextAsync(): Promise<Record<string, unknown>> {

  const since24h = Date.now() - 24 * 60 * 60 * 1000;

  const month = new Date().getMonth() + 1;



  let emailsReceived: unknown[] = [];

  try {

    const emails = await getGmailMessagesSince(since24h, 30);

    emailsReceived = emails.map((m) => ({

      from: m.from,

      subject: m.subject,

      snippet: m.snippet?.slice(0, 200),

      priority: m.priority

    }));

  } catch (error) {
    logServiceWarn("world-intel", "Gmail context", error);
  }



  return {

    season: deriveSeason(month),

    month,

    dayOfWeek: new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: OHIO_TZ }),

    priorityQueue: getQueue(false).map((q) => ({

      type: q.type,

      summary: q.summary,

      urgency: q.urgency,

      actionNeeded: q.actionNeeded

    })),

    callsLast24h: getCallsAfterRowId(0, 40)

      .filter((c) => Date.parse(c.timestamp) >= since24h)

      .map((c) => ({

        from: c.from,

        reason: c.reason,

        outcome: c.outcome,

        time: c.time

      })),

    executionLogLast24h: getExecutionLogSince(new Date(since24h)).map((e) => ({

      type: e.type,

      action: e.action,

      summary: e.summary,

      result: e.result

    })),

    memories: getTopMemories(15).map((m) => ({

      category: m.category,

      key: m.key,

      value: m.value?.slice(0, 200)

    })),

    activeAlert: getSystemState("active_alert"),

    emailsReceived

  };

}



const WORLD_QUERY_SYSTEM = `You are JARVIS, chief of staff to Joe Stewart, owner of Totally Outdoors LLC, a multimillion dollar landscaping business in Holmes County Ohio.



Based on the context below, decide what you need to know about the world today to do your job.



Think like a human operator: what could affect Joe's business, money, safety, crew operations, material costs, client relationships, or strategic decisions?



Also consider: world events (geopolitics, economy, supply chains), US national news, local Ohio news, weather, industry trends, competitor activity, regulations.



Generate between 3 and 8 search queries. No more than 8.

Only search for things that could genuinely matter.

If nothing significant is happening, generate fewer queries.



Return ONLY a JSON array of query strings. Nothing else.${WORLD_INTEL_SENSE_QUERY_DOMAIN_GUIDANCE}`;



export class Perception {

  async sense(): Promise<PerceptionPayload> {

    const now = new Date();

    const joeLastActive = parseStateDate("joe_last_active");

    const lastBriefingTime = parseStateDate("last_briefing_time");

    const joeActiveToday = joeLastActive ? isSameCalendarDay(joeLastActive, now) : false;



    let newEmails: PerceptionEmail[] = [];

    let emailCursor = defaultEmailSinceMs();



    try {

      const emails = await getGmailMessagesSince(emailCursor, 40);

      newEmails = emails.map((e) => ({

        id: e.id,

        threadId: e.threadId,

        from: e.from,

        subject: e.subject,

        snippet: e.snippet,

        priority: e.priority,

        time: e.time,

        internalDate: e.internalDate

      }));

      if (emails.length) {

        emailCursor = Math.max(emailCursor, ...emails.map((e) => e.internalDate));

      }

      setSystemState("last_email_check", new Date(emailCursor).toISOString());
      clearGmailAuthAlertIfPresent();

    } catch (error) {
      logServiceWarn("Gmail", "perception poll", error);
      setSystemState(
        "active_alert",
        JSON.stringify({
          hasAlert: true,
          type: "gmail_auth",
          summary: "Gmail unavailable — token refresh may need manual re-auth",
          at: new Date().toISOString()
        })
      );
    }



    const lastCallId = getLastCallIntelCursor();

    const calls = getCallsAfterRowId(lastCallId, 40);

    let maxCallId = lastCallId;

    const newCalls: PerceptionCall[] = calls.map((c) => {

      maxCallId = Math.max(maxCallId, c.id);

      return {

        id: c.id,

        from: c.from,

        reason: c.reason,

        outcome: c.outcome,

        transcript: c.transcript,

        priorityLevel: c.priorityLevel,

        duration: c.duration,

        time: c.time

      };

    });

    if (calls.length) {

      setLastCallIntelCursor(maxCallId);

      setSystemState("last_call_check", calls[calls.length - 1]?.timestamp || now.toISOString());

    }



    const textSince = defaultTextSinceMs();

    const texts = getTextsSince(textSince, 40);

    const newTexts: PerceptionText[] = texts.map((t) => ({

      id: t.id,

      from: t.from,

      preview: t.preview,

      time: t.time

    }));

    if (texts.length) {

      const maxTs = texts[texts.length - 1]?.timestamp;

      if (maxTs) setSystemState("last_text_check", maxTs);

    }



    let criticalAlertActive = false;

    try {

      const alertRaw = getSystemState("active_alert");

      if (alertRaw) {

        const parsed = JSON.parse(alertRaw) as { hasAlert?: boolean };

        criticalAlertActive = Boolean(parsed?.hasAlert);

      }

    } catch {

      criticalAlertActive = false;

    }



    return {

      newEmails,

      newCalls,

      newTexts,

      timeOfDay: timeOfDayFromDate(now),

      dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),

      joeLastActive,

      joeActiveToday,

      itemsHandledToday: countHandledQueueItems(),

      lastBriefingTime,

      currentQueueSize: getQueue(false).length,

      criticalAlertActive

    };

  }



  async senseWorld(): Promise<number> {

    if (!process.env.BRAVE_API_KEY?.trim()) {

      logServiceWarn("world-intel", "senseWorld", "BRAVE_API_KEY missing — skipping");

      return 0;

    }



    try {

      const context = await buildWorldIntelContextAsync();

      const queries = await claudeJsonArray(

        WORLD_QUERY_SYSTEM,

        `Context:\n${JSON.stringify(context).slice(0, 14000)}`

      );



      if (!queries.length) {

        console.log("[world-intel] No queries generated");

        setSystemState("last_world_intel_run", new Date().toISOString());

        return 0;

      }



      let inserted = 0;

      for (const query of queries) {

        let resultsJson: string;

        if (shouldUseWeatherSearch(query)) {

          const weather = await searchWeather(query);

          resultsJson = JSON.stringify({ source: "weather", results: weather });

        } else if (shouldUseNewsSearch(query)) {

          const results = await searchNews(query);

          const fallback = results.length ? results : await searchWeb(query);

          resultsJson = JSON.stringify({ source: "news", results: fallback });

        } else {

          const results = await searchWeb(query);

          const fallback = results.length ? results : await searchNews(query);

          resultsJson = JSON.stringify({ source: "web", results: fallback });

        }



        insertWorldIntel({ query, resultsJson, domain: "general" });

        inserted += 1;

      }



      setSystemState("last_world_intel_run", new Date().toISOString());

      console.log(`[world-intel] senseWorld complete — ${inserted} queries`);

      return inserted;

    } catch (error) {
      logServiceError("world-intel", "senseWorld", error);
      return 0;

    }

  }



  async runOnDemandWorldSearch(query: string): Promise<{ id: number; summary: string | null } | null> {

    const trimmed = query.trim();

    if (!trimmed) return null;



    let resultsJson: string;

    if (shouldUseWeatherSearch(trimmed)) {

      const weather = await searchWeather(trimmed);

      resultsJson = JSON.stringify({ source: "weather", results: weather, onDemand: true });

    } else if (shouldUseNewsSearch(trimmed)) {

      const results = await searchNews(trimmed);

      const fallback = results.length ? results : await searchWeb(trimmed);

      resultsJson = JSON.stringify({ source: "news", results: fallback, onDemand: true });

    } else {

      const results = await searchWeb(trimmed);

      const fallback = results.length ? results : await searchNews(trimmed);

      resultsJson = JSON.stringify({ source: "web", results: fallback, onDemand: true });

    }



    const id = insertWorldIntel({

      query: trimmed,

      resultsJson,

      domain: "general"

    });



    return { id, summary: null };

  }

}



export async function runWorldIntelPipeline(): Promise<void> {

  try {

    const perception = new Perception();

    const inserted = await perception.senseWorld();

    if (inserted > 0) {

      const { Judgment } = await import("./judgment");

      const judgment = new Judgment();

      await judgment.judgeWorldIntel();

    }

  } catch (error) {
    logServiceError("world-intel", "pipeline", error);
  }

}



function alreadyRanWorldIntelTodayOhio(): boolean {

  const last = getSystemState("last_world_intel_run");

  if (!last) return false;

  const lastDate = new Date(last);

  const lastOhio = new Intl.DateTimeFormat("en-US", {

    timeZone: OHIO_TZ,

    year: "numeric",

    month: "2-digit",

    day: "2-digit"

  }).format(lastDate);

  const { dateKey } = ohioNowParts();

  return lastOhio === dateKey.replace(/\//g, "-") || lastOhio === dateKey;

}



function shouldRunScheduledWorldIntel(): boolean {

  const { hour, minute } = ohioNowParts();

  if (hour !== 7 || minute > 10) return false;

  return !alreadyRanWorldIntelTodayOhio();

}



let schedulerStarted = false;



export function startWorldIntelScheduler() {

  if (schedulerStarted) return;

  schedulerStarted = true;



  setInterval(() => {

    if (shouldRunScheduledWorldIntel()) {

      console.log("[world-intel] 7:00am Ohio scheduled run");

      void runWorldIntelPipeline();
      runMemoryMaintenance();

    }

  }, WORLD_INTEL_SCHEDULER_MS);



  if (shouldRunScheduledWorldIntel()) {

    void runWorldIntelPipeline();
    runMemoryMaintenance();

  }

}



startWorldIntelScheduler();



const WORLD_CHAT_PATTERNS =

  /what'?s going on|what is going on|world intel|outside world|in the news|anything else going on|news today|world news|landscaping news|what'?s happening/i;



export async function tryWorldIntelChatRoute(message: string): Promise<{

  speech: string;

  intent: string;

} | null> {

  if (!WORLD_CHAT_PATTERNS.test(message)) return null;



  const { getWorldIntelSinceHours, getMediumUnbriefedWorldIntel, formatWorldIntelBriefingSpeech } =

    await import("./worldIntelStore");

  const { Judgment } = await import("./judgment");



  const askingMore = /anything else|what else|more going on/i.test(message);

  if (askingMore) {

    const medium = getMediumUnbriefedWorldIntel(5);

    if (medium.length) {

      const speech = formatWorldIntelBriefingSpeech(medium) || "Nothing else pressing from the outside world, sir.";

      return { speech, intent: "world.intel" };

    }

  }



  const cached = getWorldIntelSinceHours(48).filter((r) => r.relevance === "HIGH" || r.relevance === "MEDIUM");

  if (cached.length) {

    const top = cached.slice(0, 5);

    const speech =

      formatWorldIntelBriefingSpeech(top) ||

      top.map((t) => t.summary).filter(Boolean).join(" ") ||

      "I have recent world intel but no summaries yet, sir.";

    return { speech, intent: "world.intel" };

  }



  const match = message.match(/(?:about|on|with|regarding)\s+(.+?)(?:\?|$)/i);

  const query = match?.[1]?.trim() || message.replace(WORLD_CHAT_PATTERNS, "").trim() || "US news today";



  const perception = new Perception();

  const row = await perception.runOnDemandWorldSearch(query);

  if (!row) {

    return { speech: "Brave search is unavailable, sir. Check the API key.", intent: "world.intel" };

  }



  const judgment = new Judgment();

  await judgment.judgeWorldIntel([row.id]);



  const { getWorldIntelById } = await import("./worldIntelStore");

  const updated = getWorldIntelById(row.id);

  const speech =

    updated?.summary ||

    "Search complete, sir. I am still processing relevance.";



  return { speech, intent: "world.intel" };

}


