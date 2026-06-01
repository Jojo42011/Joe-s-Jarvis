import { Router } from "express";
import {
  boostMemoryImportance,
  getAggregatedKnowledgeGaps,
  getAllMemoriesGrouped,
  getEvolutionHudStats,
  getMemorySynthesisLogs,
  getMemoryStats,
  getSelfEvolutionInsights,
  getSystemState,
  logExecution,
  resolveSelfEvolutionInsight,
  softDeleteMemoryById,
  updateMemoryById
} from "../db/queries";
import { invalidateDynamicPromptCache } from "../config/systemPrompt";
import { approveMemoryAuditActions, auditMemory } from "../services/memory";
import { getPendingMemoryAuditQueue } from "../db/queries";
import { runDailySynthesis } from "../memory/synthesisEngine";

export const memoryRouter = Router();

function toApiMemory(m: {
  id: number;
  category: string;
  key: string;
  value: string;
  confidence: number;
  importance?: number;
  occurrenceCount: number;
  lastSeen: string;
  flagged: boolean;
  flagReason: string | null;
  retrievalCount?: number;
  lastRetrievedAt?: string | null;
  isSynthesized?: number;
  synthesizedFrom?: string | null;
  source?: string | null;
}) {
  return {
    id: m.id,
    category: m.category,
    key: m.key,
    value: m.value,
    confidence: m.confidence,
    importance: m.importance ?? 0.5,
    occurrence_count: m.occurrenceCount,
    last_seen: m.lastSeen,
    flagged: m.flagged ? 1 : 0,
    flag_reason: m.flagReason,
    retrieval_count: m.retrievalCount ?? 0,
    last_retrieved_at: m.lastRetrievedAt ?? null,
    is_synthesized: m.isSynthesized ?? 0,
    synthesized_from: m.synthesizedFrom ?? null,
    source: m.source ?? null
  };
}

memoryRouter.get("/memory", (_req, res) => {
  const grouped = getAllMemoriesGrouped();
  const categories: Record<string, ReturnType<typeof toApiMemory>[]> = {};

  let totalCount = 0;
  for (const [cat, rows] of Object.entries(grouped)) {
    categories[cat] = rows
      .filter((m) => m.confidence > 0 && m.isSynthesized >= 0)
      .map(toApiMemory);
    totalCount += categories[cat].length;
  }

  res.json({
    categories,
    totalCount,
    lastAudit: getSystemState("last_memory_audit_run"),
    lastSynthesis: getSystemState("last_daily_synthesis_run")
  });
});

memoryRouter.get("/memory/stats", (_req, res) => {
  res.json(getMemoryStats());
});

memoryRouter.get("/memory/synthesis-log", (_req, res) => {
  res.json({ items: getMemorySynthesisLogs(10) });
});

memoryRouter.get("/memory/gaps", (_req, res) => {
  res.json({ gaps: getAggregatedKnowledgeGaps(20) });
});

memoryRouter.post("/memory/synthesize", async (_req, res, next) => {
  try {
    const summary = await runDailySynthesis();
    const logs = getMemorySynthesisLogs(1);
    res.json({ summary, latest: logs[0] || null });
  } catch (error) {
    next(error);
  }
});

memoryRouter.get("/memory/evolution", (_req, res) => {
  const rows = getSelfEvolutionInsights("pending", 10);
  const stats = getEvolutionHudStats();
  res.json({
    insights: rows.map((row) => ({
      id: row.id,
      observation: row.observation,
      suggested_improvement: row.suggested_improvement,
      category: row.category,
      confidence: row.confidence,
      created_at: row.created_at
    })),
    stats
  });
});

memoryRouter.delete("/memory/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid memory id" });
    return;
  }

  const removed = softDeleteMemoryById(id);
  if (!removed) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }

  invalidateDynamicPromptCache();
  logExecution({
    type: "memory",
    action: "manual.soft_delete",
    item_id: String(id),
    summary: `Memory soft-deleted: ${removed.key} (${removed.category})`,
    result: "success"
  });

  res.json({ ok: true, memory: toApiMemory(removed) });
});

memoryRouter.post("/memory/:id/boost", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid memory id" });
    return;
  }

  const updated = boostMemoryImportance(id, 0.9);
  if (!updated) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }

  invalidateDynamicPromptCache();
  logExecution({
    type: "memory",
    action: "manual.boost",
    item_id: String(id),
    summary: `Memory importance boosted: ${updated.key}`,
    result: "success"
  });

  res.json({ memory: toApiMemory(updated) });
});

memoryRouter.patch("/memory/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid memory id" });
    return;
  }

  const body = req.body as {
    value?: string;
    confidence?: number;
    importance?: number;
    flagged?: boolean | number;
  };

  const existing = updateMemoryById(id, {
    value: typeof body.value === "string" ? body.value : undefined,
    confidence: typeof body.confidence === "number" ? body.confidence : undefined,
    importance: typeof body.importance === "number" ? body.importance : undefined,
    flagged:
      body.flagged === 0 || body.flagged === false
        ? false
        : body.flagged === 1 || body.flagged === true
          ? true
          : undefined,
    flagReason: body.flagged === 0 || body.flagged === false ? null : undefined
  });

  if (!existing) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }

  invalidateDynamicPromptCache();
  logExecution({
    type: "memory",
    action: "manual.edit",
    item_id: String(id),
    summary: `Memory manually edited: ${existing.key}`,
    result: "success"
  });

  res.json({ memory: toApiMemory(existing) });
});

memoryRouter.get("/memory/audit-queue", (_req, res) => {
  res.json({ items: getPendingMemoryAuditQueue() });
});

memoryRouter.post("/memory/audit", async (_req, res, next) => {
  try {
    const summary = await auditMemory();
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

memoryRouter.post("/memory/audit-approve", async (req, res, next) => {
  try {
    const body = req.body as {
      ids?: number[];
      id?: number;
      status?: string;
    };

    if (body.status === "approved" || body.status === "rejected") {
      const id = Number(body.id ?? body.ids?.[0]);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: "id required with status" });
        return;
      }
      const ok = resolveSelfEvolutionInsight(id, body.status);
      if (!ok) {
        res.status(404).json({ error: "Insight not found or already resolved" });
        return;
      }
      invalidateDynamicPromptCache();
      logExecution({
        type: "memory",
        action: `evolution.${body.status}`,
        item_id: String(id),
        summary: `Self-evolution insight ${body.status}: #${id}`,
        result: "success"
      });
      res.json({ ok: true, id, status: body.status });
      return;
    }

    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    if (!ids.length) {
      res.status(400).json({ error: "ids array required" });
      return;
    }
    const result = await approveMemoryAuditActions(ids);
    res.json(result);
  } catch (error) {
    next(error);
  }
});
