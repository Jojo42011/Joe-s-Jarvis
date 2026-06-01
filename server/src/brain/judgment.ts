import Anthropic from "@anthropic-ai/sdk";
import { evaluateInboundItems, findWorkingModel } from "../services/claude";
import { invalidateDynamicPromptCache } from "../config/systemPrompt";
import {
  getStaleQueueItemsForRetriage,
  getQueueMaintenanceCandidates,
  hasSuccessfulExecutionForItem,
  markQueueItemHandledWithNote,
  escalateQueueItem,
  isWorldIntelReferencedInConversation,
  logExecution,
  setSystemState,
  type PriorityQueueItem
} from "../db/queries";
import { MEMORY_CATEGORIES } from "../config/memoryCategories";
import { rememberMemory } from "../services/memory";
import {
  getHighUnbriefedWorldIntel,
  getWorldIntelById,
  getWorldIntelPendingJudgment,
  updateWorldIntelJudgment,
  type WorldIntelRelevance,
  type WorldIntelRow
} from "./worldIntelStore";
import type { JudgmentDecision, PerceptionPayload } from "./types";
import { claudeCircuit } from "../services/circuitBreaker";
import { isNotificationSender, resolveReplyRecipient, hasReadableInboundEmailContent } from "../services/gmail";

/** Append to any Claude prompt that produces text Joe may hear (TTS / speech field). */
export const JARVIS_SPEECH_OUTPUT_RULES = `The speech field must always be natural spoken English only.
Never include JSON, brackets, code, markdown, technical strings, null values, or system artifacts in speech.
If you have nothing meaningful to say, return: One moment, sir.`;

const worldIntelAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

/** Appended to senseWorld() query-generation prompt in perception.ts */
export const WORLD_INTEL_SENSE_QUERY_DOMAIN_GUIDANCE = `

When generating search queries, think across all 7 domains you are responsible for:
1. Weather & field conditions (Ohio)
2. Materials & supply chain
3. Local Ohio business environment
4. US & world events
5. Landscaping & hardscaping industry
6. FAA & drone regulations
7. Crew & labor conditions

For each domain ask: is there anything happening right now I should know about for Joe's business?

Generate queries that span multiple domains when the day warrants it. On slow news days, fewer queries. On high-signal days (tariffs announced, storm coming, regulation change), more queries across affected domains.

Always check: what do I already know from jarvis_memory in this domain before searching — don't re-search things I already have durable knowledge about unless something may have changed.`;

const WORLD_INTEL_JUDGE_SYSTEM = `Review these search results from JARVIS world intelligence. For each item decide:

HIGH — Joe needs to know this. It directly affects his business, crew safety, material costs, active jobs, or requires a decision or action.

MEDIUM — Interesting context Joe might want. Not urgent. No action needed today.

LOW — Noise. Not relevant to Joe or his business.

Return JSON array only: [{ "id": number, "relevance": "HIGH"|"MEDIUM"|"LOW", "one_line_summary": string }]`;

const MAX_MEMORY_PROMOTIONS_PER_CYCLE = 3;
const QUEUE_MAINTENANCE_LIMIT = 10;
const QUEUE_MAINTENANCE_MIN_AGE_HOURS = 1;
const QUEUE_ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;
const QUEUE_AUTO_CLOSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const MEMORY_PROMOTION_SYSTEM = `You are JARVIS, chief of staff to Joe Stewart, owner of Totally Outdoors LLC, a multimillion dollar landscaping business in Holmes County Ohio.

You just discovered intelligence worth flagging as HIGH priority.

Decide: is this worth remembering permanently about Joe's business environment, operating conditions, or strategic context?

Ask yourself:
- Would knowing this change how JARVIS advises Joe in future conversations?
- Does this reveal something durable about risks, costs, conditions, or patterns affecting his business?
- Or is this a one-time news item that expires in 48h?

If worth remembering permanently: return a clean one or two sentence memory in this format:
{
  "remember": true,
  "key": "short_snake_case_key",
  "value": "Clean durable fact JARVIS should carry forward."
}

If not worth remembering:
{ "remember": false }

Return only JSON. Nothing else.`;

type MemoryPromotionDecision =
  | { remember: true; key: string; value: string }
  | { remember: false };

function parseMemoryPromotionJson(raw: string): MemoryPromotionDecision | null {
  try {
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.remember) return { remember: false };
    const key = String(parsed.key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 200);
    const value = String(parsed.value || "").trim().slice(0, 8000);
    if (!key || !value) return null;
    return { remember: true, key, value };
  } catch {
    return null;
  }
}

async function askClaudeMemoryPromotion(
  query: string,
  summary: string
): Promise<MemoryPromotionDecision | null> {
  if (!worldIntelAnthropic) return null;
  const model = await findWorkingModel();
  if (!model) return null;

  try {
    const response = await claudeCircuit.execute("world-intel-memory-promotion", () =>
      worldIntelAnthropic.messages.create({
        model,
        max_tokens: 400,
        temperature: 0.2,
        system: MEMORY_PROMOTION_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Query: ${query}\nSummary: ${summary}`
          }
        ]
      })
    );
    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.text?.trim() || "";
    return parseMemoryPromotionJson(raw);
  } catch (error) {
    console.warn("[world-intel] memory promotion Claude call failed:", error);
    return null;
  }
}

/** Promote MEDIUM world intel referenced in conversation (max 2 per cycle). */
export async function promoteReferencedMediumWorldIntel(
  items: Array<{ id: number; query: string; summary: string }>
): Promise<void> {
  if (!items.length) return;

  let writes = 0;
  for (const item of items) {
    if (writes >= 2) break;
    if (!isWorldIntelReferencedInConversation(item.query)) continue;

    try {
      const slug = item.query
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
      await rememberMemory({
        category: MEMORY_CATEGORIES.WORLD_INTEL,
        key: `world_${slug || item.id}`,
        value: item.summary.slice(0, 2000),
        confidence: 0.65,
        source: "world_intel"
      });
      logExecution({
        type: "world_intel",
        action: "memory.promote.medium",
        item_id: String(item.id),
        summary: `Medium world intel promoted (referenced): ${item.query}`,
        result: "success"
      });
      writes += 1;
      invalidateDynamicPromptCache();
    } catch (error) {
      console.warn("[world-intel] promoteReferencedMediumWorldIntel skipped:", item.id, error);
    }
  }
}

/** Promote durable HIGH world intel into jarvis_memory (max 3 per cycle). */
export async function promoteWorldIntelToMemory(
  items: Array<{ id: number; query: string; summary: string }>
): Promise<void> {
  if (!items.length) return;

  let writes = 0;

  for (const item of items) {
    if (writes >= MAX_MEMORY_PROMOTIONS_PER_CYCLE) break;

    try {
      const decision = await askClaudeMemoryPromotion(item.query, item.summary);
      if (!decision || !decision.remember) continue;

      await rememberMemory({
        category: MEMORY_CATEGORIES.WORLD_INTEL,
        key: decision.key,
        value: decision.value,
        confidence: 0.85,
        source: "world_intel"
      });

      logExecution({
        type: "world_intel",
        action: "memory.promote",
        item_id: String(item.id),
        summary: `World intel promoted to memory: ${decision.key}`,
        result: "success"
      });

      writes += 1;
      invalidateDynamicPromptCache();
    } catch (error) {
      console.warn("[world-intel] promoteWorldIntelToMemory skipped item:", item.id, error);
    }
  }
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const THIRTY_MIN_MS = 30 * 60 * 1000;



/** Judgment rules for inbound triage — default is execute_now; queue is the exception. */

export const JUDGMENT_RULES = `

THE DEFAULT IS EXECUTE_NOW.

If an item does not clearly fall into the queue list below, JARVIS handles it autonomously.

Queue is the exception, not the rule.



Use Totally Outdoors business knowledge: Holmes County and surrounding Ohio,

330-231-4080, totallyoutdoors@gmail.com, services (lawn care, landscaping, hardscaping,

excavation, snow, ponds, patios, etc.), no fixed public pricing — custom quote after consultation.



NEW RULES FOR execute_now (JARVIS handles autonomously, no Joe needed):

- New lead or inquiry → draft_and_send a professional reply, acknowledge their interest,

  explain our process (initial consultation), invite them to call 330-231-4080 or reply to schedule

- Service question (do you offer X, what areas do you serve, how does pricing work) →

  draft_and_send a clear accurate answer using the business knowledge above

- Existing client follow-up or status question → draft_and_send a professional acknowledgment,

  let them know Joe will follow up with specifics

- Vendor or supplier email → draft_and_send brief acknowledgment

- Spam, solicitation, irrelevant → archive immediately, no reply (tool "archive")

- General outreach or unclear intent → draft_and_send a warm professional reply asking how we can help

NOTIFICATION / CRM RELAY EMAILS (JobTread, noreply, notifications, mailer):

- If From contains jobtread, noreply, no-reply, notifications, or mailer → the real sender is IN THE BODY, not the From header
- Never reply to the notification address — extract the client's email from the body
- If you cannot identify a real human sender email in the content → action MUST be "queue" (not execute_now), with escalation_reason explaining the relay could not be parsed
- Do not auto-reply to JobTread API notification addresses



For execute_now emails, executionPlan must be set:

- draft_and_send: { "tool": "draft_and_send", "args": { "messageId", "threadId", "from", "subject", "snippet", "emailType" } }

  Use messageId from item content (strip gmail: prefix if present). emailType: lead | service_question | client | vendor | general

- archive: { "tool": "archive", "args": { "messageId" } }



NEW RULES FOR queue (escalate to Joe — JARVIS cannot handle):

- Email requires Joe's specific schedule or availability (booking a specific date/time for a job)

- Email contains a complaint requiring Joe's personal response

- Email is from a known priority contact requiring Joe directly

- Email contains legal, financial, or contract specifics that need Joe's decision

- Email is truly ambiguous with no reasonable response possible



When action is "queue", you MUST include escalation_reason: one sentence explaining exactly

why JARVIS could not handle it (this is what Joe sees). Also set reason to the same text.



Rules for notify true:

- Only genuinely new urgent info Joe does not already have

- Not routine handling Joe expects automated

- notifyUrgency "now" only for true interrupts



Rules for ignore:

- Obvious spam already handled, duplicates, noise (prefer archive via execute_now for new spam)

`;



const STALE_RETRIAGE_LIMIT = 5;
const STALE_QUEUE_AGE_MINUTES = 30;

function queueItemToInboundItem(
  q: PriorityQueueItem
): { itemId: string; itemType: "email" | "call" | "text"; content: string } | null {
  const itemType =
    q.type === "email" || q.type === "call" || q.type === "text" ? q.type : null;
  if (!itemType) return null;

  const itemId = q.sourceId || `queue:${q.id}`;
  let content = JSON.stringify({
    summary: q.summary,
    actionNeeded: q.actionNeeded,
    urgency: q.urgency,
    queuedAt: q.timestamp
  });

  if (q.rawData) {
    try {
      const parsed = JSON.parse(q.rawData) as Record<string, unknown>;
      if (parsed.judgment) {
        content = JSON.stringify(parsed.judgment);
      } else {
        content = JSON.stringify(parsed);
      }
    } catch {
      /* keep default content */
    }
  }

  return { itemId, itemType, content };
}

const REPLY_TOOLS = new Set(["draft_and_send", "send_reply", "email.send_reply"]);
const EMPTY_BODY_QUEUE_NOTE = "Email body empty — needs Joe's review";

function queueEmailDecision(
  decision: JudgmentDecision,
  reason: string
): JudgmentDecision {
  return {
    ...decision,
    action: "queue",
    notify: true,
    notifyUrgency: "next_briefing",
    reason,
    summary: reason,
    executionPlan: null,
    urgency: "TODAY"
  };
}

function parseEmailFromItemContent(content: string): {
  id?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  snippet?: string;
} | null {
  try {
    return JSON.parse(content) as {
      id?: string;
      threadId?: string;
      from?: string;
      subject?: string;
      snippet?: string;
    };
  } catch {
    return null;
  }
}

async function applyNotificationEmailRouting(
  decisions: JudgmentDecision[],
  items: Array<{ itemId: string; itemType: string; content: string }>
): Promise<JudgmentDecision[]> {
  const contentById = new Map(items.map((i) => [i.itemId, i.content]));
  const routed: JudgmentDecision[] = [];

  for (const decision of decisions) {
    if (decision.itemType !== "email" || decision.action !== "execute_now" || !decision.executionPlan) {
      routed.push(decision);
      continue;
    }

    const tool = decision.executionPlan.tool;
    if (!REPLY_TOOLS.has(tool)) {
      routed.push(decision);
      continue;
    }

    const args = decision.executionPlan.args || {};
    const emailMeta = parseEmailFromItemContent(contentById.get(decision.itemId) || "");
    const fromHeader = String(args.from || emailMeta?.from || "");
    const messageId = String(args.messageId || emailMeta?.id || decision.itemId).replace(/^gmail:/, "");
    const snippet = String(args.snippet || emailMeta?.snippet || "");

    if (!fromHeader || !isNotificationSender(fromHeader)) {
      routed.push(decision);
      continue;
    }

    const resolved = await resolveReplyRecipient({
      fromHeader,
      messageId,
      snippet
    });

    if (!resolved.to) {
      const reason =
        "JobTread/notification relay email — could not extract real sender from body; queued for Joe.";
      routed.push(queueEmailDecision(decision, reason));
      continue;
    }

    routed.push({
      ...decision,
      executionPlan: {
        ...decision.executionPlan,
        args: {
          ...args,
          from: resolved.to,
          messageId,
          threadId: args.threadId || emailMeta?.threadId,
          snippet,
          originalFrom: fromHeader
        }
      },
      reason: `${decision.reason} Reply routed to real sender ${resolved.to} (not notification address).`
    });
  }

  return routed;
}

async function applyEmptyEmailBodyGuard(
  decisions: JudgmentDecision[],
  items: Array<{ itemId: string; itemType: string; content: string }>
): Promise<JudgmentDecision[]> {
  const contentById = new Map(items.map((i) => [i.itemId, i.content]));
  const guarded: JudgmentDecision[] = [];

  for (const decision of decisions) {
    if (decision.itemType !== "email" || decision.action !== "execute_now" || !decision.executionPlan) {
      guarded.push(decision);
      continue;
    }

    if (!REPLY_TOOLS.has(decision.executionPlan.tool)) {
      guarded.push(decision);
      continue;
    }

    const args = decision.executionPlan.args || {};
    const emailMeta = parseEmailFromItemContent(contentById.get(decision.itemId) || "");
    const messageId = String(args.messageId || emailMeta?.id || decision.itemId).replace(/^gmail:/, "");
    const snippet = String(args.snippet || emailMeta?.snippet || "");
    const subject = String(args.subject || emailMeta?.subject || "");

    const readable = await hasReadableInboundEmailContent({ messageId, snippet, subject });
    if (!readable) {
      guarded.push(queueEmailDecision(decision, EMPTY_BODY_QUEUE_NOTE));
      continue;
    }

    guarded.push(decision);
  }

  return guarded;
}

export class Judgment {

  /** Drain stale queue backlog — auto-close, escalate, or mark handled from execution_log. */
  maintainQueueBacklog(): void {
    const candidates = getQueueMaintenanceCandidates(
      QUEUE_MAINTENANCE_LIMIT,
      QUEUE_MAINTENANCE_MIN_AGE_HOURS
    );
    const now = Date.now();

    for (const item of candidates) {
      const created = new Date(item.timestamp);
      const ageMs = Number.isNaN(created.getTime()) ? 0 : now - created.getTime();

      if (item.sourceId && hasSuccessfulExecutionForItem(item.sourceId)) {
        markQueueItemHandledWithNote(
          item.id,
          "Auto-closed — completed action found in execution_log"
        );
        logExecution({
          type: "system",
          action: "queue.maintenance",
          item_id: item.sourceId,
          summary: `Queue #${item.id} auto-handled — execution_log match`,
          result: "success"
        });
        continue;
      }

      if (ageMs >= QUEUE_AUTO_CLOSE_AFTER_MS) {
        markQueueItemHandledWithNote(item.id, "Auto-closed after 7 days");
        logExecution({
          type: "system",
          action: "queue.maintenance",
          item_id: item.sourceId || String(item.id),
          summary: `Queue #${item.id} auto-closed after 7 days`,
          result: "success"
        });
        continue;
      }

      if (ageMs >= QUEUE_ESCALATE_AFTER_MS && item.urgency !== "NOW") {
        escalateQueueItem(item.id, "NOW", "Unresolved 24h — needs Joe's attention");
        logExecution({
          type: "system",
          action: "queue.escalate",
          item_id: item.sourceId || String(item.id),
          summary: `Queue #${item.id} escalated — unresolved 24h`,
          result: "success"
        });
      }
    }
  }

  async evaluate(payload: PerceptionPayload): Promise<JudgmentDecision[]> {
    this.maintainQueueBacklog();

    const items: Array<{ itemId: string; itemType: "email" | "call" | "text"; content: string }> = [];
    const staleMeta = new Map<string, number>();

    for (const email of payload.newEmails) {

      items.push({

        itemId: `gmail:${email.id}`,

        itemType: "email",

        content: JSON.stringify(email)

      });

    }

    for (const call of payload.newCalls) {

      items.push({

        itemId: `call:${call.id}`,

        itemType: "call",

        content: JSON.stringify(call)

      });

    }

    for (const text of payload.newTexts) {

      items.push({

        itemId: `text:${text.id}`,

        itemType: "text",

        content: JSON.stringify(text)

      });

    }

    const seenItemIds = new Set(items.map((i) => i.itemId));

    for (const q of getStaleQueueItemsForRetriage(STALE_RETRIAGE_LIMIT, STALE_QUEUE_AGE_MINUTES)) {
      const inbound = queueItemToInboundItem(q);
      if (!inbound || seenItemIds.has(inbound.itemId)) continue;
      items.push(inbound);
      staleMeta.set(inbound.itemId, q.id);
      seenItemIds.add(inbound.itemId);
    }

    if (!items.length) return [];

    const decisions = await evaluateInboundItems(payload, items);

    const mapped = decisions.map((d) => {
      const sourceQueueId = staleMeta.get(d.itemId);
      return sourceQueueId ? { ...d, sourceQueueId } : d;
    });

    return applyEmptyEmailBodyGuard(await applyNotificationEmailRouting(mapped, items), items);
  }

  async judgeWorldIntel(onlyIds?: number[]): Promise<void> {
    let pending = getWorldIntelPendingJudgment(50);
    if (onlyIds?.length) {
      const idSet = new Set(onlyIds);
      pending = pending.filter((r) => idSet.has(r.id));
    }
    if (!pending.length) return;

    const judged = await this.runWorldIntelJudgmentClaude(pending);
    const highSummaries: string[] = [];
    const highForMemory: Array<{ id: number; query: string; summary: string }> = [];
    const mediumForMemory: Array<{ id: number; query: string; summary: string }> = [];

    for (const row of judged) {
      const relevance = row.relevance;
      const summary = row.one_line_summary.slice(0, 500);
      updateWorldIntelJudgment(row.id, relevance, summary);
      const source =
        pending.find((p) => p.id === row.id) || getWorldIntelById(row.id);
      if (relevance === "HIGH") {
        highSummaries.push(summary);
        highForMemory.push({
          id: row.id,
          query: source?.query || "",
          summary
        });
      } else if (relevance === "MEDIUM") {
        mediumForMemory.push({
          id: row.id,
          query: source?.query || "",
          summary
        });
      }
    }

    if (highSummaries.length) {
      setSystemState(
        "world_intel_alert",
        JSON.stringify({
          hasAlert: true,
          summaries: highSummaries,
          updatedAt: new Date().toISOString()
        })
      );
    }

    try {
      await promoteWorldIntelToMemory(highForMemory);
      await promoteReferencedMediumWorldIntel(mediumForMemory);
    } catch (error) {
      console.warn("[world-intel] promoteWorldIntelToMemory failed:", error);
    }
  }

  private async runWorldIntelJudgmentClaude(
    rows: WorldIntelRow[]
  ): Promise<Array<{ id: number; relevance: WorldIntelRelevance; one_line_summary: string }>> {
    if (!worldIntelAnthropic) return [];

    const model = await findWorkingModel();
    if (!model) return [];

    const payload = rows.map((r) => {
      let results: unknown = null;
      if (r.resultsJson) {
        try {
          results = JSON.parse(r.resultsJson);
        } catch {
          results = r.resultsJson;
        }
      }
      return { id: r.id, query: r.query, results };
    });

    try {
      const response = await claudeCircuit.execute("world-intel-judgment", () =>
        worldIntelAnthropic.messages.create({
          model,
          max_tokens: 2000,
          temperature: 0.2,
          system: WORLD_INTEL_JUDGE_SYSTEM,
          messages: [
            {
              role: "user",
              content: `Items to judge:\n${JSON.stringify(payload).slice(0, 14000)}`
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
      ) as unknown[];

      if (!Array.isArray(parsed)) return [];

      return parsed
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const r = row as Record<string, unknown>;
          const id = Number(r.id);
          const rel = String(r.relevance || "").toUpperCase();
          if (!Number.isFinite(id) || id <= 0) return null;
          if (rel !== "HIGH" && rel !== "MEDIUM" && rel !== "LOW") return null;
          return {
            id,
            relevance: rel as WorldIntelRelevance,
            one_line_summary: String(r.one_line_summary || r.summary || "").trim()
          };
        })
        .filter(
          (x): x is { id: number; relevance: WorldIntelRelevance; one_line_summary: string } =>
            x !== null && x.one_line_summary.length > 0
        );
    } catch (error) {
      console.warn("[world-intel] judgeWorldIntel Claude failed:", error);
      return [];
    }
  }

  shouldBrief(context: PerceptionPayload, options?: { explicitRequest?: boolean }): boolean {

    if (options?.explicitRequest) return true;

    if (context.criticalAlertActive) return true;

    if (!context.lastBriefingTime) return context.currentQueueSize > 0 || context.itemsHandledToday > 0;



    const sinceBriefing = Date.now() - context.lastBriefingTime.getTime();

    if (sinceBriefing < TWO_HOURS_MS && !context.criticalAlertActive) {

      return false;

    }



    return context.currentQueueSize > 0;

  }



  shouldSpeak(

    decision: JudgmentDecision,

    context: PerceptionPayload,

    lastSpokeAt: Date | null

  ): boolean {

    if (!decision.notify || decision.notifyUrgency !== "now") return false;

    if (!context.joeLastActive) return decision.notifyUrgency === "now";



    const activeWithin4h = Date.now() - context.joeLastActive.getTime() < 4 * 60 * 60 * 1000;

    if (!activeWithin4h) return false;



    if (lastSpokeAt) {

      const sinceSpoke = Date.now() - lastSpokeAt.getTime();

      const critical = decision.urgency === "NOW";

      if (sinceSpoke < 10 * 60 * 1000 && !critical) return false;

    }



    return true;

  }



  shouldBriefOnActivation(context: PerceptionPayload, handledSinceLastActive: number): boolean {
    if (getHighUnbriefedWorldIntel().length > 0) return true;

    if (context.criticalAlertActive) return true;

    if (handledSinceLastActive > 0) return true;



    if (!context.joeLastActive) return false;

    const awayMs = Date.now() - context.joeLastActive.getTime();

    if (awayMs < THIRTY_MIN_MS) return false;



    if (!context.lastBriefingTime) return handledSinceLastActive > 0 || context.currentQueueSize > 0;



    const sinceBriefing = Date.now() - context.lastBriefingTime.getTime();

    if (sinceBriefing < TWO_HOURS_MS) return handledSinceLastActive > 0;



    return context.currentQueueSize > 0;

  }

}


