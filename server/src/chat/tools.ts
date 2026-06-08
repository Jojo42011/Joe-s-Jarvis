import type Anthropic from "@anthropic-ai/sdk";
import { MEMORY_CATEGORY_LIST } from "../config/memoryCategories";
import {
  getAggregatedKnowledgeGaps,
  getAllEntityProfiles,
  getAllMemoriesGrouped,
  getExecutionLogToday,
  getLatestSynthesizedPerCategory,
  getMemoryStats,
  getMemorySynthesisLogs,
  getNotesCount,
  getQueue,
  getQueueItemById,
  getRecentCalls,
  getRecentEpisodes,
  getRecentNotes,
  getSelfEvolutionRecent,
  getSystemState,
  logExecution,
  saveMemory,
  searchEntityProfiles,
  searchEpisodes,
  searchMemoriesSql,
  searchNotesForTool,
  type EntityProfile,
  type JarvisMemory,
  type Note
} from "../db/queries";
import { buildRundownResponse } from "../routes/rundown";
import { searchDocuments } from "../services/documentIntelligence";
import { getEmailDetail, getRecentGmailMessages, sendGmailReply } from "../services/gmail";
import { createCalendarEvent, enforceBusinessHours } from "../services/googleCalendar";
import { searchWeb } from "../services/braveSearch";
import { searchWeather } from "../services/braveSearch";
import { buildWeatherPanel } from "../routes/chat/liveData";
import {
  findQueueItemByDescription,
  getActionListPayload,
  getQueueStatusPayload,
  markQueueItemHandled,
  snoozeQueueItem
} from "../brain/queueEscalation";
import { createNoteFromInput } from "../services/notes";
import { humanizeLogSummary } from "../utils/executionSummary";
import { getWorldIntelSinceHours } from "../brain/worldIntelStore";

export type ToolExecutionResult = Record<string, unknown>;

export const CHAT_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "search_web",
    description:
      "Search the internet. Only call when Joe explicitly asks about something external — news, prices, weather, research. Do NOT call for general conversation, questions about his business, or anything JARVIS already knows. Never call proactively.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        context: { type: "string", description: "Optional extra context" }
      },
      required: ["query"]
    }
  },
  {
    name: "read_emails",
    description:
      "Read Joe's recent emails from Gmail. Only call when Joe explicitly asks about his emails, inbox, or a specific message. Do NOT call for general 'what's going on' questions — use get_queue instead.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        filter: { type: "string" },
        unread_only: { type: "boolean" }
      }
    }
  },
  {
    name: "get_email_body",
    description:
      "Get the full body and attachments of a specific email. Use when Joe asks to read, open, or see the full content of an email.",
    input_schema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "Gmail message id" }
      },
      required: ["email_id"]
    }
  },
  {
    name: "send_email",
    description: "Send an email on Joe's behalf immediately.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        thread_id: { type: "string" }
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "get_calls",
    description: "Get recent call history and voicemails.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number" } }
    }
  },
  {
    name: "get_queue",
    description:
      "Get priority queue status: needs_attention (due now), being_monitored (briefed, resurfacing later), and total_open count.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "get_action_list",
    description:
      "Pull up Joe's action list — everything that needs attention, being monitored, and handled today. Use when Joe asks about his list, tasks, or to-dos.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "dismiss_queue_item",
    description:
      "Mark a queue item as handled when Joe says it is taken care of, done, or resolved.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "number" },
        description: { type: "string", description: "Match by summary text if id unknown" }
      }
    }
  },
  {
    name: "snooze_queue_item",
    description: "Snooze a queue item when Joe wants to deal with it later.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "number" },
        hours: { type: "number", description: "Hours until resurface" }
      },
      required: ["item_id", "hours"]
    }
  },
  {
    name: "book_calendar",
    description:
      "Book an appointment on Joe's calendar. Business hours 8:45am-5pm Mon-Fri Ohio time only.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:mm optional" },
        duration_minutes: { type: "number" },
        notes: { type: "string" }
      },
      required: ["title", "date"]
    }
  },
  {
    name: "save_note",
    description:
      "Save a note Joe wants remembered. Strip trigger phrases — save only the content.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"]
    }
  },
  {
    name: "get_notes",
    description:
      "Retrieve Joe's saved notes. Omit query to list the latest 20 notes. With query, search content and linked entities.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search text" },
        limit: { type: "number" }
      }
    }
  },
  {
    name: "save_memory",
    description: "Save something important to long-term memory permanently.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string" },
        key: { type: "string" },
        value: { type: "string" }
      },
      required: ["category", "key", "value"]
    }
  },
  {
    name: "get_memory",
    description:
      "Search JARVIS memory for specific knowledge about a named person, company, or topic. Only call when Joe asks what you know about a SPECIFIC named entity — not for general conversation or questions you can answer from context. Example: 'what do you know about Reynolds' or 'tell me about Acme Supply'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" }
      },
      required: ["query"]
    }
  },
  {
    name: "get_intel",
    description:
      "Get recent research on a specific industry topic. Only call when Joe asks about industry news, equipment prices, market trends, or Ohio regulations — not for general questions you can answer directly.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Research topic or domain" }
      },
      required: ["topic"]
    }
  },
  {
    name: "open_panel",
    description:
      "Open a visual panel on Joe's screen. Only call when Joe explicitly says 'show me', 'pull up', 'open', or 'display' something. Do NOT call just because you fetched data — only when Joe wants to SEE it on screen. panel parameter: emails | calls | queue | notes | weather | documents | memory | action-list | rundown",
    input_schema: {
      type: "object",
      properties: {
        panel: { type: "string", description: "Panel to open" }
      },
      required: ["panel"]
    }
  },
  {
    name: "get_full_picture",
    description:
      "Get JARVIS's complete self-knowledge picture — all memory categories, entity profiles, recent synthesis insights, knowledge gaps, and self-evolution log. Use when Joe asks what JARVIS knows or has learned.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional category filter (e.g. client_relations, business_context)"
        }
      }
    }
  },
  {
    name: "get_entity",
    description:
      "Look up everything JARVIS knows about a specific person, company, or job. Use when Joe asks about a named client, crew member, or vendor.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person or company name" }
      },
      required: ["name"]
    }
  },
  {
    name: "get_weather",
    description: "Get current weather and job site conditions for Ohio.",
    input_schema: {
      type: "object",
      properties: { location: { type: "string" } }
    }
  },
  {
    name: "search_documents",
    description: "Search uploaded documents Joe has shared with JARVIS.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    }
  },
  {
    name: "get_execution_log",
    description:
      "Get what JARVIS has done autonomously today. Only call when Joe explicitly asks what you have done, your actions, or your activity. Not for general status questions.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number" } }
    },
    cache_control: { type: "ephemeral" }
  } as Anthropic.Tool
];

function formatOhioFriendly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function mapMemoryForTool(m: JarvisMemory) {
  return {
    id: m.id,
    category: m.category,
    key: m.key,
    value: m.value.slice(0, 800),
    confidence: m.confidence,
    importance: m.importance,
    is_synthesized: m.isSynthesized === 1,
    retrieval_count: m.retrievalCount,
    source: m.source
  };
}

function mapEntityForTool(p: EntityProfile) {
  return {
    name: p.name,
    entity_type: p.entityType,
    phone: p.phone,
    email: p.email,
    relationship_summary: p.relationshipSummary,
    trust_level: p.trustLevel,
    interaction_count: p.interactionCount,
    notes: p.notes?.slice(0, 600) ?? null,
    last_interaction: p.lastInteraction
  };
}

function mapNoteForTool(n: Note) {
  return {
    id: n.id,
    content: n.content,
    source: n.source,
    source_badge: n.source === "voice" ? "VOICE" : "NOTE",
    ohio_time: n.ohioTime,
    ohio_time_friendly: formatOhioFriendly(n.ohioTime || n.createdAt),
    created_at: n.createdAt,
    linked_entities: n.linkedEntities
  };
}

async function toolSearchWeb(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const query = String(input.query || "").trim();
  if (!query) return { error: "query is required" };
  try {
    const results = await searchWeb(query);
    if (!results.length) return { results: [], empty: true };
    return {
      results: results.slice(0, 5).map((r) => ({
        title: r.title,
        snippet: r.description,
        url: r.url
      }))
    };
  } catch (error) {
    console.warn("[chat/tools] search_web failed:", error);
    return { error: "search unavailable" };
  }
}

async function toolReadEmails(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 20);
  try {
    const emails = await getRecentGmailMessages(limit, true);
    let filtered = emails;
    const filterText = String(input.filter || "").trim().toLowerCase();
    if (filterText) {
      filtered = emails.filter(
        (e) =>
          e.from?.toLowerCase().includes(filterText) ||
          e.subject?.toLowerCase().includes(filterText) ||
          e.snippet?.toLowerCase().includes(filterText)
      );
    }
    return {
      emails: filtered.map((e) => ({
        id: e.id,
        threadId: e.threadId,
        from: e.from,
        subject: e.subject,
        snippet: e.snippet,
        bodyText: e.bodyText,
        hasAttachment: e.hasAttachment,
        attachmentNames: e.attachmentNames,
        time: e.time,
        priority: e.priority,
        action: e.action
      }))
    };
  } catch (error) {
    console.warn("[chat/tools] read_emails failed:", error);
    return { error: "having trouble reaching Gmail" };
  }
}

async function toolGetEmailBody(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const emailId = String(input.email_id || input.message_id || "").trim();
  if (!emailId) return { error: "email_id is required" };

  try {
    const detail = await getEmailDetail(emailId);
    if (!detail) return { error: "email not found" };
    return detail;
  } catch (error) {
    console.warn("[chat/tools] get_email_body failed:", error);
    return { error: "could not load email body" };
  }
}

async function toolSendEmail(
  input: Record<string, unknown>,
  sessionId: string
): Promise<ToolExecutionResult> {
  const to = String(input.to || "").trim();
  const subject = String(input.subject || "").trim();
  const body = String(input.body || "").trim();
  if (!to || !subject || !body) return { error: "to, subject, and body are required" };

  try {
    const messageId =
      String(input.thread_id || input.message_id || "").trim() ||
      `<jarvis-${Date.now()}@joes-jarvis.local>`;
    const result = await sendGmailReply({
      messageId,
      threadId: String(input.thread_id || "").trim() || undefined,
      to,
      subject,
      body
    });
    const summary = `Sent email to ${to}: ${subject}`;
    logExecution({
      type: "email",
      action: "gmail.send_reply",
      item_id: `gmail:${result?.id || messageId}`,
      summary,
      result: "success"
    });
    return { success: true, message_id: result?.id || messageId, summary };
  } catch (error) {
    console.warn("[chat/tools] send_email failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "send failed"
    };
  }
}

function toolGetCalls(input: Record<string, unknown>): ToolExecutionResult {
  const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 30);
  const calls = getRecentCalls(limit);
  return {
    calls: calls.map((c) => ({
      id: c.id,
      from: c.from,
      reason: c.reason,
      outcome: c.outcome,
      time: c.time,
      priority: c.priorityLevel
    }))
  };
}

function toolGetQueue(): ToolExecutionResult {
  return getQueueStatusPayload();
}

function toolGetActionList(): ToolExecutionResult {
  const data = getActionListPayload();
  return { panel: "action-list", ...data };
}

function toolDismissQueueItem(input: Record<string, unknown>): ToolExecutionResult {
  const itemId = Number(input.item_id);
  const description = String(input.description || "").trim();

  if (Number.isFinite(itemId) && itemId > 0) {
    const item = getQueueItemById(itemId);
    markQueueItemHandled(itemId, "joe_explicit");
    return { success: true, item: item || { id: itemId } };
  }

  if (description) {
    const match = findQueueItemByDescription(description);
    if (!match) {
      return { success: false, error: "No matching queue item found" };
    }
    markQueueItemHandled(match.id, "joe_explicit");
    return { success: true, item: match };
  }

  return { success: false, error: "item_id or description required" };
}

function toolSnoozeQueueItem(input: Record<string, unknown>): ToolExecutionResult {
  const itemId = Number(input.item_id);
  const hours = Number(input.hours);
  if (!Number.isFinite(itemId) || itemId <= 0) {
    return { success: false, error: "item_id required" };
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    return { success: false, error: "hours must be positive" };
  }

  const result = snoozeQueueItem(itemId, hours);
  if (!result) {
    return { success: false, error: "Queue item not found" };
  }
  return { success: true, resurfaces_at: result.resurfacesAt };
}

async function toolBookCalendar(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const title = String(input.title || "").trim();
  const date = String(input.date || "").trim();
  if (!title || !date) return { error: "title and date are required" };

  const time = String(input.time || "09:00").trim();
  const duration = Math.min(Math.max(Number(input.duration_minutes) || 60, 15), 240);
  const notes = String(input.notes || "").trim();

  const startRaw = date.includes("T") ? date : `${date}T${time}:00`;
  const startDateTime = enforceBusinessHours(startRaw);
  const startMs = Date.parse(
    startDateTime.includes("T") && !/[zZ]|[+-]\d{2}:\d{2}$/.test(startDateTime)
      ? `${startDateTime}-05:00`
      : startDateTime
  );
  const endDateTime = Number.isFinite(startMs)
    ? new Date(startMs + duration * 60_000).toISOString()
    : enforceBusinessHours(`${date}T10:00:00`);

  try {
    const event = await createCalendarEvent({
      summary: title,
      description: notes || "Booked by JARVIS",
      startDateTime,
      endDateTime
    });
    if (!event) return { success: false, error: "calendar booking failed" };
    logExecution({
      type: "calendar",
      action: "calendar.create",
      item_id: event.eventId,
      summary: `Booked: ${title} at ${startDateTime}`,
      result: "success"
    });
    return { success: true, event_id: event.eventId, start: startDateTime, link: event.htmlLink };
  } catch (error) {
    console.warn("[chat/tools] book_calendar failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "calendar unavailable"
    };
  }
}

async function toolSaveNote(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const content = String(input.content || "").trim();
  if (!content) return { error: "content is required" };
  try {
    const { note } = await createNoteFromInput(content, "voice");
    return { success: true, note_id: note.id, content: note.content };
  } catch (error) {
    console.warn("[chat/tools] save_note failed:", error);
    return { success: false, error: error instanceof Error ? error.message : "save failed" };
  }
}

function toolGetNotes(input: Record<string, unknown>): ToolExecutionResult {
  const query = String(input.query || "").trim();
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
  const notes: Note[] = query ? searchNotesForTool(query, limit) : getRecentNotes(limit);
  return {
    count: notes.length,
    notes: notes.map(mapNoteForTool)
  };
}

function toolSaveMemory(input: Record<string, unknown>): ToolExecutionResult {
  const category = String(input.category || "business_context").trim();
  const key = String(input.key || "").trim();
  const value = String(input.value || "").trim();
  if (!key || !value) return { error: "key and value are required" };
  saveMemory({ category, key, value, confidence: 0.95, source: "joe_explicit" });
  return { success: true };
}

function isGeminiLiveSession(sessionId: string): boolean {
  const sid = sessionId.trim().toLowerCase();
  return sid === "gemini-voice" || sid.startsWith("gemini-");
}

function toolGetMemoryBrief(input: Record<string, unknown>): ToolExecutionResult {
  const query = String(input.query || "").trim();
  if (!query) return { error: "query is required" };
  const rows = searchMemoriesSql(query, undefined, 5);
  const lines = rows.map((m) => `${m.key}: ${m.value.slice(0, 500)}`);
  return {
    query,
    count: lines.length,
    memories: lines.length ? lines.join("\n") : "No matching memories."
  };
}

function toolGetIntel(input: Record<string, unknown>): ToolExecutionResult {
  const topic = String(input.topic || "").trim();
  if (!topic) return { error: "topic is required" };
  const needle = topic.toLowerCase();
  const rows = getWorldIntelSinceHours(168)
    .filter(
      (row) =>
        String(row.domain || "").toLowerCase().includes(needle) ||
        String(row.query || "").toLowerCase().includes(needle) ||
        String(row.summary || "").toLowerCase().includes(needle)
    )
    .slice(0, 3)
    .map((row) => ({
      domain: row.domain,
      query: row.query,
      summary: row.summary,
      relevance: row.relevance,
      fetched_at: row.fetchedAt
    }));
  const summaries = rows.map(
    (row) => `[${row.relevance}] ${row.domain || "general"} — ${row.query}: ${row.summary || "(no summary)"}`
  );
  return {
    topic,
    count: rows.length,
    intel: rows,
    summaries: summaries.length ? summaries.join("\n") : "No recent intel on that topic."
  };
}

async function toolOpenPanel(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const panel = String(input.panel || "").trim().toLowerCase();
  if (!panel) return { error: "panel is required" };

  switch (panel) {
    case "emails": {
      const result = await toolReadEmails({ limit: 20 });
      if (result.error) return result;
      return { panel: "emails", data: result.emails || [] };
    }
    case "calls": {
      const result = toolGetCalls({ limit: 15 });
      return { panel: "calls", data: result.calls || [] };
    }
    case "queue": {
      const result = toolGetQueue();
      return { panel: "queue", data: result };
    }
    case "action-list": {
      return { panel: "action-list", data: getActionListPayload() };
    }
    case "notes": {
      const result = toolGetNotes({});
      return { panel: "notes", data: result.notes || [] };
    }
    case "weather": {
      const result = await toolGetWeather({ location: input.location || "Holmes County Ohio weather" });
      if (result.error) return result;
      return { panel: "weather", data: [result] };
    }
    case "documents":
      return { panel: "documents", data: [], message: "Document library — use HUD upload for new files." };
    case "memory":
      return { panel: "memory", data: [] };
    case "rundown": {
      try {
        const rundown = await buildRundownResponse();
        return { panel: "rundown", data: [rundown] };
      } catch (error) {
        console.warn("[chat/tools] open_panel rundown failed:", error);
        return { error: "rundown unavailable" };
      }
    }
    default:
      return { error: `Unknown panel: ${panel}` };
  }
}

function toolGetMemory(input: Record<string, unknown>): ToolExecutionResult {
  const query = String(input.query || "").trim();
  if (!query) return { error: "query is required" };
  const category = String(input.category || "").trim() || undefined;

  const memories = searchMemoriesSql(query, category, 15).map(mapMemoryForTool);
  const entity_profiles = searchEntityProfiles(query, 8).map(mapEntityForTool);
  const recent_sessions = getRecentEpisodes(5).map((ep) => ({
    session_id: ep.sessionId,
    summary: ep.summary.slice(0, 500),
    topics: ep.topics,
    people_mentioned: ep.peopleMentioned,
    created_at: ep.createdAt
  }));
  const knowledge_gaps = getAggregatedKnowledgeGaps(12);
  const latestSynthesis = getMemorySynthesisLogs(1)[0];
  const self_evolution = getSelfEvolutionRecent(3).map((row) => ({
    category: row.category,
    observation: row.observation.slice(0, 300),
    suggested_improvement: row.suggested_improvement.slice(0, 300),
    status: row.status,
    created_at: row.created_at
  }));

  return {
    memories,
    entity_profiles,
    recent_sessions,
    knowledge_gaps,
    last_synthesis: latestSynthesis
      ? {
          ran_at: latestSynthesis.ranAt,
          category: latestSynthesis.category,
          summary: latestSynthesis.synthesisSummary?.slice(0, 500) ?? null
        }
      : null,
    self_evolution,
    count: memories.length
  };
}

function toolGetFullPicture(input: Record<string, unknown>): ToolExecutionResult {
  const categoryFilter = String(input.category || "").trim() || undefined;
  const grouped = getAllMemoriesGrouped();
  const memory_by_category: Record<
    string,
    Array<{ key: string; value_preview: string; confidence: number; importance: number }>
  > = {};

  for (const cat of MEMORY_CATEGORY_LIST) {
    if (categoryFilter && cat !== categoryFilter) continue;
    const rows = (grouped[cat] || []).filter((m) => m.confidence > 0 && m.isSynthesized >= 0);
    memory_by_category[cat] = rows.slice(0, 8).map((m) => ({
      key: m.key,
      value_preview: m.value.slice(0, 200),
      confidence: m.confidence,
      importance: m.importance
    }));
  }

  const synthesized_insights = getLatestSynthesizedPerCategory()
    .filter((m) => !categoryFilter || m.category === categoryFilter)
    .map((m) => ({
      category: m.category,
      key: m.key,
      value: m.value.slice(0, 400),
      confidence: m.confidence
    }));

  const stats = getMemoryStats();
  const synthesisLogs = getMemorySynthesisLogs(3);
  const knowledge_gaps = getAggregatedKnowledgeGaps(15);
  const self_evolution = getSelfEvolutionRecent(3).map((row) => ({
    observation: row.observation.slice(0, 250),
    suggested_improvement: row.suggested_improvement.slice(0, 250),
    category: row.category,
    status: row.status
  }));

  const entity_profiles = getAllEntityProfiles().slice(0, 30).map((p) => ({
    name: p.name,
    entity_type: p.entityType,
    relationship_summary: p.relationshipSummary,
    trust_level: p.trustLevel
  }));

  const recent_notes = getRecentNotes(5).map(mapNoteForTool);

  return {
    stats: {
      total_memories: stats.totalMemories,
      avg_confidence: Number(stats.avgConfidence.toFixed(2)),
      by_category: stats.byCategory,
      synthesized_count: stats.synthesizedCount,
      notes_count: getNotesCount(),
      last_synthesis_run:
        getSystemState("last_daily_synthesis_run") || synthesisLogs[0]?.ranAt || null
    },
    memory_by_category,
    entity_profiles,
    synthesized_insights,
    knowledge_gaps,
    self_evolution,
    recent_synthesis_runs: synthesisLogs.map((log) => ({
      ran_at: log.ranAt,
      category: log.category,
      memories_created: log.memoriesCreated,
      knowledge_gaps: log.knowledgeGaps.slice(0, 5)
    })),
    recent_notes
  };
}

function toolGetEntity(input: Record<string, unknown>): ToolExecutionResult {
  const name = String(input.name || "").trim();
  if (!name) return { error: "name is required" };

  const entity_profiles = searchEntityProfiles(name, 10).map(mapEntityForTool);
  const memories = searchMemoriesSql(name, undefined, 25).map(mapMemoryForTool);
  const notes = searchNotesForTool(name, 15).map(mapNoteForTool);
  const episodic_hits = searchEpisodes(name, 8).map((ep) => ({
    summary: ep.summary.slice(0, 500),
    session_id: ep.sessionId,
    created_at: ep.createdAt,
    people_mentioned: ep.peopleMentioned
  }));

  return {
    name,
    entity_profiles,
    memories,
    notes,
    episodic_sessions: episodic_hits,
    total_records: entity_profiles.length + memories.length + notes.length + episodic_hits.length
  };
}

async function toolGetWeather(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const location = String(input.location || "Holmes County Ohio weather").trim();
  try {
    const weather = await searchWeather(location);
    const panel = buildWeatherPanel(weather, weather.summary || "");
    return {
      conditions: panel.conditions,
      temperature: panel.temperature,
      wind: panel.wind,
      forecast: weather.summary,
      crew_impact: panel.crew_impact,
      crew_note: panel.crew_note,
      location: panel.location
    };
  } catch (error) {
    console.warn("[chat/tools] get_weather failed:", error);
    return { error: "weather unavailable" };
  }
}

async function toolSearchDocuments(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const query = String(input.query || "").trim();
  if (!query) return { error: "query is required" };
  try {
    const chunks = await searchDocuments(query);
    return {
      chunks: chunks.map((c) => ({
        documentTitle: c.documentTitle,
        content: c.content.slice(0, 600),
        chunkIndex: c.chunkIndex
      }))
    };
  } catch (error) {
    console.warn("[chat/tools] search_documents failed:", error);
    return { error: "document search failed" };
  }
}

function toolGetExecutionLog(input: Record<string, unknown>): ToolExecutionResult {
  const limit = Math.min(Math.max(Number(input.limit) || 12, 1), 40);
  const entries = getExecutionLogToday(limit);
  return {
    entries: entries.map((e) => ({
      type: e.type,
      action: e.action,
      summary: humanizeLogSummary(e.summary || ""),
      result: e.result,
      timestamp: e.timestamp
    }))
  };
}

export async function executeChatTool(
  name: string,
  input: Record<string, unknown>,
  sessionId: string
): Promise<ToolExecutionResult> {
  try {
    switch (name) {
      case "search_web":
        return await toolSearchWeb(input);
      case "read_emails":
        return await toolReadEmails(input);
      case "get_email_body":
        return await toolGetEmailBody(input);
      case "send_email":
        return await toolSendEmail(input, sessionId);
      case "get_calls":
        return toolGetCalls(input);
      case "get_queue":
        return toolGetQueue();
      case "get_action_list":
        return toolGetActionList();
      case "dismiss_queue_item":
        return toolDismissQueueItem(input);
      case "snooze_queue_item":
        return toolSnoozeQueueItem(input);
      case "book_calendar":
        return await toolBookCalendar(input);
      case "save_note":
        return await toolSaveNote(input);
      case "get_notes":
        return toolGetNotes(input);
      case "save_memory":
        return toolSaveMemory(input);
      case "get_memory":
        return isGeminiLiveSession(sessionId)
          ? toolGetMemoryBrief(input)
          : toolGetMemory(input);
      case "get_intel":
        return toolGetIntel(input);
      case "open_panel":
        return await toolOpenPanel(input);
      case "get_full_picture":
        return toolGetFullPicture(input);
      case "get_entity":
        return toolGetEntity(input);
      case "get_weather":
        return await toolGetWeather(input);
      case "search_documents":
        return await toolSearchDocuments(input);
      case "get_execution_log":
        return toolGetExecutionLog(input);
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (error) {
    console.warn(`[chat/tools] ${name} threw:`, error);
    return { error: error instanceof Error ? error.message : "tool failed" };
  }
}

export function emailWasSent(result: ToolExecutionResult): boolean {
  return result.success === true && Boolean(result.message_id);
}
