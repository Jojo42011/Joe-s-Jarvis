import Anthropic from "@anthropic-ai/sdk";
import { buildDynamicSystemPrompt } from "../config/systemPrompt";
import { claudeCircuit, CircuitOpenError } from "./circuitBreaker";
import { isRateLimitError } from "../utils/rateLimit";
import { logServiceError } from "../utils/logError";
import { buildExecutionSummarySpeech } from "../utils/executionSummary";
import { briefLog, claudeLog } from "../utils/requestLog";
import {
  buildFallbackBriefingSpeech,
  compileBriefingData
} from "../brain/communication";
import { JARVIS_SPEECH_OUTPUT_RULES, JUDGMENT_RULES } from "../brain/judgment";
import type { ActivationContext } from "../brain/activationBriefing";
import type { JudgmentDecision, PerceptionPayload } from "../brain/types";
import type { ConversationMessage, ExecutionLogEntry } from "../db/queries";

const apiKey = process.env.ANTHROPIC_API_KEY;

const anthropic = apiKey
  ? new Anthropic({ apiKey })
  : null;

const MODEL_CANDIDATES = [
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-7"
];

const FAST_MODEL_CANDIDATES = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-4-5"];

let resolvedModel: string | null = null;
let resolvedFastModel: string | null = null;

/** Only one operator-briefing Claude call at a time (HUD polls /rundown frequently). */
let operatorBriefingInFlight: Promise<string> | null = null;
let lastOperatorBriefing = { text: "", at: 0 };
let operatorBriefingMutexTimer: ReturnType<typeof setTimeout> | null = null;

const BRIEFING_MUTEX_MS = 45_000;

function operatorBriefingFallback(): string {
  return buildFallbackBriefingSpeech(compileBriefingData());
}

function releaseBriefingMutex(reason: string) {
  if (operatorBriefingMutexTimer) {
    clearTimeout(operatorBriefingMutexTimer);
    operatorBriefingMutexTimer = null;
  }
  if (operatorBriefingInFlight) {
    briefLog(`mutex released: ${reason}`);
  }
  operatorBriefingInFlight = null;
}

function armBriefingMutexWatchdog() {
  if (operatorBriefingMutexTimer) clearTimeout(operatorBriefingMutexTimer);
  operatorBriefingMutexTimer = setTimeout(() => {
    briefLog("mutex watchdog fired — force clear after 45s");
    operatorBriefingMutexTimer = null;
    operatorBriefingInFlight = null;
  }, BRIEFING_MUTEX_MS);
}

function logClaudeUsage(
  operation: string,
  model: string,
  startedAt: number,
  usage?: { input_tokens?: number; output_tokens?: number }
) {
  const latency = Date.now() - startedAt;
  const tokensIn = usage?.input_tokens ?? "?";
  const tokensOut = usage?.output_tokens ?? "?";
  claudeLog(`${operation}: ${model} | tokens_in: ${tokensIn} | tokens_out: ${tokensOut} | latency: ${latency}ms`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function probeModel(model: string): Promise<boolean> {
  if (!anthropic) return false;
  try {
    await withTimeout(
      anthropic.messages.create({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }]
      }),
      10_000,
      `probe:${model}`
    );
    return true;
  } catch {
    return false;
  }
}

async function resolveFromCandidates(candidates: string[]): Promise<string | null> {
  const envModel = process.env.ANTHROPIC_MODEL?.trim();
  if (envModel) {
    if (await probeModel(envModel)) return envModel;
    console.warn(`[Claude] ANTHROPIC_MODEL=${envModel} unavailable, probing fallbacks`);
  }
  for (const model of candidates) {
    if (await probeModel(model)) {
      console.log(`[Claude] Model locked: ${model}`);
      return model;
    }
  }
  console.error("[Claude] No working model found — check API key and billing");
  return null;
}

export async function findWorkingModel(): Promise<string | null> {
  if (resolvedModel) return resolvedModel;
  resolvedModel = await resolveFromCandidates(MODEL_CANDIDATES);
  return resolvedModel;
}

export async function findFastWorkingModel(): Promise<string | null> {
  if (resolvedFastModel) return resolvedFastModel;
  const envFast = process.env.ANTHROPIC_FAST_MODEL?.trim();
  if (envFast && (await probeModel(envFast))) {
    resolvedFastModel = envFast;
    return envFast;
  }
  resolvedFastModel = await resolveFromCandidates(FAST_MODEL_CANDIDATES);
  return resolvedFastModel;
}

export async function generateFastJarvisResponse(message: string) {
  if (!anthropic) {
    return JSON.stringify({
      speech: mockJarvisResponse(message),
      intent: "general.chat",
      entities: {},
      ui: { panel: null, data: [], action: null },
      tool: { name: null, args: {} }
    });
  }

  const model = await findFastWorkingModel();
  if (!model) {
    return JSON.stringify({
      speech: "Standing by, sir.",
      intent: "general.chat",
      entities: {},
      ui: { panel: null, data: [], action: null },
      tool: { name: null, args: {} }
    });
  }

  claudeLog(`fast-chat: ${model}`);

  try {
    const response = await claudeCircuit.execute("fast-chat", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 150,
          temperature: 0.25,
          system:
            "You are JARVIS, Joe Stewart's autonomous operator. Reply briefly, confidently, and in operator tone. Greetings and pleasantries only — no tools, no capability claims, no JSON commentary. Return JSON only with speech, intent general.chat, entities {}, ui {panel:null,data:[],action:null}, tool {name:null,args:{}}.",
          messages: [{ role: "user", content: message }]
        }),
        8_000,
        "fast-chat"
      )
    );

    return response.content.find((block) => block.type === "text")?.text?.trim() || "";
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      return JSON.stringify({
        speech: claudeCircuit.graceMessage(),
        intent: "general.chat",
        entities: {},
        ui: { panel: null, data: [], action: null },
        tool: { name: null, args: {} }
      });
    }
    logServiceError("Claude", "fast-chat", error);
    return JSON.stringify({
      speech: "Standing by, sir.",
      intent: "general.chat",
      entities: {},
      ui: { panel: null, data: [], action: null },
      tool: { name: null, args: {} }
    });
  }
}

function formatRecentConversation(history: ConversationMessage[]) {
  const turns = history
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .slice(-10)
    .map((entry) => {
      const speaker = entry.role === "user" ? "Joe" : "JARVIS";
      return `${speaker}: ${entry.content}`;
    });

  return turns.length ? turns.join("\n") : "No recent conversation yet.";
}

export async function generateDraftRewrite(input: {
  message: string;
  draft: string;
  selectedItem: unknown;
  state: unknown;
}) {
  const fallback = input.message.trim() || input.draft;

  if (!anthropic) {
    return fallback;
  }

  const model = await findWorkingModel();
  if (!model) {
    return fallback;
  }

  try {
    const system = `${await buildDynamicSystemPrompt()}

CURRENT CONVERSATION STATE JSON:
${JSON.stringify(input.state, null, 2)}

Rewrite only the email draft. Return plain email body text only. No JSON. No commentary.`;
    const response = await claudeCircuit.execute("draft-rewrite", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 350,
          temperature: 0.2,
          system,
          messages: [
            {
              role: "user",
              content: `Selected email:\n${JSON.stringify(input.selectedItem, null, 2)}\n\nCurrent draft:\n${input.draft}\n\nJoe's edit instruction:\n${input.message}`
            }
          ]
        }),
        15_000,
        "draft-rewrite"
      )
    );

    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.text?.trim() || fallback;
  } catch (error) {
    logServiceError("Claude", "draft-rewrite", error);
    return fallback;
  }
}

function mockJarvisResponse(message: string) {
  const trimmed = message.trim();

  if (!trimmed) {
    return "Standing by, sir.";
  }

  return `Signal received, sir. I heard: "${trimmed}". Claude is not connected yet — running in local foundation mode. Add ANTHROPIC_API_KEY with active billing to bring the full operator online.`;
}

export type TriageDecision = {
  urgency: "NOW" | "TODAY" | "THIS_WEEK" | "NONE";
  action: "HANDLE" | "DRAFT_REPLY" | "ESCALATE" | "LOG_ONLY" | "IGNORE";
  summary: string;
  action_needed: string | null;
  draft: string | null;
};

const TRIAGE_SYSTEM = `You are triaging incoming items for Joe Stewart. Joe runs a multimillion dollar landscaping business in Ohio.

Analyze the item and return JSON only (no markdown):
{
  "urgency": "NOW" | "TODAY" | "THIS_WEEK" | "NONE",
  "action": "HANDLE" | "DRAFT_REPLY" | "ESCALATE" | "LOG_ONLY" | "IGNORE",
  "summary": "one sentence max",
  "action_needed": "what Joe needs to do or null",
  "draft": "plain-text email draft if action is DRAFT_REPLY, else null"
}

Rules:
- HANDLE or IGNORE: obvious spam, mass newsletters, automated receipts with no action, robocall summaries.
- DRAFT_REPLY: client or lead needs a written response; include a short professional draft in draft.
- ESCALATE: job site emergency, payment failure, cancellation threat, foreman/crew urgent, anything time-sensitive from a known important party.
- LOG_ONLY: worth noting in a briefing but not urgent.
- Urgency NOW matches ESCALATE tier; TODAY for same-day action; THIS_WEEK for follow-ups; NONE with IGNORE.`;

function normalizeTriage(parsed: Record<string, unknown>): TriageDecision {
  const urgencyRaw = String(parsed.urgency || "NONE").toUpperCase();
  const urgency =
    urgencyRaw === "NOW" || urgencyRaw === "TODAY" || urgencyRaw === "THIS_WEEK" || urgencyRaw === "NONE"
      ? urgencyRaw
      : "NONE";

  const actionRaw = String(parsed.action || "LOG_ONLY").toUpperCase();
  const actionMap: Record<string, TriageDecision["action"]> = {
    HANDLE: "HANDLE",
    DRAFT_REPLY: "DRAFT_REPLY",
    ESCALATE: "ESCALATE",
    LOG_ONLY: "LOG_ONLY",
    IGNORE: "IGNORE"
  };
  const action = actionMap[actionRaw] || "LOG_ONLY";

  return {
    urgency: urgency as TriageDecision["urgency"],
    action,
    summary: String(parsed.summary || "Triaged item.").slice(0, 500),
    action_needed:
      parsed.action_needed === null || parsed.action_needed === undefined
        ? null
        : String(parsed.action_needed).slice(0, 500),
    draft:
      parsed.draft === null || parsed.draft === undefined
        ? null
        : String(parsed.draft).slice(0, 8000)
  };
}

export async function triageInboundItem(type: string, content: string): Promise<TriageDecision> {
  if (!anthropic) {
    return normalizeTriage({
      urgency: "NONE",
      action: "LOG_ONLY",
      summary: "Offline triage — add ANTHROPIC_API_KEY.",
      action_needed: null,
      draft: null
    });
  }

  const model = await findWorkingModel();
  if (!model) {
    return normalizeTriage({
      urgency: "NONE",
      action: "LOG_ONLY",
      summary: "Claude unavailable for triage.",
      action_needed: null,
      draft: null
    });
  }

  try {
    const response = await claudeCircuit.execute("triage", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 500,
          temperature: 0.2,
          system: TRIAGE_SYSTEM,
          messages: [
            {
              role: "user",
              content: `Type: ${type}\n\nContent (JSON or text):\n${content.slice(0, 12000)}`
            }
          ]
        }),
        25_000,
        "triage"
      )
    );

    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock?.text?.trim() || "{}";
    const jsonText = raw
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as Record<string, unknown>;

    return normalizeTriage(parsed);
  } catch (error) {
    logServiceError("Claude", "triageInboundItem", error);
    return normalizeTriage({
      urgency: "TODAY",
      action: "LOG_ONLY",
      summary: "Triage failed — logged for manual review.",
      action_needed: "Review this item",
      draft: null
    });
  }
}

async function runOperatorBriefing(queueJson: string): Promise<string> {
  return withTimeout(
    (async () => {
      if (!anthropic) {
        return operatorBriefingFallback();
      }

      const model = await findWorkingModel();
      if (!model) {
        briefLog("no model — using compileBriefingData fallback");
        return operatorBriefingFallback();
      }

      const startedAt = Date.now();
      try {
        const response = await claudeCircuit.execute("operator-briefing", () =>
          withTimeout(
            anthropic!.messages.create({
              model,
              max_tokens: 450,
              temperature: 0.35,
              system: `You are JARVIS. Generate a concise operator briefing for Joe Stewart (landscaping business, Ohio).
Rules:
- Most urgent first (NOW, then TODAY, then THIS_WEEK).
- One short sentence per queue item.
- End with how many items are still unhandled if any.
- Maximum ~60 seconds of speech if read aloud — stay tight.
- Plain text only, no JSON.`,
              messages: [
                {
                  role: "user",
                  content: `Priority queue JSON:\n${queueJson.slice(0, 14000)}`
                }
              ]
            }),
            45_000,
            "briefing"
          )
        );

        logClaudeUsage("operator-briefing", model, startedAt, response.usage);
        const textBlock = response.content.find((block) => block.type === "text");
        return textBlock?.text?.trim() || "Standing by, sir. Queue is quiet.";
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          briefLog("circuit open — compileBriefingData fallback");
          return operatorBriefingFallback();
        }
        if (isRateLimitError(error)) {
          briefLog("rate limited — compileBriefingData fallback");
          return operatorBriefingFallback();
        }
        logServiceError("Claude", "generateOperatorBriefing", error);
        return operatorBriefingFallback();
      }
    })(),
    BRIEFING_MUTEX_MS,
    "operator-briefing-total"
  ).catch((error) => {
    briefLog(`briefing failed: ${error instanceof Error ? error.message : "unknown"}`);
    return operatorBriefingFallback();
  });
}

export async function generateOperatorBriefing(queueJson: string): Promise<string> {
  if (operatorBriefingInFlight) {
    briefLog("operator-briefing skipped — already in progress");
    if (lastOperatorBriefing.text) return lastOperatorBriefing.text;
    return operatorBriefingFallback();
  }

  briefLog("mutex acquired");
  armBriefingMutexWatchdog();

  operatorBriefingInFlight = runOperatorBriefing(queueJson)
    .then((text) => {
      lastOperatorBriefing = { text, at: Date.now() };
      return text;
    })
    .finally(() => {
      releaseBriefingMutex("completed");
    });

  return operatorBriefingInFlight;
}

export type MemoryExtraction = {
  category: string;
  key: string;
  value: string;
  confidence: number;
};

const MEMORY_EXTRACTION_SYSTEM = `You extract durable operational memories about Joe Stewart (landscaping business owner, Ohio) from a single chat turn.

Return JSON only (no markdown): an array, possibly empty:
[
  { "category": string, "key": string, "value": string, "confidence": number }
]

Allowed categories (exact strings):
business_context, client_relations, operator_preferences, world_intel, crew_labor, vendor_supplier, drone_faa, industry, document_facts

Rules:
- Business facts → business_context
- Client details → client_relations
- Joe's preferences → operator_preferences
- World/market facts → world_intel
- Crew patterns → crew_labor
- Vendors/materials → vendor_supplier
- Drone/FAA → drone_faa
- Industry trends → industry
- Facts from documents → document_facts
- Only high-confidence learnings (confidence >= 0.65).
- Keys are short snake_case identifiers.
- Values are one or two concise sentences.
- If nothing clearly learnable, return [].
- Never invent private data not implied by the messages.

QUALITY FILTER — Only extract if the memory would be useful in a future conversation 30+ days from now.
Do not extract:
- Things already resolved or handled (spam archived, routine ack sent)
- Temporary states ("Joe is currently busy")
- One-time events with no recurring value
- Anything that will be stale in 48 hours
DO extract:
- Client preferences and history
- Joe's decision patterns
- Vendor relationships and pricing
- Crew facts and patterns
- Business rules Joe has stated
- Anything JARVIS should remember forever`;

export type EntityMentionExtraction = {
  name: string;
  entity_type: "client" | "vendor" | "crew" | "contact";
  facts: string;
};

const ENTITY_EXTRACTION_SYSTEM = `Extract any people mentioned in this conversation turn.
Return JSON only:
[{ "name": string, "entity_type": "client"|"vendor"|"crew"|"contact", "facts": string }]
Only include people where a meaningful fact was learned.
Return [] if nothing meaningful.`;

const EPISODIC_SUMMARY_SYSTEM = `Summarize this conversation session in 2-3 sentences.
Extract: key decisions made, people mentioned, topics covered.
Return JSON only:
{
  "summary": string,
  "key_decisions": string[],
  "people_mentioned": string[],
  "topics": string[]
}
Only include sessions with meaningful content.
If it was just small talk or all-clear, return null.`;

export async function extractLearnableMemoriesFromTurn(input: {
  userMessage: string;
  jarvisResponse: string;
  intent: string;
  outcome: string;
}): Promise<MemoryExtraction[]> {
  if (!anthropic) {
    return [];
  }

  const model = await findWorkingModel();
  if (!model) {
    return [];
  }

  try {
    const response = await claudeCircuit.execute("memory-extract", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 400,
          temperature: 0.15,
          system: MEMORY_EXTRACTION_SYSTEM,
          messages: [
            {
              role: "user",
              content: JSON.stringify(input).slice(0, 12000)
            }
          ]
        }),
        22_000,
        "memory-extract"
      )
    );

    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock?.text?.trim() || "[]";
    const jsonText = raw
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const start = jsonText.indexOf("[");
    const end = jsonText.lastIndexOf("]");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as unknown[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    const allowed = new Set([
      "business_context",
      "client_relations",
      "operator_preferences",
      "world_intel",
      "crew_labor",
      "vendor_supplier",
      "drone_faa",
      "industry",
      "document_facts"
    ]);

    return parsed
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        let category = String(r.category || "").trim();
        const key = String(r.key || "").trim();
        const value = String(r.value || "").trim();
        const confidence = Number(r.confidence);
        const legacyMap: Record<string, string> = {
          contact_priority: "client_relations",
          communication_style: "operator_preferences",
          decision_patterns: "operator_preferences",
          schedule_patterns: "business_context",
          preferences: "operator_preferences"
        };
        if (legacyMap[category]) category = legacyMap[category];
        if (!allowed.has(category) || !key || !value) return null;
        if (!Number.isFinite(confidence) || confidence < 0.65) return null;
        return {
          category,
          key: key.slice(0, 160),
          value: value.slice(0, 2000),
          confidence: Math.min(1, Math.max(0.65, confidence))
        } satisfies MemoryExtraction;
      })
      .filter((x): x is MemoryExtraction => Boolean(x));
  } catch (error) {
    logServiceError("Claude", "extractLearnableMemoriesFromTurn", error);
    return [];
  }
}

export async function extractEntitiesFromTurn(input: {
  userMessage: string;
  jarvisResponse: string;
}): Promise<EntityMentionExtraction[]> {
  if (!anthropic) return [];

  const model = await findWorkingModel();
  if (!model) return [];

  try {
    const response = await claudeCircuit.execute("entity-extract", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 350,
          temperature: 0.1,
          system: ENTITY_EXTRACTION_SYSTEM,
          messages: [
            {
              role: "user",
              content: JSON.stringify(input).slice(0, 8000)
            }
          ]
        }),
        18_000,
        "entity-extract"
      )
    );

    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock?.text?.trim() || "[]";
    const jsonText = raw
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const start = jsonText.indexOf("[");
    const end = jsonText.lastIndexOf("]");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as unknown[];

    if (!Array.isArray(parsed)) return [];

    const allowedTypes = new Set(["client", "vendor", "crew", "contact"]);
    return parsed
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        const name = String(r.name || "").trim();
        const entity_type = String(r.entity_type || "").trim() as EntityMentionExtraction["entity_type"];
        const facts = String(r.facts || "").trim();
        if (!name || !allowedTypes.has(entity_type) || !facts) return null;
        return { name: name.slice(0, 200), entity_type, facts: facts.slice(0, 1500) };
      })
      .filter((x): x is EntityMentionExtraction => Boolean(x));
  } catch (error) {
    logServiceError("Claude", "extractEntitiesFromTurn", error);
    return [];
  }
}

export type EpisodicSummary = {
  summary: string;
  key_decisions: string[];
  people_mentioned: string[];
  topics: string[];
};

export async function summarizeConversationForEpisodic(
  history: Array<{ role: string; content: string }>
): Promise<EpisodicSummary | null> {
  if (!anthropic || !history.length) return null;

  const model = await findWorkingModel();
  if (!model) return null;

  try {
    const response = await claudeCircuit.execute("episodic-summary", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 400,
          temperature: 0.15,
          system: EPISODIC_SUMMARY_SYSTEM,
          messages: [
            {
              role: "user",
              content: JSON.stringify({ turns: history.slice(-20) }).slice(0, 14000)
            }
          ]
        }),
        22_000,
        "episodic-summary"
      )
    );

    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock?.text?.trim() || "null";
    const jsonText = raw
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    if (/^null$/i.test(jsonText)) return null;

    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as Record<string, unknown>;

    const summary = String(parsed.summary || "").trim();
    if (!summary) return null;

    const key_decisions = Array.isArray(parsed.key_decisions)
      ? parsed.key_decisions.map((v) => String(v).trim()).filter(Boolean)
      : [];
    const people_mentioned = Array.isArray(parsed.people_mentioned)
      ? parsed.people_mentioned.map((v) => String(v).trim()).filter(Boolean)
      : [];
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.map((v) => String(v).trim()).filter(Boolean)
      : [];

    return { summary, key_decisions, people_mentioned, topics };
  } catch (error) {
    logServiceError("Claude", "summarizeConversationForEpisodic", error);
    return null;
  }
}

const JUDGMENT_SYSTEM = `You are the judgment system of JARVIS for Joe Stewart's landscaping business (Totally Outdoors LLC) in Ohio.
You receive raw inbound items and decide what actually matters right now.

Return JSON only — an array of decisions (one per input item):
[{
  "itemId": string,
  "itemType": "email" | "call" | "text",
  "action": "execute_now" | "queue" | "ignore",
  "notify": boolean,
  "notifyUrgency": "now" | "next_briefing" | "never",
  "reason": string,
  "escalation_reason": string | null,
  "summary": string,
  "urgency": "NOW" | "TODAY" | "THIS_WEEK" | "NONE",
  "executionPlan": { "tool": string, "args": object } | null
}]

escalation_reason: REQUIRED when action is "queue" — one sentence why JARVIS cannot handle it.
Set reason to the same text when queuing. Omit or null when not queueing.

${JUDGMENT_RULES}`;

export async function evaluateInboundItems(
  context: PerceptionPayload,
  items: Array<{ itemId: string; itemType: "email" | "call" | "text"; content: string }>
): Promise<JudgmentDecision[]> {
  if (!anthropic || !items.length) {
    return items.map((item) => ({
      itemId: item.itemId,
      itemType: item.itemType,
      action: "queue" as const,
      notify: false,
      notifyUrgency: "never" as const,
      reason: "Offline judgment — Claude unavailable; needs review.",
      summary: "Inbound item",
      urgency: "TODAY" as const,
      executionPlan: null
    }));
  }

  const model = await findWorkingModel();
  if (!model) return [];

  const contextBlock = JSON.stringify({
    timeOfDay: context.timeOfDay,
    dayOfWeek: context.dayOfWeek,
    joeLastActive: context.joeLastActive?.toISOString() || null,
    itemsHandledToday: context.itemsHandledToday,
    lastBriefingTime: context.lastBriefingTime?.toISOString() || null,
    currentQueueSize: context.currentQueueSize
  });

  try {
    const response = await claudeCircuit.execute("judgment", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 2000,
          temperature: 0.2,
          system: JUDGMENT_SYSTEM,
          messages: [
            {
              role: "user",
              content: `Context:\n${contextBlock}\n\nItems:\n${JSON.stringify(items).slice(0, 14000)}`
            }
          ]
        }),
        30_000,
        "judgment"
      )
    );

    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock?.text?.trim() || "[]";
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const start = jsonText.indexOf("[");
    const end = jsonText.lastIndexOf("]");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as unknown[];

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        const actionRaw = String(r.action || "execute_now");
        const action =
          actionRaw === "execute_now" || actionRaw === "ignore" || actionRaw === "queue"
            ? actionRaw
            : "execute_now";
        const notifyUrgencyRaw = String(r.notifyUrgency || "never");
        const notifyUrgency =
          notifyUrgencyRaw === "now" || notifyUrgencyRaw === "next_briefing"
            ? notifyUrgencyRaw
            : "never";
        const itemType = String(r.itemType || "email");
        if (itemType !== "email" && itemType !== "call" && itemType !== "text") return null;

        const escalationReason = String(r.escalation_reason || r.escalationReason || "")
          .trim()
          .slice(0, 500);
        const reasonBase = String(r.reason || "").trim().slice(0, 500);
        const reason =
          action === "queue"
            ? escalationReason || reasonBase || "Requires Joe's judgment."
            : reasonBase;

        const decision: JudgmentDecision & { escalation_reason?: string } = {
          itemId: String(r.itemId || ""),
          itemType,
          action,
          notify: Boolean(r.notify),
          notifyUrgency,
          reason,
          summary: String(r.summary || "Item processed.").slice(0, 500),
          urgency: (["NOW", "TODAY", "THIS_WEEK", "NONE"].includes(String(r.urgency || ""))
            ? String(r.urgency)
            : "TODAY") as JudgmentDecision["urgency"],
          executionPlan:
            r.executionPlan && typeof r.executionPlan === "object"
              ? {
                  tool: String((r.executionPlan as Record<string, unknown>).tool || ""),
                  args: ((r.executionPlan as Record<string, unknown>).args || {}) as Record<
                    string,
                    unknown
                  >
                }
              : null
        };
        if (action === "queue") {
          decision.escalation_reason = reason;
        }
        return decision;
      })
      .filter((x): x is JudgmentDecision => x !== null && x.itemId.length > 0);
  } catch (error) {
    logServiceError("Claude", "evaluateInboundItems", error);
    return [];
  }
}

export async function generateAutonomousEmailReply(input: {
  from: string;
  subject: string;
  snippet: string;
  emailType: string;
}) {
  if (!anthropic) {
    return `Thank you for reaching out. We will follow up shortly.\n\nBest,\nJoe Stewart`;
  }

  const model = await findWorkingModel();
  if (!model) return "Thank you. We will follow up shortly.";

  const system = `${await buildDynamicSystemPrompt()}

Write a plain-text email reply body only. No subject line. No JSON. No commentary to Joe.
Never include: "Here's a reply", strategy notes, "Want me to send?", separators (---), or markdown.
Output only what the recipient reads: greeting, message, sign-off (Joe Stewart / Totally Outdoors LLC / 330-231-4080 as appropriate).
Joe runs a successful landscaping business in Ohio. Professional, direct, no fluff.
Match email type: ${input.emailType}`;

  try {
    const response = await claudeCircuit.execute("auto-reply", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 350,
          temperature: 0.35,
          system,
          messages: [
            {
              role: "user",
              content: `From: ${input.from}\nSubject: ${input.subject}\nSnippet: ${input.snippet}`
            }
          ]
        }),
        20_000,
        "auto-reply"
      )
    );
    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.text?.trim() || "Thank you. We will follow up within 24 hours.";
  } catch {
    return "Thank you for your message. We will follow up shortly.";
  }
}

/** Dynamic spoken briefing for page-load / wake-word activation. */
export async function generateActivationBriefingFromContext(
  ctx: ActivationContext,
  baseSystemPrompt: string
): Promise<string> {
  if (!ctx.executions.length && !ctx.pendingQueue.length && !ctx.calls.length) {
    return "All clear sir. What do you need?";
  }

  if (!anthropic) {
    return buildFallbackActivationSpeechFromContext(ctx);
  }

  const model = await findWorkingModel();
  if (!model) return buildFallbackActivationSpeechFromContext(ctx);

  const activationRules = `Activation briefing rules:
- Current Ohio time: ${ctx.ohioTime}
- Time since Joe was last active: ${ctx.elapsedSinceJoeActive}
- Open with a time-aware greeting (${ctx.greeting})
- Lead with what JARVIS has DONE autonomously since Joe was last here (executions list)
- Then surface what is still PENDING and needs Joe's attention (pendingQueue)
- Mention important calls if present
- Be concise — spoken briefing, not a report
- No bullet points. Natural operator cadence.
- Never mention items already briefed (only use the lists provided)
- If nothing meaningful in the lists, say exactly: All clear sir. What do you need?
- Max 4-5 sentences total. Joe is busy.`;

  const userPayload = {
    greeting: ctx.greeting,
    elapsedSinceJoeActive: ctx.elapsedSinceJoeActive,
    autonomousActions: ctx.executions.map((e) => e.summary),
    pendingAttention: ctx.pendingQueue.map((q) => ({
      summary: q.summary,
      action: q.detail
    })),
    callsSinceBriefing: ctx.calls.map((c) => c.summary)
  };

  try {
    const response = await claudeCircuit.execute("activation-briefing", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 280,
          temperature: 0.35,
          system: `${baseSystemPrompt}\n\n${activationRules}\n\n${JARVIS_SPEECH_OUTPUT_RULES}`,
          messages: [
            {
              role: "user",
              content: `Joe Stewart just opened JARVIS or said Hey Jarvis. Deliver the activation briefing.\n\nDATA:\n${JSON.stringify(userPayload, null, 2)}\n\nReturn plain speech only.`
            }
          ]
        }),
        22_000,
        "activation-briefing"
      )
    );
    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.text?.trim() || buildFallbackActivationSpeechFromContext(ctx);
  } catch {
    return buildFallbackActivationSpeechFromContext(ctx);
  }
}

function buildFallbackActivationSpeechFromContext(ctx: ActivationContext): string {
  if (!ctx.executions.length && !ctx.pendingQueue.length && !ctx.calls.length) {
    return "All clear sir. What do you need?";
  }
  const parts: string[] = [`${ctx.greeting}, sir.`];
  if (ctx.executions.length) {
    parts.push(
      `Since you were away: ${ctx.executions
        .slice(0, 3)
        .map((e) => e.summary)
        .join("; ")}.`
    );
  }
  if (ctx.pendingQueue.length) {
    parts.push(
      `${ctx.pendingQueue.length} item${ctx.pendingQueue.length === 1 ? "" : "s"} need your attention sir.`
    );
  } else {
    parts.push("Nothing pending that needs you right now.");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export async function generateActivationBriefing(input: {
  executions: Array<{ summary: string; itemType: string; action: string }>;
  context: PerceptionPayload;
  mode: "activation" | "critical";
}) {
  if (!anthropic) {
    if (!input.executions.length) return "All clear sir. What do you need?";
    return input.executions.map((e) => e.summary).join(" ");
  }

  const model = await findWorkingModel();
  if (!model) return "Standing by, sir.";

  const system = `You are JARVIS. Operator briefing for Joe Stewart.
Rules:
- Short. Confident. No fluff.
- Only items in the list — never invent.
- Do not repeat routine spam/archive actions unless Joe should know.
- mode critical: one urgent line first.
- mode activation: what was handled since away + what needs awareness (not approval).
- If list empty, return exactly: All clear sir. What do you need?

${JARVIS_SPEECH_OUTPUT_RULES}`;

  try {
    const response = await claudeCircuit.execute("activation-briefing", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 400,
          temperature: 0.35,
          system,
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                mode: input.mode,
                timeOfDay: input.context.timeOfDay,
                executions: input.executions
              }).slice(0, 12000)
            }
          ]
        }),
        22_000,
        "activation-briefing"
      )
    );
    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.text?.trim() || "All clear sir. What do you need?";
  } catch {
    return "Standing by, sir.";
  }
}

export async function generateExecutionLogSummary(logs: ExecutionLogEntry[]) {
  if (!anthropic) {
    return logs.map((l) => l.summary).join(" ");
  }

  const model = await findWorkingModel();
  if (!model) {
    return logs.map((l) => l.summary).join(" ");
  }

  try {
    const response = await claudeCircuit.execute("exec-log-summary", () =>
      withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: 350,
          temperature: 0.3,
          system: `Summarize what JARVIS handled today for Joe in 3-6 short sentences. Operator tone. Plain text.

${JARVIS_SPEECH_OUTPUT_RULES}`,
          messages: [
            {
              role: "user",
              content: JSON.stringify(logs).slice(0, 10000)
            }
          ]
        }),
        18_000,
        "exec-log-summary"
      )
    );
    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.text?.trim() || "Handled several items today, sir.";
  } catch {
    return buildExecutionSummarySpeech(logs);
  }
}
