import Anthropic from "@anthropic-ai/sdk";
import { evaluateInboundItems, findWorkingModel } from "../services/claude";
import { invalidateDynamicPromptCache } from "../config/systemPrompt";
import { logExecution, setSystemState } from "../db/queries";
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
        confidence: 0.85
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



export class Judgment {

  async evaluate(payload: PerceptionPayload): Promise<JudgmentDecision[]> {

    const items: Array<{ itemId: string; itemType: "email" | "call" | "text"; content: string }> = [];



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



    if (!items.length) return [];



    return evaluateInboundItems(payload, items);

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

    for (const row of judged) {
      const relevance = row.relevance;
      const summary = row.one_line_summary.slice(0, 500);
      updateWorldIntelJudgment(row.id, relevance, summary);
      if (relevance === "HIGH") {
        highSummaries.push(summary);
        const source =
          pending.find((p) => p.id === row.id) || getWorldIntelById(row.id);
        highForMemory.push({
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


