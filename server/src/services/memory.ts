import Anthropic from "@anthropic-ai/sdk";
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LIST,
  normalizeMemoryCategory
} from "../config/memoryCategories";
import { invalidateDynamicPromptCache } from "../config/systemPrompt";
import type { ConversationMessage } from "../db/queries";
import {
  applyMemoryConfidenceDecay,
  countMemoriesByCategory,
  deleteMemoryById,
  enqueueMemoryAuditAction,
  flagMemoryByKey,
  getAllMemoriesGrouped,
  getEpisodesSinceDays,
  getMemoryAuditQueueByIds,
  getMemoryByCategoryKey,
  getNeverRetrievedMemoriesOlderThanDays,
  getRecentConversation,
  getRecentEpisodes,
  getTopRetrievedMemories,
  insertEpisodicMemory,
  insertSelfEvolutionEntry,
  logExecution,
  markMemoryAuditQueueReviewed,
  mergeMemoryKeys,
  saveMemory,
  setSystemState,
  getSystemState,
  upsertEntityProfile
} from "../db/queries";
import { claudeCircuit, CircuitOpenError } from "./circuitBreaker";
import { logServiceWarn } from "../utils/logError";
import { memoryLog } from "../utils/requestLog";
import {
  extractEntitiesFromTurn,
  extractLearnableMemoriesFromTurn,
  findWorkingModel,
  summarizeConversationForEpisodic
} from "./claude";

export { MEMORY_CATEGORIES } from "../config/memoryCategories";

const memoryAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("memory-claude-timeout")), ms)
    )
  ]);
}

type ContradictionResult = {
  contradicts: boolean;
  recommendation: "update" | "keep_existing" | "merge";
  mergedValue?: string;
  reason?: string;
};

type AuditAction = {
  action: "delete" | "merge" | "flag";
  key: string;
  category: string;
  reason: string;
  mergeWith?: string;
};

export async function checkForContradiction(
  category: string,
  key: string,
  newValue: string
): Promise<{ shouldWrite: boolean; valueToWrite: string }> {
  const existing = getMemoryByCategoryKey(category, key);
  if (!existing) {
    return { shouldWrite: true, valueToWrite: newValue };
  }

  if (!memoryAnthropic) {
    return { shouldWrite: true, valueToWrite: newValue };
  }

  try {
    const model = await findWorkingModel();
    if (!model) {
      return { shouldWrite: true, valueToWrite: newValue };
    }

    const response = await claudeCircuit.execute("memory_contradiction", () =>
      withTimeout(
        memoryAnthropic.messages.create({
          model,
          max_tokens: 280,
          temperature: 0.1,
          messages: [
            {
              role: "user",
              content: `Existing memory:
Key: ${key}
Current value: ${existing.value}
Confidence: ${existing.confidence}

Proposed new memory:
New value: ${newValue}

Do these contradict each other?
Return JSON only:
{
  "contradicts": true/false,
  "recommendation": "update" | "keep_existing" | "merge",
  "mergedValue": "if merge — combine both into one clean fact",
  "reason": "one sentence why"
}`
            }
          ]
        }),
        18_000
      )
    );

    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "";
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const parsed = JSON.parse(
      jsonStart >= 0 && jsonEnd >= jsonStart ? text.slice(jsonStart, jsonEnd + 1) : text
    ) as ContradictionResult;

    if (parsed.contradicts && parsed.recommendation === "keep_existing") {
      logExecution({
        type: "memory",
        action: "contradiction.keep_existing",
        item_id: key,
        summary: `Memory contradiction detected — keeping existing: ${key} | existing: ${existing.value} | rejected: ${newValue}`,
        result: "failed"
      });
      return { shouldWrite: false, valueToWrite: newValue };
    }

    if (parsed.contradicts && parsed.recommendation === "merge" && parsed.mergedValue?.trim()) {
      logExecution({
        type: "memory",
        action: "contradiction.merge",
        item_id: key,
        summary: `Memory merged: ${key}`,
        result: "success"
      });
      return { shouldWrite: true, valueToWrite: parsed.mergedValue.trim() };
    }

    return { shouldWrite: true, valueToWrite: newValue };
  } catch (error) {
    logServiceWarn("memory", "checkForContradiction", error);
    return { shouldWrite: true, valueToWrite: newValue };
  }
}

/** Primary write path — contradiction check then persist. */
export async function rememberMemory(input: {
  category: string;
  key: string;
  value: string;
  confidence?: number;
  source?: string | null;
}): Promise<void> {
  const category = normalizeMemoryCategory(input.category);
  const key = input.key.slice(0, 200);
  const value = input.value.slice(0, 8000);
  const { shouldWrite, valueToWrite } = await checkForContradiction(category, key, value);
  if (!shouldWrite) return;

  saveMemory({
    category,
    key,
    value: valueToWrite,
    confidence: input.confidence,
    source: input.source ?? null
  });
  memoryLog(`write: ${category}/${key} (${valueToWrite.length} chars)`);
}

function memorySourceForIntent(intent: string): string {
  if (intent === "world.intel") return "world_intel";
  if (intent === "document.search") return "document";
  return "chat";
}

async function extractAndSaveEntityProfiles(input: {
  userMessage: string;
  jarvisResponse: string;
}) {
  const entities = await extractEntitiesFromTurn(input);
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());

  for (const entity of entities) {
    upsertEntityProfile({
      name: entity.name,
      entityType: entity.entity_type,
      notesAppend: `[${stamp}] ${entity.facts}`
    });
  }
  if (entities.length) {
    invalidateDynamicPromptCache();
  }
}

function slugPreferenceTopic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

async function generatePreferenceKey(correctionText: string): Promise<string> {
  const fallback = `preference_${slugPreferenceTopic(correctionText.slice(0, 80)) || "general"}`;

  if (!memoryAnthropic) return fallback;

  try {
    const model = await findWorkingModel();
    if (!model) return fallback;

    const response = await claudeCircuit.execute("memory_preference_key", () =>
      withTimeout(
        memoryAnthropic.messages.create({
          model,
          max_tokens: 60,
          temperature: 0.1,
          messages: [
            {
              role: "user",
              content: `Joe said: '${correctionText.slice(0, 800)}'
Generate a stable snake_case key for this preference.
Examples: preference_email_tone, preference_reply_speed, preference_client_greeting, preference_invoice_format
Return only the key string.`
            }
          ]
        }),
        12_000
      )
    );

    const raw = response.content.find((b) => b.type === "text")?.text?.trim() || "";
    const key = raw.replace(/['"`]/g, "").split(/\s+/)[0]?.trim() || "";
    if (/^preference_[a-z0-9_]+$/.test(key)) return key.slice(0, 200);
    if (/^[a-z0-9_]+$/.test(key)) return `preference_${key}`.slice(0, 200);
    return fallback;
  } catch {
    return fallback;
  }
}

export async function savePreferenceFromCorrection(correctionText: string): Promise<void> {
  const key = await generatePreferenceKey(correctionText);
  await rememberMemory({
    category: MEMORY_CATEGORIES.OPERATOR_PREFERENCES,
    key,
    value: correctionText.slice(0, 1500),
    confidence: 0.9
  });
  invalidateDynamicPromptCache();
}

export function turnHasMemorySignals(userMessage: string, jarvisResponse: string): boolean {
  const combined = `${userMessage}\n${jarvisResponse}`.toLowerCase();

  if (/\b(client|customer|crew|vendor|supplier)\b/.test(combined) && /\b[A-Z][a-z]{2,}\b/.test(userMessage)) {
    return true;
  }

  if (/\$[\d,]+|\b\d{2,}\s*(%|percent|dollars|sq\s*ft|acres)\b/i.test(combined)) {
    return true;
  }

  if (
    /\b(i like|always|never|make sure|don't|do not|prefer|preference)\b/i.test(userMessage)
  ) {
    return true;
  }

  if (
    /\b(we charge|our policy|joe prefers|the crew|totally outdoors|our standard)\b/i.test(
      combined
    )
  ) {
    return true;
  }

  if (/\b(decided|decision|going with|we'll use|approved|confirmed plan)\b/i.test(combined)) {
    return true;
  }

  return false;
}

export async function extractAndSaveMemory(interaction: {
  userMessage: string;
  jarvisResponse: string;
  intent: string;
  outcome: string;
}) {
  try {
    const source = memorySourceForIntent(interaction.intent);
    const rows = await extractLearnableMemoriesFromTurn(interaction);
    for (const row of rows) {
      let category = normalizeMemoryCategory(row.category);
      let key = row.key;

      if (interaction.intent === "document.search") {
        category = MEMORY_CATEGORIES.DOCUMENT_FACTS;
        if (!key.startsWith("fact_")) {
          const slug = slugPreferenceTopic(interaction.userMessage.slice(0, 60));
          key = `fact_${slug}_${row.key}`.slice(0, 200);
        }
      }

      await rememberMemory({
        category,
        key,
        value: row.value,
        confidence: row.confidence,
        source
      });
    }
    if (rows.length) {
      invalidateDynamicPromptCache();
    }

    await extractAndSaveEntityProfiles({
      userMessage: interaction.userMessage,
      jarvisResponse: interaction.jarvisResponse
    });
  } catch (error) {
    logServiceWarn("memory", "extractAndSaveMemory", error);
  }
}

export async function writeEpisodicMemory(
  sessionId: string,
  history: ConversationMessage[]
) {
  if (history.length < 6) return;

  const turns = history.map((m) => ({ role: m.role, content: m.content }));
  const summary = await summarizeConversationForEpisodic(turns);
  if (!summary) return;

  insertEpisodicMemory({
    sessionId,
    summary: summary.summary,
    keyDecisions: summary.key_decisions,
    peopleMentioned: summary.people_mentioned,
    topics: summary.topics
  });
  invalidateDynamicPromptCache();
  memoryLog(`episodic: session=${sessionId} (${summary.summary.length} chars)`);
}

export function scheduleEpisodicMemoryWrite(
  sessionId: string,
  intent: string,
  toolName?: string | null
) {
  if (intent !== "general.chat" || toolName) return;

  setImmediate(() => {
    void (async () => {
      try {
        const history = getRecentConversation(sessionId, 20);
        if (history.length < 6) return;
        await writeEpisodicMemory(sessionId, history);
      } catch (error) {
        logServiceWarn("memory", "scheduleEpisodicMemoryWrite", error);
      }
    })();
  });
}

export { getRecentEpisodes, searchEpisodes } from "../db/queries";

function slugTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export async function runSelfEvolutionAnalysis(): Promise<void> {
  const counts = countMemoriesByCategory();
  const gaps = counts.filter((c) => c.count < 3);

  for (const gap of gaps) {
    insertSelfEvolutionEntry({
      category: "knowledge_gap",
      observation: `Category "${gap.category}" has only ${gap.count} memor${gap.count === 1 ? "y" : "ies"}.`,
      suggestedImprovement: `Brief Joe on ${gap.category.replace(/_/g, " ")} patterns so JARVIS can anticipate needs.`,
      confidence: 0.75
    });
  }

  const episodes = getEpisodesSinceDays(30, 200);
  const topicCounts = new Map<string, number>();
  for (const ep of episodes) {
    if (!ep.topics) continue;
    try {
      const topics = JSON.parse(ep.topics) as unknown[];
      if (!Array.isArray(topics)) continue;
      for (const t of topics) {
        const topic = String(t).trim().toLowerCase();
        if (!topic) continue;
        topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
      }
    } catch {
      /* ignore */
    }
  }

  for (const [topic, count] of topicCounts) {
    if (count < 3) continue;
    const key = `pattern_${slugTopic(topic)}`;
    insertSelfEvolutionEntry({
      category: "pattern",
      observation: `Topic "${topic}" appeared in ${count} sessions over the last 30 days.`,
      suggestedImprovement: `Track ${topic} proactively in briefings and operator state.`,
      confidence: 0.8
    });
    await rememberMemory({
      category: MEMORY_CATEGORIES.BUSINESS_CONTEXT,
      key,
      value: `Recurring session topic (${count}× in 30 days): ${topic}`,
      confidence: 0.7,
      source: "self_evolution"
    });
  }

  const stale = getNeverRetrievedMemoriesOlderThanDays(30, 30);
  for (const row of stale.slice(0, 15)) {
    insertSelfEvolutionEntry({
      category: "memory",
      observation: `Memory key ${row.key} (${row.category}) has never been retrieved.`,
      suggestedImprovement:
        "May be poorly keyed or irrelevant — review or merge during memory audit.",
      confidence: 0.65
    });
  }

  const topRetrieved = getTopRetrievedMemories(5);
  const totalMemories = counts.reduce((n, c) => n + c.count, 0);
  const recentEpisodes = getRecentEpisodes(1);

  const healthLines = [
    `Total memories: ${totalMemories} across ${counts.length} categories.`,
    `Entity profiles and episodic sessions: ${recentEpisodes.length > 0 ? "active" : "building"}.`,
    `Knowledge gaps (<3 entries): ${gaps.map((g) => g.category).join(", ") || "none"}.`,
    `Top retrieved: ${topRetrieved.map((m) => m.key).join(", ") || "none yet"}.`,
    `Never-retrieved (>30d): ${stale.length} candidates flagged.`
  ];

  insertSelfEvolutionEntry({
    category: "behavior",
    observation: healthLines.join(" "),
    suggestedImprovement:
      gaps.length > 0
        ? `Priority gaps: ${gaps.map((g) => g.category).join(", ")}. Ask Joe to brief those areas.`
        : "Memory coverage is balanced — continue logging patterns from chat and brain cycles.",
    confidence: 0.85
  });

  setSystemState("last_self_evolution_run", new Date().toISOString());
  invalidateDynamicPromptCache();
}

function ohioWeekday(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long"
  }).format(new Date());
}

function daysSinceIso(iso: string | null | undefined): number {
  if (!iso) return 999;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / (24 * 60 * 60 * 1000)) : 999;
}

export function runMemoryMaintenance(): void {
  void (async () => {
    try {
      const { removed } = applyMemoryConfidenceDecay();
      for (const row of removed) {
        logExecution({
          type: "memory",
          action: "decay.auto_remove",
          item_id: row.key,
          summary: `Stale memory auto-removed: ${row.key}`,
          result: "success"
        });
      }

      const lastEvolution = getSystemState("last_self_evolution_run");
      if (daysSinceIso(lastEvolution) >= 7) {
        await runSelfEvolutionAnalysis();
      }

      if (ohioWeekday() === "Sunday") {
        const lastAudit = getSystemState("last_memory_audit_run");
        const today = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).format(new Date());
        if (!lastAudit?.startsWith(today)) {
          await auditMemory();
        }
      }
    } catch (error) {
      logServiceWarn("memory", "runMemoryMaintenance", error);
    }
  })();
}

export async function auditMemory(): Promise<{
  reviewed: number;
  queued: number;
  deleted: number;
  merged: number;
  flagged: number;
}> {
  const grouped = getAllMemoriesGrouped();
  const flat = MEMORY_CATEGORY_LIST.flatMap((cat) => grouped[cat] || []);
  const reviewed = flat.length;

  let queued = 0;

  const batchSize = 50;
  for (let i = 0; i < flat.length; i += batchSize) {
    const batch = flat.slice(i, i + batchSize);
    const actions = await askClaudeMemoryAudit(batch);
    for (const action of actions) {
      const category = normalizeMemoryCategory(action.category);
      const row = getMemoryByCategoryKey(category, action.key);
      if (!row) continue;

      enqueueMemoryAuditAction({
        action: action.action,
        category,
        memoryKey: action.key,
        mergeWithKey: action.mergeWith,
        reason: action.reason
      });
      queued += 1;
    }
  }

  const summary = `Memory audit: ${reviewed} entries reviewed, ${queued} candidates queued for approval (no auto-delete)`;
  logExecution({
    type: "memory",
    action: "audit.summary",
    item_id: null,
    summary,
    result: "success"
  });

  setSystemState("last_memory_audit_run", new Date().toISOString());
  invalidateDynamicPromptCache();

  return { reviewed, queued, deleted: 0, merged: 0, flagged: 0 };
}

export async function approveMemoryAuditActions(ids: number[]): Promise<{
  approved: number;
  deleted: number;
  merged: number;
  flagged: number;
}> {
  const pending = getMemoryAuditQueueByIds(ids);
  let deleted = 0;
  let merged = 0;
  let flagged = 0;

  for (const item of pending) {
    const category = normalizeMemoryCategory(item.category);
    if (item.action === "delete") {
      const row = getMemoryByCategoryKey(category, item.memoryKey);
      if (row) {
        deleteMemoryById(row.id);
        deleted += 1;
        logExecution({
          type: "memory",
          action: "audit.delete.approved",
          item_id: item.memoryKey,
          summary: `Memory audit delete approved: ${item.memoryKey} — ${item.reason || ""}`,
          result: "success"
        });
      }
    } else if (item.action === "merge" && item.mergeWithKey) {
      const keep = getMemoryByCategoryKey(category, item.memoryKey);
      const remove = getMemoryByCategoryKey(category, item.mergeWithKey);
      if (keep && remove) {
        const mergedValue = `${keep.value} ${remove.value}`.trim().slice(0, 8000);
        if (mergeMemoryKeys(category, item.memoryKey, item.mergeWithKey, mergedValue)) {
          merged += 1;
          logExecution({
            type: "memory",
            action: "audit.merge.approved",
            item_id: item.memoryKey,
            summary: `Memory audit merge approved: ${item.mergeWithKey} into ${item.memoryKey}`,
            result: "success"
          });
        }
      }
    } else if (item.action === "flag") {
      if (flagMemoryByKey(category, item.memoryKey, item.reason || "audit")) {
        flagged += 1;
      }
    }
  }

  markMemoryAuditQueueReviewed(
    pending.map((p) => p.id),
    "approved"
  );
  invalidateDynamicPromptCache();

  return { approved: pending.length, deleted, merged, flagged };
}

async function askClaudeMemoryAudit(
  batch: Array<{ category: string; key: string; value: string }>
): Promise<AuditAction[]> {
  if (!memoryAnthropic || !batch.length) return [];

  try {
    const model = await findWorkingModel();
    if (!model) return [];

    const payload = batch.map((m) => ({
      category: m.category,
      key: m.key,
      value: m.value
    }));

    const response = await claudeCircuit.execute("memory_audit", () =>
      withTimeout(
        memoryAnthropic!.messages.create({
        model,
        max_tokens: 1200,
        temperature: 0.15,
        messages: [
          {
            role: "user",
            content: `Review these memory entries for:
1. Duplicate keys covering same topic
2. Contradicting values on same topic
3. Transient facts dressed as permanent (specific dates, specific temperatures, one-time news events)
4. Entries that are too vague to be useful

${JSON.stringify(payload)}

Return JSON array only of actions:
[{
  "action": "delete" | "merge" | "flag",
  "key": "the key",
  "category": "the category",
  "reason": "why",
  "mergeWith": "other key if merge"
}]`
          }
        ]
      }),
        45_000
      )
    );

    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "[]";
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? text.slice(start, end + 1) : text
    ) as unknown[];

    if (!Array.isArray(parsed)) return [];

    const actions: AuditAction[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const action = String(r.action || "");
      const key = String(r.key || "").trim();
      const category = String(r.category || "").trim();
      const reason = String(r.reason || "").trim();
      if (!key || !category || !["delete", "merge", "flag"].includes(action)) continue;
      actions.push({
        action: action as AuditAction["action"],
        key,
        category,
        reason: reason || "audit",
        mergeWith: r.mergeWith ? String(r.mergeWith).trim() : undefined
      });
    }
    return actions;
  } catch (error) {
    if (error instanceof CircuitOpenError) return [];
    logServiceWarn("memory", "audit Claude batch", error);
    return [];
  }
}
