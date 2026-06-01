import type Anthropic from "@anthropic-ai/sdk";
import {
  getExecutionLogToday,
  getMemory,
  getQueue,
  getRecentCalls,
  getRecentNotes,
  logExecution,
  saveMemory,
  searchNotes,
  type Note
} from "../db/queries";
import { searchDocuments } from "../services/documentIntelligence";
import { getRecentGmailMessages, sendGmailReply } from "../services/gmail";
import { createCalendarEvent, enforceBusinessHours } from "../services/googleCalendar";
import { searchWeb } from "../services/braveSearch";
import { searchWeather } from "../services/braveSearch";
import { buildWeatherPanel } from "../routes/chat/liveData";
import { createNoteFromInput } from "../services/notes";
import { humanizeLogSummary } from "../utils/executionSummary";

export type ToolExecutionResult = Record<string, unknown>;

export const CHAT_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "search_web",
    description:
      "Search the internet for current information, news, prices, weather, grants, anything Joe needs researched. Use immediately when Joe asks about anything external. Do not defer.",
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
    description: "Read Joe's recent emails from Gmail.",
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
    description: "Get current priority queue items needing attention.",
    input_schema: { type: "object", properties: {} }
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
    description: "Retrieve notes Joe has saved.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
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
    description: "Retrieve memories about a topic.",
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
    description: "What JARVIS has done autonomously today.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number" } }
    }
  }
];

function searchMemories(query: string, category?: string, limit = 15) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return getMemory(category)
    .filter(
      (m) =>
        m.key.toLowerCase().includes(q) ||
        m.value.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q)
    )
    .slice(0, limit)
    .map((m) => ({
      category: m.category,
      key: m.key,
      value: m.value.slice(0, 500),
      confidence: m.confidence
    }));
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
    const emails = await getRecentGmailMessages(limit);
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
        time: e.time,
        priority: e.priority
      }))
    };
  } catch (error) {
    console.warn("[chat/tools] read_emails failed:", error);
    return { error: "having trouble reaching Gmail" };
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
  const items = getQueue(false);
  return {
    items: items.map((q) => ({
      id: q.id,
      type: q.type,
      urgency: q.urgency,
      summary: q.summary,
      handled: q.handled
    }))
  };
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
  const notes: Note[] = query ? searchNotes(query, limit) : getRecentNotes(limit);
  return {
    notes: notes.map((n) => ({
      id: n.id,
      content: n.content,
      source: n.source,
      ohioTime: n.ohioTime,
      createdAt: n.createdAt
    }))
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

function toolGetMemory(input: Record<string, unknown>): ToolExecutionResult {
  const query = String(input.query || "").trim();
  if (!query) return { error: "query is required" };
  const category = String(input.category || "").trim() || undefined;
  const memories = searchMemories(query, category);
  return { memories, count: memories.length };
}

async function toolGetWeather(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const location = String(input.location || "Holmes County Ohio weather").trim();
  try {
    const weather = await searchWeather(location);
    const panel = buildWeatherPanel(weather, weather.summary || "");
    return {
      conditions: panel.conditions,
      temp: panel.temperature,
      wind: panel.wind,
      forecast: weather.summary,
      job_site_rating: panel.crew_impact,
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
      case "send_email":
        return await toolSendEmail(input, sessionId);
      case "get_calls":
        return toolGetCalls(input);
      case "get_queue":
        return toolGetQueue();
      case "book_calendar":
        return await toolBookCalendar(input);
      case "save_note":
        return await toolSaveNote(input);
      case "get_notes":
        return toolGetNotes(input);
      case "save_memory":
        return toolSaveMemory(input);
      case "get_memory":
        return toolGetMemory(input);
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
