import { db } from "./index";
import { MEMORY_CATEGORY_LIST, MEMORY_NEVER_DECAY } from "../config/memoryCategories";

export type ConversationRole = "user" | "assistant" | "system";

export type ConversationMessage = {
  id: number;
  role: ConversationRole;
  content: string;
  created_at: string;
};

export type OperatorContext = {
  lastEmailAction?: {
    messageId: string;
    from: string;
    subject: string;
    summary: string;
    at: string;
  } | null;
  recentTopics?: string[];
};

export type ConversationState = {
  sessionId: string;
  activePanel: string | null;
  activeItems: unknown[];
  selectedItem: unknown | null;
  pendingAction: string | null;
  draft: string | null;
  lastIntent: string | null;
  operatorContext: OperatorContext;
};

export type CallOutcome = "FORWARDED" | "MESSAGE" | "BLOCKED";

export type CallLogItem = {
  id: number;
  callerNumber: string | null;
  callerName: string | null;
  callReason: string | null;
  transcript: string | null;
  outcome: CallOutcome;
  durationSeconds: number | null;
  priorityLevel: string | null;
  forwardedTo: string | null;
  timestamp: string;
  status: CallOutcome;
  from: string;
  reason: string;
  duration: string;
  time: string;
};

export type PriorityContact = {
  id: number;
  name: string | null;
  phoneNumber: string | null;
  relationship: string | null;
  alwaysForward: boolean;
  createdAt: string;
};

export function addConversationMessage(
  role: ConversationRole,
  content: string,
  sessionId = "default"
) {
  const statement = db.prepare(`
    INSERT INTO conversations (session_id, role, content)
    VALUES (@sessionId, @role, @content)
  `);

  return statement.run({ sessionId, role, content });
}

export function getRecentConversation(sessionId = "default", limit = 30): ConversationMessage[] {
  const statement = db.prepare(`
    SELECT id, role, content, created_at
    FROM conversations
    WHERE session_id = @sessionId
    ORDER BY id DESC
    LIMIT @limit
  `);

  return statement.all({ sessionId, limit }).reverse() as ConversationMessage[];
}

export function getOperationsSnapshot() {
  const priorityCalls = db
    .prepare(
      "SELECT COUNT(*) as count FROM calls WHERE priority_level = 'high' OR outcome = 'FORWARDED'"
    )
    .get() as { count: number };

  const messages = db
    .prepare("SELECT COUNT(*) as count FROM communication_logs WHERE source = 'sms'")
    .get() as { count: number };

  const flaggedEmails = db
    .prepare(
      "SELECT COUNT(*) as count FROM communication_logs WHERE source = 'email' AND action_required = 1"
    )
    .get() as { count: number };

  return {
    priorityCalls: priorityCalls.count,
    messages: messages.count,
    flaggedEmails: flaggedEmails.count,
    activeCrews: 0
  };
}

export function getRecentCommunicationLogs(limit = 10) {
  const statement = db.prepare(`
    SELECT source, sender, category, summary, action_required, created_at
    FROM communication_logs
    ORDER BY id DESC
    LIMIT @limit
  `);

  return statement.all({ limit });
}

function normalizePhoneNumber(value: string | null | undefined) {
  return String(value || "").replace(/[^\d+]/g, "");
}

function formatCallDuration(seconds: number | null) {
  if (!seconds || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatCallTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function mapCallRow(row: {
  id: number;
  caller_number: string | null;
  caller_name: string | null;
  call_reason: string | null;
  transcript: string | null;
  outcome: string | null;
  duration_seconds: number | null;
  priority_level: string | null;
  forwarded_to: string | null;
  timestamp: string;
}): CallLogItem {
  const outcome = (row.outcome || "MESSAGE").toUpperCase() as CallOutcome;
  const timestamp = row.timestamp;

  return {
    id: row.id,
    callerNumber: row.caller_number,
    callerName: row.caller_name,
    callReason: row.call_reason,
    transcript: row.transcript,
    outcome,
    durationSeconds: row.duration_seconds,
    priorityLevel: row.priority_level,
    forwardedTo: row.forwarded_to,
    timestamp,
    status: outcome,
    from: row.caller_name || row.caller_number || "Unknown caller",
    reason: row.call_reason || "No reason captured",
    duration: formatCallDuration(row.duration_seconds),
    time: formatCallTime(timestamp)
  };
}

export function addCallLog(input: {
  callerNumber?: string | null;
  callerName?: string | null;
  callReason?: string | null;
  transcript?: string | null;
  outcome?: string | null;
  durationSeconds?: number | null;
  priorityLevel?: string | null;
  forwardedTo?: string | null;
}) {
  const result = db
    .prepare(
      `
      INSERT INTO calls (
        caller_number,
        caller_name,
        call_reason,
        transcript,
        outcome,
        duration_seconds,
        priority_level,
        forwarded_to
      )
      VALUES (
        @callerNumber,
        @callerName,
        @callReason,
        @transcript,
        @outcome,
        @durationSeconds,
        @priorityLevel,
        @forwardedTo
      )
    `
    )
    .run({
      callerNumber: input.callerNumber || null,
      callerName: input.callerName || null,
      callReason: input.callReason || null,
      transcript: input.transcript || null,
      outcome: (input.outcome || "MESSAGE").toUpperCase(),
      durationSeconds: input.durationSeconds ?? null,
      priorityLevel: input.priorityLevel || null,
      forwardedTo: input.forwardedTo || null
    });

  const row = db
    .prepare(
      `
      SELECT id, caller_number, caller_name, call_reason, transcript, outcome, duration_seconds, priority_level, forwarded_to, timestamp
      FROM calls
      WHERE id = @id
    `
    )
    .get({ id: result.lastInsertRowid }) as Parameters<typeof mapCallRow>[0];

  return mapCallRow(row);
}

export function getRecentCalls(limit = 20): CallLogItem[] {
  const rows = db
    .prepare(
      `
      SELECT id, caller_number, caller_name, call_reason, transcript, outcome, duration_seconds, priority_level, forwarded_to, timestamp
      FROM calls
      ORDER BY id DESC
      LIMIT @limit
    `
    )
    .all({ limit }) as Array<Parameters<typeof mapCallRow>[0]>;

  return rows.map(mapCallRow);
}

export type AppointmentRow = {
  id: number;
  callerName: string | null;
  callerPhone: string | null;
  serviceRequested: string | null;
  preferredDate: string | null;
  notes: string | null;
  eventId: string | null;
  calendarLink: string | null;
  status: string;
  source: string;
  createdAt: string;
};

function mapAppointmentRow(row: {
  id: number;
  caller_name: string | null;
  caller_phone: string | null;
  service_requested: string | null;
  preferred_date: string | null;
  notes: string | null;
  event_id: string | null;
  calendar_link: string | null;
  status: string | null;
  source: string | null;
  created_at: string;
}): AppointmentRow {
  return {
    id: row.id,
    callerName: row.caller_name,
    callerPhone: row.caller_phone,
    serviceRequested: row.service_requested,
    preferredDate: row.preferred_date,
    notes: row.notes,
    eventId: row.event_id,
    calendarLink: row.calendar_link,
    status: row.status || "scheduled",
    source: row.source || "vapi",
    createdAt: row.created_at
  };
}

export function addAppointment(input: {
  callerName?: string | null;
  callerPhone?: string | null;
  serviceRequested?: string | null;
  preferredDate?: string | null;
  notes?: string | null;
  eventId?: string | null;
  calendarLink?: string | null;
  source?: string;
}) {
  const result = db
    .prepare(
      `
    INSERT INTO appointments (
      caller_name, caller_phone, service_requested, preferred_date,
      notes, event_id, calendar_link, status, source
    )
    VALUES (
      @callerName, @callerPhone, @serviceRequested, @preferredDate,
      @notes, @eventId, @calendarLink, 'scheduled', @source
    )
  `
    )
    .run({
      callerName: input.callerName?.slice(0, 200) || null,
      callerPhone: input.callerPhone?.slice(0, 40) || null,
      serviceRequested: input.serviceRequested?.slice(0, 500) || null,
      preferredDate: input.preferredDate?.slice(0, 120) || null,
      notes: input.notes?.slice(0, 4000) || null,
      eventId: input.eventId?.slice(0, 200) || null,
      calendarLink: input.calendarLink?.slice(0, 500) || null,
      source: input.source?.slice(0, 20) || "vapi"
    });
  return Number(result.lastInsertRowid);
}

export function getUpcomingAppointments(limit = 20): AppointmentRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, caller_name, caller_phone, service_requested, preferred_date,
           notes, event_id, calendar_link, status, source, created_at
    FROM appointments
    WHERE status = 'scheduled'
    ORDER BY datetime(created_at) DESC
    LIMIT @limit
  `
    )
    .all({ limit }) as Array<Parameters<typeof mapAppointmentRow>[0]>;
  return rows.map(mapAppointmentRow);
}

export function getAppointmentById(id: number): AppointmentRow | null {
  const row = db
    .prepare(
      `
    SELECT id, caller_name, caller_phone, service_requested, preferred_date,
           notes, event_id, calendar_link, status, source, created_at
    FROM appointments WHERE id = @id
  `
    )
    .get({ id }) as Parameters<typeof mapAppointmentRow>[0] | undefined;
  return row ? mapAppointmentRow(row) : null;
}

export function updateAppointmentStatus(id: number, status: string) {
  db.prepare(
    `
    UPDATE appointments SET status = @status WHERE id = @id
  `
  ).run({ id, status: status.slice(0, 20) });
}

export function findPriorityContactByPhone(phoneNumber: string) {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return null;

  const contacts = getPriorityContacts();
  return (
    contacts.find((contact) => normalizePhoneNumber(contact.phoneNumber).endsWith(normalized.slice(-10))) ||
    null
  );
}

export function addPriorityContact(input: {
  name?: string | null;
  phoneNumber?: string | null;
  relationship?: string | null;
  alwaysForward?: boolean;
}) {
  const result = db
    .prepare(
      `
      INSERT INTO priority_contacts (name, phone_number, relationship, always_forward)
      VALUES (@name, @phoneNumber, @relationship, @alwaysForward)
    `
    )
    .run({
      name: input.name || null,
      phoneNumber: input.phoneNumber || null,
      relationship: input.relationship || null,
      alwaysForward: input.alwaysForward === false ? 0 : 1
    });

  return getPriorityContactById(Number(result.lastInsertRowid));
}

export function getPriorityContactById(id: number) {
  const row = db
    .prepare(
      `
      SELECT id, name, phone_number, relationship, always_forward, created_at
      FROM priority_contacts
      WHERE id = @id
    `
    )
    .get({ id }) as
    | {
        id: number;
        name: string | null;
        phone_number: string | null;
        relationship: string | null;
        always_forward: number;
        created_at: string;
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    relationship: row.relationship,
    alwaysForward: Boolean(row.always_forward),
    createdAt: row.created_at
  } satisfies PriorityContact;
}

export function getPriorityContacts(): PriorityContact[] {
  const rows = db
    .prepare(
      `
      SELECT id, name, phone_number, relationship, always_forward, created_at
      FROM priority_contacts
      ORDER BY name COLLATE NOCASE, id DESC
    `
    )
    .all() as Array<{
    id: number;
    name: string | null;
    phone_number: string | null;
    relationship: string | null;
    always_forward: number;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    relationship: row.relationship,
    alwaysForward: Boolean(row.always_forward),
    createdAt: row.created_at
  }));
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function getState(sessionId: string): ConversationState {
  const row = db
    .prepare(
      `
      SELECT session_id, active_panel, active_items, selected_item, pending_action, draft, last_intent, operator_context
      FROM conversation_state
      WHERE session_id = @sessionId
    `
    )
    .get({ sessionId }) as
    | {
        session_id: string;
        active_panel: string | null;
        active_items: string | null;
        selected_item: string | null;
        pending_action: string | null;
        draft: string | null;
        last_intent: string | null;
        operator_context: string | null;
      }
    | undefined;

  if (!row) {
    return {
      sessionId,
      activePanel: null,
      activeItems: [],
      selectedItem: null,
      pendingAction: null,
      draft: null,
      lastIntent: null,
      operatorContext: {}
    };
  }

  return {
    sessionId: row.session_id,
    activePanel: row.active_panel,
    activeItems: parseJson(row.active_items, []),
    selectedItem: parseJson(row.selected_item, null),
    pendingAction: row.pending_action,
    draft: row.draft,
    lastIntent: row.last_intent,
    operatorContext: parseJson<OperatorContext>(row.operator_context, {})
  };
}

export function setState(sessionId: string, state: Partial<ConversationState>) {
  const nextState = {
    ...getState(sessionId),
    ...state,
    sessionId
  };

  db.prepare(
    `
    INSERT INTO conversation_state (
      session_id, active_panel, active_items, selected_item, pending_action, draft, last_intent, operator_context, updated_at
    )
    VALUES (
      @sessionId, @activePanel, @activeItems, @selectedItem, @pendingAction, @draft, @lastIntent, @operatorContext, datetime('now')
    )
    ON CONFLICT(session_id) DO UPDATE SET
      active_panel = excluded.active_panel,
      active_items = excluded.active_items,
      selected_item = excluded.selected_item,
      pending_action = excluded.pending_action,
      draft = excluded.draft,
      last_intent = excluded.last_intent,
      operator_context = excluded.operator_context,
      updated_at = datetime('now')
  `
  ).run({
    sessionId,
    activePanel: nextState.activePanel,
    activeItems: JSON.stringify(nextState.activeItems || []),
    selectedItem: JSON.stringify(nextState.selectedItem ?? null),
    pendingAction: nextState.pendingAction,
    draft: nextState.draft,
    lastIntent: nextState.lastIntent,
    operatorContext: JSON.stringify(nextState.operatorContext || {})
  });

  return nextState;
}

export function clearState(sessionId: string) {
  db.prepare("DELETE FROM conversation_state WHERE session_id = @sessionId").run({
    sessionId
  });

  return getState(sessionId);
}

export type PriorityQueueItem = {
  id: number;
  type: string;
  sourceId: string | null;
  summary: string | null;
  actionNeeded: string | null;
  urgency: string | null;
  handled: boolean;
  rawData: string | null;
  timestamp: string;
};

type PriorityQueueRow = {
  id: number;
  type: string;
  source_id: string | null;
  summary: string | null;
  action_needed: string | null;
  urgency: string | null;
  handled: number;
  raw_data: string | null;
  timestamp: string;
};

function mapPriorityQueueRow(row: PriorityQueueRow): PriorityQueueItem {
  return {
    id: row.id,
    type: row.type,
    sourceId: row.source_id,
    summary: row.summary,
    actionNeeded: row.action_needed,
    urgency: row.urgency,
    handled: Boolean(row.handled),
    rawData: row.raw_data,
    timestamp: row.timestamp
  };
}

export function getSystemState(key: string): string | null {
  const row = db.prepare(`SELECT value FROM system_state WHERE key = @key`).get({ key }) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSystemState(key: string, value: string) {
  db.prepare(
    `
    INSERT INTO system_state (key, value, updated_at) VALUES (@key, @value, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `
  ).run({ key, value });
}

const BRIEFING_DELIVERED_KEY = "last_briefing_delivered";
const BRIEFING_SUMMARY_KEY = "last_briefing_summary";

export function getLastBriefingTime(): string | null {
  const delivered = getSystemState(BRIEFING_DELIVERED_KEY);
  if (delivered) return delivered;
  return getSystemState("last_briefing_time");
}

export function getLastBriefingSummary(): string | null {
  return getSystemState(BRIEFING_SUMMARY_KEY);
}

export function setLastBriefingTime(summary: string) {
  const now = new Date().toISOString();
  setSystemState(BRIEFING_DELIVERED_KEY, now);
  setSystemState(BRIEFING_SUMMARY_KEY, summary.slice(0, 8000));
  setSystemState("last_briefing_time", now);
}

export function getLastBriefedItems(): string[] {
  const raw = getSystemState("last_briefed_items");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function mergeLastBriefedItems(newIds: string[]) {
  if (!newIds.length) return;
  const merged = [...new Set([...getLastBriefedItems(), ...newIds])];
  setSystemState("last_briefed_items", JSON.stringify(merged));
}

export function recordActivationBriefingDelivered(briefedIds: string[], speechSummary: string) {
  const now = new Date().toISOString();
  setSystemState("last_briefing_time", now);
  setSystemState(BRIEFING_DELIVERED_KEY, now);
  setSystemState(BRIEFING_SUMMARY_KEY, speechSummary.slice(0, 8000));
  mergeLastBriefedItems(briefedIds);
}

export function getCallsSince(since: Date, limit = 80): CallLogItem[] {
  const rows = db
    .prepare(
      `
      SELECT id, caller_number, caller_name, call_reason, transcript, outcome, duration_seconds, priority_level, forwarded_to, timestamp
      FROM calls
      WHERE datetime(timestamp) >= datetime(@since)
      ORDER BY id DESC
      LIMIT @limit
    `
    )
    .all({ since: since.toISOString(), limit }) as Array<Parameters<typeof mapCallRow>[0]>;
  return rows.map(mapCallRow);
}

export type BriefingMemoryRow = {
  id: number;
  category: string;
  key: string;
  value: string;
  confidence: number;
  createdAt: string;
};

export function getMemoriesCreatedSince(since: Date, limit = 20): BriefingMemoryRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, category, key, value, confidence, created_at
    FROM jarvis_memory
    WHERE datetime(created_at) >= datetime(@since)
    ORDER BY id DESC
    LIMIT @limit
  `
    )
    .all({ since: since.toISOString(), limit }) as Array<{
    id: number;
    category: string;
    key: string;
    value: string;
    confidence: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    createdAt: row.created_at
  }));
}

export function pendingQueueItemExists(type: string, sourceId: string): boolean {
  const row = db
    .prepare(
      `
    SELECT COUNT(*) as c FROM priority_queue
    WHERE type = @type AND source_id = @sourceId AND handled = 0
  `
    )
    .get({ type, sourceId }) as { c: number };
  return row.c > 0;
}

export function addToQueue(item: {
  type: string;
  source_id?: string | null;
  summary?: string | null;
  action_needed?: string | null;
  urgency?: string | null;
  handled?: boolean;
  raw_data?: string | null;
}): number {
  const result = db
    .prepare(
      `
    INSERT INTO priority_queue (type, source_id, summary, action_needed, urgency, handled, raw_data)
    VALUES (@type, @source_id, @summary, @action_needed, @urgency, @handled, @raw_data)
  `
    )
    .run({
      type: item.type,
      source_id: item.source_id ?? null,
      summary: item.summary ?? null,
      action_needed: item.action_needed ?? null,
      urgency: item.urgency ?? null,
      handled: item.handled ? 1 : 0,
      raw_data: item.raw_data ?? null
    });

  return Number(result.lastInsertRowid);
}

export function getQueue(handled = false): PriorityQueueItem[] {
  const rows = db
    .prepare(
      `
    SELECT id, type, source_id, summary, action_needed, urgency, handled, raw_data, timestamp
    FROM priority_queue
    WHERE handled = @handled
    ORDER BY
      CASE urgency
        WHEN 'NOW' THEN 0
        WHEN 'TODAY' THEN 1
        WHEN 'THIS_WEEK' THEN 2
        ELSE 3
      END,
      id DESC
  `
    )
    .all({ handled: handled ? 1 : 0 }) as PriorityQueueRow[];

  return rows.map(mapPriorityQueueRow);
}

export function getQueueGroupedByUrgency() {
  const items = getQueue(false);
  return {
    NOW: items.filter((i) => i.urgency === "NOW"),
    TODAY: items.filter((i) => i.urgency === "TODAY"),
    THIS_WEEK: items.filter(
      (i) => i.urgency === "THIS_WEEK" || !i.urgency || i.urgency === "NONE"
    )
  };
}

export function getQueueItemById(id: number): PriorityQueueItem | null {
  const row = db
    .prepare(
      `
    SELECT id, type, source_id, summary, action_needed, urgency, handled, raw_data, timestamp
    FROM priority_queue WHERE id = @id
  `
    )
    .get({ id }) as PriorityQueueRow | undefined;
  return row ? mapPriorityQueueRow(row) : null;
}

export function markQueueItemHandled(id: number) {
  db.prepare(`UPDATE priority_queue SET handled = 1 WHERE id = @id`).run({ id });
}

/** Open queue rows older than minAgeHours for backlog maintenance. */
export function getQueueMaintenanceCandidates(limit = 10, minAgeHours = 1): PriorityQueueItem[] {
  const rows = db
    .prepare(
      `
    SELECT id, type, source_id, summary, action_needed, urgency, handled, raw_data, timestamp
    FROM priority_queue
    WHERE handled = 0
      AND datetime(timestamp) <= datetime('now', '-' || @minAgeHours || ' hours')
    ORDER BY timestamp ASC
    LIMIT @limit
  `
    )
    .all({ minAgeHours, limit }) as PriorityQueueRow[];

  return rows.map(mapPriorityQueueRow);
}

export function hasSuccessfulExecutionForItem(sourceId: string): boolean {
  if (!sourceId.trim()) return false;
  const bare = sourceId.replace(/^gmail:/i, "");
  const row = db
    .prepare(
      `
    SELECT COUNT(*) as c FROM execution_log
    WHERE result = 'success'
      AND (
        item_id = @sourceId
        OR item_id = @bare
        OR item_id = @gmailPrefixed
        OR replace(item_id, 'gmail:', '') = @bare
      )
  `
    )
    .get({
      sourceId,
      bare,
      gmailPrefixed: bare ? `gmail:${bare}` : sourceId
    }) as { c: number };
  return row.c > 0;
}

export function markQueueItemHandledWithNote(id: number, note: string) {
  const item = getQueueItemById(id);
  if (!item) return;

  let raw: Record<string, unknown> = {};
  if (item.rawData) {
    try {
      const parsed = JSON.parse(item.rawData) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") raw = parsed;
    } catch {
      raw = {};
    }
  }

  raw.maintenanceNote = note;
  raw.autoClosedAt = new Date().toISOString();

  db.prepare(
    `
    UPDATE priority_queue
    SET handled = 1, action_needed = @note, raw_data = @raw_data
    WHERE id = @id
  `
  ).run({ id, note: note.slice(0, 500), raw_data: JSON.stringify(raw) });
}

export function escalateQueueItem(id: number, urgency: string, note: string) {
  const item = getQueueItemById(id);
  if (!item) return;

  let raw: Record<string, unknown> = {};
  if (item.rawData) {
    try {
      const parsed = JSON.parse(item.rawData) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") raw = parsed;
    } catch {
      raw = {};
    }
  }

  raw.escalatedAt = new Date().toISOString();
  raw.escalationNote = note;

  const actionNeeded = item.actionNeeded?.includes(note)
    ? item.actionNeeded
    : [item.actionNeeded, note].filter(Boolean).join(" — ").slice(0, 500);

  db.prepare(
    `
    UPDATE priority_queue
    SET urgency = @urgency, action_needed = @action_needed, raw_data = @raw_data
    WHERE id = @id
  `
  ).run({
    id,
    urgency,
    action_needed: actionNeeded,
    raw_data: JSON.stringify(raw)
  });
}

function queueRetriageWasAttempted(rawData: string | null): boolean {
  if (!rawData) return false;
  try {
    const parsed = JSON.parse(rawData) as { retriageAttempted?: boolean };
    return Boolean(parsed.retriageAttempted);
  } catch {
    return false;
  }
}

/** Open queue rows older than ageMinutes that have not been stale re-triaged yet. */
export function getStaleQueueItemsForRetriage(limit = 5, ageMinutes = 30): PriorityQueueItem[] {
  const rows = db
    .prepare(
      `
    SELECT id, type, source_id, summary, action_needed, urgency, handled, raw_data, timestamp
    FROM priority_queue
    WHERE handled = 0
      AND datetime(timestamp) <= datetime('now', '-' || @ageMinutes || ' minutes')
    ORDER BY timestamp ASC
    LIMIT @limit
  `
    )
    .all({ ageMinutes, limit }) as PriorityQueueRow[];

  return rows.map(mapPriorityQueueRow).filter((q) => !queueRetriageWasAttempted(q.rawData));
}

export function markQueueRetriageAttempted(id: number) {
  const item = getQueueItemById(id);
  if (!item) return;

  let raw: Record<string, unknown> = {};
  if (item.rawData) {
    try {
      const parsed = JSON.parse(item.rawData) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") raw = parsed;
    } catch {
      raw = {};
    }
  }

  raw.retriageAttempted = true;
  raw.retriageAttemptedAt = new Date().toISOString();

  db.prepare(`UPDATE priority_queue SET raw_data = @raw_data WHERE id = @id`).run({
    id,
    raw_data: JSON.stringify(raw)
  });
}

export function clearHandledQueue() {
  db.prepare(`DELETE FROM priority_queue WHERE handled = 1`).run();
}

export function countHandledQueueItems() {
  const row = db.prepare(`SELECT COUNT(*) as c FROM priority_queue WHERE handled = 1`).get() as {
    c: number;
  };
  return row.c;
}

export function getCallsAfterRowId(lastId: number, limit = 40): CallLogItem[] {
  const rows = db
    .prepare(
      `
    SELECT id, caller_number, caller_name, call_reason, transcript, outcome, duration_seconds, priority_level, forwarded_to, timestamp
    FROM calls
    WHERE id > @lastId
    ORDER BY id ASC
    LIMIT @limit
  `
    )
    .all({ lastId, limit }) as Array<Parameters<typeof mapCallRow>[0]>;

  return rows.map(mapCallRow);
}

export function getLastCallIntelCursor(): number {
  return Number(getSystemState("last_call_intel_id") || "0");
}

export function setLastCallIntelCursor(id: number) {
  setSystemState("last_call_intel_id", String(id));
}

export function clearActiveAlertState() {
  setSystemState("active_alert", JSON.stringify({ hasAlert: false }));
}

/** Drop stale brain alert after Gmail recovers (avoids Claude repeating old auth failures). */
export function clearGmailAuthAlertIfPresent() {
  const raw = getSystemState("active_alert");
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { type?: string; hasAlert?: boolean };
    if (parsed?.hasAlert && parsed.type === "gmail_auth") {
      clearActiveAlertState();
    }
  } catch {
    /* ignore malformed alert blob */
  }
}

export function setActiveAlertState(payload: { hasAlert: boolean; queueId?: number; summary?: string }) {
  setSystemState("active_alert", JSON.stringify(payload));
}

export function getActiveAlertPayload(): { hasAlert: boolean; alert: PriorityQueueItem | null } {
  const raw = getSystemState("active_alert");
  if (!raw) {
    return { hasAlert: false, alert: null };
  }

  try {
    const parsed = JSON.parse(raw) as {
      hasAlert?: boolean;
      queueId?: number;
      summary?: string;
      type?: string;
      at?: string;
    };
    if (!parsed?.hasAlert) {
      return { hasAlert: false, alert: null };
    }

    if (parsed.queueId) {
      const item = getQueueItemById(parsed.queueId);
      if (item && !item.handled) {
        return { hasAlert: true, alert: item };
      }
    }

    const alertType = String(parsed.type || "alert");

    return {
      hasAlert: true,
      alert: {
        id: 0,
        type: alertType,
        sourceId: null,
        summary: parsed.summary || "Active alert",
        actionNeeded: "Review immediately",
        urgency: "NOW",
        handled: false,
        rawData: raw,
        timestamp: parsed.at || new Date().toISOString()
      }
    };
  } catch {
    return { hasAlert: false, alert: null };
  }
}

export function clearAlertIfMatchingQueueItem(queueId: number) {
  const raw = getSystemState("active_alert");
  try {
    const parsed = JSON.parse(raw || "{}") as { hasAlert?: boolean; queueId?: number };
    if (parsed.hasAlert && parsed.queueId === queueId) {
      clearActiveAlertState();
    }
  } catch {
    /* ignore */
  }
}

export type JarvisMemory = {
  id: number;
  category: string;
  key: string;
  value: string;
  confidence: number;
  occurrenceCount: number;
  lastSeen: string;
  createdAt: string;
  flagged: boolean;
  flagReason: string | null;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  source: string | null;
};

type JarvisMemoryRow = {
  id: number;
  category: string;
  key: string;
  value: string;
  confidence: number;
  occurrence_count: number;
  last_seen: string;
  created_at: string;
  flagged?: number | null;
  flag_reason?: string | null;
  retrieval_count?: number | null;
  last_retrieved_at?: string | null;
  source?: string | null;
};

function mapJarvisMemoryRow(row: JarvisMemoryRow): JarvisMemory {
  return {
    id: row.id,
    category: row.category,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    occurrenceCount: row.occurrence_count,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    flagged: Boolean(row.flagged),
    flagReason: row.flag_reason ?? null,
    retrievalCount: row.retrieval_count ?? 0,
    lastRetrievedAt: row.last_retrieved_at ?? null,
    source: row.source ?? null
  };
}

export function trackMemoryRetrieval(ids: number[]) {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  if (!unique.length) return;
  const stmt = db.prepare(
    `
    UPDATE jarvis_memory
    SET retrieval_count = retrieval_count + 1,
        last_retrieved_at = datetime('now')
    WHERE id = @id
  `
  );
  for (const id of unique) {
    stmt.run({ id });
  }
}

export function saveMemory(input: {
  category: string;
  key: string;
  value: string;
  confidence?: number;
  source?: string | null;
}) {
  const confidence = input.confidence ?? 1.0;
  const source = input.source?.slice(0, 40) || null;
  db.prepare(
    `
    INSERT INTO jarvis_memory (category, key, value, confidence, occurrence_count, last_seen, created_at, source)
    VALUES (@category, @key, @value, @confidence, 1, datetime('now'), datetime('now'), @source)
    ON CONFLICT(category, key) DO UPDATE SET
      value = excluded.value,
      occurrence_count = jarvis_memory.occurrence_count + 1,
      last_seen = datetime('now'),
      confidence = MIN(1.0, MAX(jarvis_memory.confidence, excluded.confidence)),
      source = COALESCE(excluded.source, jarvis_memory.source)
  `
  ).run({
    category: input.category.slice(0, 120),
    key: input.key.slice(0, 200),
    value: input.value.slice(0, 8000),
    confidence,
    source
  });
}

export function getMemory(category?: string): JarvisMemory[] {
  if (category) {
    const rows = db
      .prepare(
        `
      SELECT * FROM jarvis_memory WHERE category = @category ORDER BY confidence DESC, occurrence_count DESC
    `
      )
      .all({ category }) as JarvisMemoryRow[];
    return rows.map(mapJarvisMemoryRow);
  }

  const rows = db
    .prepare(
      `
    SELECT * FROM jarvis_memory ORDER BY category, confidence DESC, occurrence_count DESC
  `
    )
    .all() as JarvisMemoryRow[];

  return rows.map(mapJarvisMemoryRow);
}

export function updateMemoryConfidence(id: number, delta: number) {
  db.prepare(
    `
    UPDATE jarvis_memory
    SET confidence = CASE
        WHEN confidence + @delta < 0.05 THEN 0.05
        WHEN confidence + @delta > 1.0 THEN 1.0
        ELSE confidence + @delta
      END,
      last_seen = datetime('now')
    WHERE id = @id
  `
  ).run({ id, delta });
}

export function incrementOccurrence(category: string, key: string): boolean {
  const result = db
    .prepare(
      `
    UPDATE jarvis_memory
    SET occurrence_count = occurrence_count + 1,
        last_seen = datetime('now'),
        confidence = MIN(1.0, confidence + 0.03)
    WHERE category = @category AND key = @key
  `
    )
    .run({ category, key });
  return result.changes > 0;
}

export function getTopMemories(limit = 20): JarvisMemory[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM jarvis_memory
    ORDER BY confidence DESC, occurrence_count DESC, last_seen DESC
    LIMIT @limit
  `
    )
    .all({ limit }) as JarvisMemoryRow[];

  return rows.map(mapJarvisMemoryRow);
}

/** Eligible for prompt: not flagged, confidence >= 0.3 */
export function getEligibleMemories(limit = 20): JarvisMemory[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM jarvis_memory
    WHERE flagged = 0 AND confidence >= 0.3
    ORDER BY confidence DESC, occurrence_count DESC, last_seen DESC
    LIMIT @limit
  `
    )
    .all({ limit }) as JarvisMemoryRow[];

  return rows.map(mapJarvisMemoryRow);
}

type IntentMemorySignal = {
  categories: string[];
  keywords: string[];
  strong: boolean;
};

function extractMemoryIntentSignals(message: string): IntentMemorySignal {
  const q = message.toLowerCase();
  const categories = new Set<string>();
  const keywords: string[] = [];

  const addWords = (text: string) => {
    for (const w of text.split(/[^a-z0-9]+/)) {
      if (w.length >= 3) keywords.push(w);
    }
  };

  addWords(q);

  if (/\b(weather|temperature|frost|freeze|snow|rain|storm|wind|forecast|field)\b/.test(q)) {
    categories.add("world_intel");
    categories.add("crew_labor");
  }
  if (/\b(client|customer|reynolds|henderson|property owner)\b/.test(q)) {
    categories.add("client_relations");
  }
  if (/\b(prefer|always|never|tone|reply|greeting|how i like)\b/.test(q)) {
    categories.add("operator_preferences");
  }
  if (/\b(vendor|supplier|mulch|steel|tariff|supply|material|price)\b/.test(q)) {
    categories.add("vendor_supplier");
  }
  if (/\b(drone|faa|part 107|uas|fly)\b/.test(q)) {
    categories.add("drone_faa");
  }
  if (/\b(crew|labor|foreman|workers|dispatch)\b/.test(q)) {
    categories.add("crew_labor");
  }
  if (/\b(contract|estimate|document|quote|terms|scope)\b/.test(q)) {
    categories.add("document_facts");
  }
  if (/\b(landscap|hardscape|industry|competitor)\b/.test(q)) {
    categories.add("industry");
  }
  if (/\b(totally outdoors|business|policy|operations|ohio|holmes)\b/.test(q)) {
    categories.add("business_context");
  }
  if (/\b(news|world|economy|tariff|russia|china)\b/.test(q)) {
    categories.add("world_intel");
  }

  const strong = categories.size > 0 || keywords.length >= 4;
  return { categories: [...categories], keywords: [...new Set(keywords)], strong };
}

function scoreMemoryForMessage(memory: JarvisMemory, signal: IntentMemorySignal): number {
  let score = memory.confidence;
  const hay = `${memory.category} ${memory.key} ${memory.value}`.toLowerCase();

  if (signal.categories.includes(memory.category)) {
    score += 0.35;
  }

  let keywordHits = 0;
  for (const kw of signal.keywords) {
    if (kw.length >= 3 && hay.includes(kw)) keywordHits += 1;
  }
  score += Math.min(0.4, keywordHits * 0.08);

  return score;
}

/** Intent-based retrieval for chat prompt; falls back to top confidence when weak signal. */
export function getMemoriesForMessage(message: string, limit = 20): JarvisMemory[] {
  const signal = extractMemoryIntentSignals(message);
  const rows = db
    .prepare(
      `
    SELECT * FROM jarvis_memory
    WHERE flagged = 0 AND confidence >= 0.3
  `
    )
    .all() as JarvisMemoryRow[];

  const eligible = rows.map(mapJarvisMemoryRow);
  if (!eligible.length) return [];

  if (!signal.strong) {
    return eligible
      .sort((a, b) => b.confidence - a.confidence || b.occurrenceCount - a.occurrenceCount)
      .slice(0, limit);
  }

  return eligible
    .map((m) => ({ m, score: scoreMemoryForMessage(m, signal) }))
    .sort((a, b) => b.score - a.score || b.m.confidence - a.m.confidence)
    .slice(0, limit)
    .map((row) => row.m);
}

export type EntityProfile = {
  id: number;
  name: string;
  entityType: string;
  phone: string | null;
  email: string | null;
  relationshipSummary: string | null;
  lastInteraction: string | null;
  interactionCount: number;
  trustLevel: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type EntityProfileRow = {
  id: number;
  name: string;
  entity_type: string;
  phone: string | null;
  email: string | null;
  relationship_summary: string | null;
  last_interaction: string | null;
  interaction_count: number;
  trust_level: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function mapEntityProfileRow(row: EntityProfileRow): EntityProfile {
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    phone: row.phone,
    email: row.email,
    relationshipSummary: row.relationship_summary,
    lastInteraction: row.last_interaction,
    interactionCount: row.interaction_count,
    trustLevel: row.trust_level || "unknown",
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function upsertEntityProfile(input: {
  name: string;
  entityType: string;
  phone?: string | null;
  email?: string | null;
  relationshipSummary?: string | null;
  notesAppend?: string | null;
}) {
  const name = input.name.trim().slice(0, 200);
  const entityType = input.entityType.trim().slice(0, 40);
  const existing = getEntityProfile(name);

  let notes = input.notesAppend?.trim() || null;
  if (notes && existing?.notes) {
    notes = `${existing.notes}\n${notes}`.slice(0, 8000);
  } else if (!notes) {
    notes = existing?.notes ?? null;
  }

  db.prepare(
    `
    INSERT INTO entity_profiles (
      name, entity_type, phone, email, relationship_summary,
      last_interaction, interaction_count, trust_level, notes, created_at, updated_at
    )
    VALUES (
      @name, @entity_type, @phone, @email, @relationship_summary,
      datetime('now'), 1, 'unknown', @notes, datetime('now'), datetime('now')
    )
    ON CONFLICT(name) DO UPDATE SET
      entity_type = excluded.entity_type,
      phone = COALESCE(excluded.phone, entity_profiles.phone),
      email = COALESCE(excluded.email, entity_profiles.email),
      relationship_summary = COALESCE(excluded.relationship_summary, entity_profiles.relationship_summary),
      notes = COALESCE(@notes, entity_profiles.notes),
      last_interaction = datetime('now'),
      interaction_count = entity_profiles.interaction_count + 1,
      updated_at = datetime('now')
  `
  ).run({
    name,
    entity_type: entityType,
    phone: input.phone?.trim() || existing?.phone || null,
    email: input.email?.trim() || existing?.email || null,
    relationship_summary:
      input.relationshipSummary?.trim() || existing?.relationshipSummary || null,
    notes
  });
}

export function getEntityProfile(name: string): EntityProfile | null {
  const row = db
    .prepare(`SELECT * FROM entity_profiles WHERE lower(name) = lower(@name) LIMIT 1`)
    .get({ name: name.trim() }) as EntityProfileRow | undefined;
  return row ? mapEntityProfileRow(row) : null;
}

export function updateEntityTrustLevel(name: string, trustLevel: string) {
  db.prepare(
    `
    UPDATE entity_profiles
    SET trust_level = @trust_level, updated_at = datetime('now')
    WHERE lower(name) = lower(@name)
  `
  ).run({ name: name.trim(), trust_level: trustLevel.slice(0, 20) });
}

export function findEntityProfilesForMessage(message: string, limit = 6): EntityProfile[] {
  const hints = message.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) || [];
  const names = [...new Set(hints.map((h) => h.trim()).filter((h) => h.length >= 2))].slice(0, 8);
  if (!names.length) return [];

  const hits: EntityProfile[] = [];
  const seen = new Set<number>();
  for (const name of names) {
    const rows = db
      .prepare(
        `
      SELECT * FROM entity_profiles
      WHERE lower(name) LIKE '%' || lower(@hint) || '%'
      ORDER BY interaction_count DESC, updated_at DESC
      LIMIT 2
    `
      )
      .all({ hint: name }) as EntityProfileRow[];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      hits.push(mapEntityProfileRow(row));
    }
  }
  return hits.slice(0, limit);
}

export type EpisodicMemoryRow = {
  id: number;
  sessionId: string;
  summary: string;
  keyDecisions: string | null;
  peopleMentioned: string | null;
  topics: string | null;
  createdAt: string;
};

export function insertEpisodicMemory(input: {
  sessionId: string;
  summary: string;
  keyDecisions?: string[];
  peopleMentioned?: string[];
  topics?: string[];
}) {
  const result = db
    .prepare(
      `
    INSERT INTO episodic_memory (session_id, summary, key_decisions, people_mentioned, topics)
    VALUES (@sessionId, @summary, @keyDecisions, @peopleMentioned, @topics)
  `
    )
    .run({
      sessionId: input.sessionId,
      summary: input.summary.slice(0, 4000),
      keyDecisions: JSON.stringify(input.keyDecisions || []),
      peopleMentioned: JSON.stringify(input.peopleMentioned || []),
      topics: JSON.stringify(input.topics || [])
    });
  return Number(result.lastInsertRowid);
}

export function getRecentEpisodes(limit = 3): EpisodicMemoryRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, session_id, summary, key_decisions, people_mentioned, topics, created_at
    FROM episodic_memory
    ORDER BY datetime(created_at) DESC
    LIMIT @limit
  `
    )
    .all({ limit }) as Array<{
    id: number;
    session_id: string;
    summary: string;
    key_decisions: string | null;
    people_mentioned: string | null;
    topics: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    summary: r.summary,
    keyDecisions: r.key_decisions,
    peopleMentioned: r.people_mentioned,
    topics: r.topics,
    createdAt: r.created_at
  }));
}

export function searchEpisodes(query: string, limit = 10): EpisodicMemoryRow[] {
  const q = `%${query.toLowerCase().slice(0, 120)}%`;
  const rows = db
    .prepare(
      `
    SELECT id, session_id, summary, key_decisions, people_mentioned, topics, created_at
    FROM episodic_memory
    WHERE lower(summary) LIKE @q
       OR lower(COALESCE(topics, '')) LIKE @q
       OR lower(COALESCE(people_mentioned, '')) LIKE @q
    ORDER BY datetime(created_at) DESC
    LIMIT @limit
  `
    )
    .all({ q, limit }) as Array<{
    id: number;
    session_id: string;
    summary: string;
    key_decisions: string | null;
    people_mentioned: string | null;
    topics: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    summary: r.summary,
    keyDecisions: r.key_decisions,
    peopleMentioned: r.people_mentioned,
    topics: r.topics,
    createdAt: r.created_at
  }));
}

export function getEpisodesSinceDays(days: number, limit = 200): EpisodicMemoryRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, session_id, summary, key_decisions, people_mentioned, topics, created_at
    FROM episodic_memory
    WHERE datetime(created_at) >= datetime('now', '-' || @days || ' days')
    ORDER BY datetime(created_at) DESC
    LIMIT @limit
  `
    )
    .all({ days, limit }) as Array<{
    id: number;
    session_id: string;
    summary: string;
    key_decisions: string | null;
    people_mentioned: string | null;
    topics: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    summary: r.summary,
    keyDecisions: r.key_decisions,
    peopleMentioned: r.people_mentioned,
    topics: r.topics,
    createdAt: r.created_at
  }));
}

export function insertSelfEvolutionEntry(input: {
  observation: string;
  suggestedImprovement: string;
  category: string;
  confidence?: number;
}) {
  db.prepare(
    `
    INSERT INTO self_evolution_log (observation, suggested_improvement, category, confidence)
    VALUES (@observation, @suggested_improvement, @category, @confidence)
  `
  ).run({
    observation: input.observation.slice(0, 4000),
    suggested_improvement: input.suggestedImprovement.slice(0, 4000),
    category: input.category.slice(0, 40),
    confidence: input.confidence ?? 0.7
  });
}

export function getSelfEvolutionInsights(status = "pending", limit = 20) {
  const rows = db
    .prepare(
      `
    SELECT id, observation, suggested_improvement, category, status, confidence, created_at, resolved_at
    FROM self_evolution_log
    WHERE status = @status
    ORDER BY datetime(created_at) DESC
    LIMIT @limit
  `
    )
    .all({ status, limit }) as Array<{
    id: number;
    observation: string;
    suggested_improvement: string;
    category: string;
    status: string;
    confidence: number;
    created_at: string;
    resolved_at: string | null;
  }>;
  return rows;
}

export function resolveSelfEvolutionInsight(
  id: number,
  status: "approved" | "rejected"
): boolean {
  const result = db
    .prepare(
      `
    UPDATE self_evolution_log
    SET status = @status, resolved_at = datetime('now')
    WHERE id = @id AND status = 'pending'
  `
    )
    .run({ id, status });
  return result.changes > 0;
}

export function getEvolutionHudStats(): {
  total_memories: number;
  total_entities: number;
  total_episodes: number;
  top_retrieved: Array<{ key: string; category: string; retrieval_count: number }>;
  knowledge_gaps: string[];
} {
  const totalMemories = db
    .prepare(`SELECT COUNT(*) AS c FROM jarvis_memory WHERE flagged = 0`)
    .get() as { c: number };
  const totalEntities = db.prepare(`SELECT COUNT(*) AS c FROM entity_profiles`).get() as {
    c: number;
  };
  const totalEpisodes = db.prepare(`SELECT COUNT(*) AS c FROM episodic_memory`).get() as {
    c: number;
  };
  const topRetrieved = getTopRetrievedMemories(5).map((m) => ({
    key: m.key,
    category: m.category,
    retrieval_count: m.retrievalCount
  }));
  const knowledge_gaps = countMemoriesByCategory()
    .filter((row) => row.count < 3)
    .map((row) => row.category);

  return {
    total_memories: totalMemories.c,
    total_entities: totalEntities.c,
    total_episodes: totalEpisodes.c,
    top_retrieved: topRetrieved,
    knowledge_gaps
  };
}

export function countMemoriesByCategory(): Array<{ category: string; count: number }> {
  return db
    .prepare(
      `
    SELECT category, COUNT(*) AS count FROM jarvis_memory GROUP BY category ORDER BY count ASC
  `
    )
    .all() as Array<{ category: string; count: number }>;
}

export function getTopRetrievedMemories(limit = 5): JarvisMemory[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM jarvis_memory
    WHERE retrieval_count > 0
    ORDER BY retrieval_count DESC, confidence DESC
    LIMIT @limit
  `
    )
    .all({ limit }) as JarvisMemoryRow[];
  return rows.map(mapJarvisMemoryRow);
}

export function getNeverRetrievedMemoriesOlderThanDays(days: number, limit = 50): JarvisMemory[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM jarvis_memory
    WHERE retrieval_count = 0
      AND datetime(created_at) < datetime('now', '-' || @days || ' days')
    ORDER BY datetime(created_at) ASC
    LIMIT @limit
  `
    )
    .all({ days, limit }) as JarvisMemoryRow[];
  return rows.map(mapJarvisMemoryRow);
}

export function isWorldIntelReferencedInConversation(query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return false;
  const episodes = searchEpisodes(q, 5);
  if (episodes.length) return true;
  const mem = db
    .prepare(
      `
    SELECT COUNT(*) AS c FROM jarvis_memory
    WHERE lower(key) LIKE '%' || @q || '%' OR lower(value) LIKE '%' || @q || '%'
  `
    )
    .get({ q: `%${q}%` }) as { c: number };
  return mem.c > 0;
}

export type MemoryAuditQueueItem = {
  id: number;
  action: "delete" | "merge" | "flag";
  category: string;
  memoryKey: string;
  mergeWithKey: string | null;
  reason: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
};

type MemoryAuditQueueRow = {
  id: number;
  action: string;
  category: string;
  memory_key: string;
  merge_with_key: string | null;
  reason: string | null;
  status: string;
  created_at: string;
  reviewed_at: string | null;
};

function mapAuditQueueRow(row: MemoryAuditQueueRow): MemoryAuditQueueItem {
  return {
    id: row.id,
    action: row.action as MemoryAuditQueueItem["action"],
    category: row.category,
    memoryKey: row.memory_key,
    mergeWithKey: row.merge_with_key,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at
  };
}

export function enqueueMemoryAuditAction(input: {
  action: "delete" | "merge" | "flag";
  category: string;
  memoryKey: string;
  mergeWithKey?: string;
  reason: string;
}): number {
  const existing = db
    .prepare(
      `
    SELECT id FROM memory_audit_queue
    WHERE status = 'pending' AND category = @category AND memory_key = @memoryKey AND action = @action
  `
    )
    .get({
      category: input.category,
      memoryKey: input.memoryKey,
      action: input.action
    }) as { id: number } | undefined;

  if (existing?.id) return existing.id;

  const result = db
    .prepare(
      `
    INSERT INTO memory_audit_queue (action, category, memory_key, merge_with_key, reason, status)
    VALUES (@action, @category, @memoryKey, @mergeWithKey, @reason, 'pending')
  `
    )
    .run({
      action: input.action,
      category: input.category,
      memoryKey: input.memoryKey,
      mergeWithKey: input.mergeWithKey ?? null,
      reason: input.reason.slice(0, 500)
    });

  return Number(result.lastInsertRowid);
}

export function getPendingMemoryAuditQueue(): MemoryAuditQueueItem[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM memory_audit_queue
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `
    )
    .all() as MemoryAuditQueueRow[];

  return rows.map(mapAuditQueueRow);
}

export function getMemoryAuditQueueByIds(ids: number[]): MemoryAuditQueueItem[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM memory_audit_queue WHERE id IN (${placeholders}) AND status = 'pending'`
    )
    .all(...ids) as MemoryAuditQueueRow[];

  return rows.map(mapAuditQueueRow);
}

export function markMemoryAuditQueueReviewed(ids: number[], status: "approved" | "rejected"): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `
    UPDATE memory_audit_queue
    SET status = ?, reviewed_at = datetime('now')
    WHERE id IN (${placeholders}) AND status = 'pending'
  `
  ).run(status, ...ids);
}

export function getMemoryByCategoryKey(category: string, key: string): JarvisMemory | null {
  const row = db
    .prepare(`SELECT * FROM jarvis_memory WHERE category = @category AND key = @key`)
    .get({ category, key }) as JarvisMemoryRow | undefined;
  return row ? mapJarvisMemoryRow(row) : null;
}

export function getMemoryById(id: number): JarvisMemory | null {
  const row = db.prepare(`SELECT * FROM jarvis_memory WHERE id = @id`).get({ id }) as
    | JarvisMemoryRow
    | undefined;
  return row ? mapJarvisMemoryRow(row) : null;
}

export function deleteMemoryById(id: number): JarvisMemory | null {
  const existing = getMemoryById(id);
  if (!existing) return null;
  db.prepare(`DELETE FROM jarvis_memory WHERE id = @id`).run({ id });
  return existing;
}

export function updateMemoryById(
  id: number,
  patch: { value?: string; confidence?: number; flagged?: boolean; flagReason?: string | null }
): JarvisMemory | null {
  const existing = getMemoryById(id);
  if (!existing) return null;

  const value = patch.value !== undefined ? patch.value.slice(0, 8000) : existing.value;
  const confidence =
    patch.confidence !== undefined
      ? Math.min(1, Math.max(0.05, patch.confidence))
      : existing.confidence;
  const flagged = patch.flagged !== undefined ? (patch.flagged ? 1 : 0) : existing.flagged ? 1 : 0;
  const flagReason =
    patch.flagReason !== undefined ? patch.flagReason : existing.flagReason;

  db.prepare(
    `
    UPDATE jarvis_memory
    SET value = @value,
        confidence = @confidence,
        flagged = @flagged,
        flag_reason = @flagReason,
        last_seen = datetime('now')
    WHERE id = @id
  `
  ).run({ id, value, confidence, flagged, flagReason: flagReason ?? null });

  return getMemoryById(id);
}

export function flagMemoryByKey(
  category: string,
  key: string,
  reason: string
): boolean {
  const result = db
    .prepare(
      `
    UPDATE jarvis_memory
    SET flagged = 1, flag_reason = @reason, last_seen = datetime('now')
    WHERE category = @category AND key = @key
  `
    )
    .run({ category, key, reason: reason.slice(0, 500) });
  return result.changes > 0;
}

export function mergeMemoryKeys(
  category: string,
  keepKey: string,
  removeKey: string,
  mergedValue: string
): boolean {
  const keep = getMemoryByCategoryKey(category, keepKey);
  const remove = getMemoryByCategoryKey(category, removeKey);
  if (!keep || !remove) return false;

  const occurrence = keep.occurrenceCount + remove.occurrenceCount;
  const confidence = Math.min(1, Math.max(keep.confidence, remove.confidence));

  db.prepare(
    `
    UPDATE jarvis_memory
    SET value = @value,
        occurrence_count = @occurrence,
        confidence = @confidence,
        last_seen = datetime('now')
    WHERE category = @category AND key = @keepKey
  `
  ).run({
    category,
    keepKey,
    value: mergedValue.slice(0, 8000),
    occurrence,
    confidence
  });

  db.prepare(`DELETE FROM jarvis_memory WHERE category = @category AND key = @removeKey`).run({
    category,
    removeKey
  });
  return true;
}

export function getAllMemoriesGrouped(): Record<string, JarvisMemory[]> {
  const grouped: Record<string, JarvisMemory[]> = {};
  for (const cat of MEMORY_CATEGORY_LIST) {
    grouped[cat] = [];
  }
  for (const row of getMemory()) {
    if (!grouped[row.category]) {
      grouped[row.category] = [];
    }
    grouped[row.category].push(row);
  }
  return grouped;
}

export function getMemoryStats() {
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM jarvis_memory`).get() as { c: number };
  const avgRow = db
    .prepare(`SELECT AVG(confidence) AS avg FROM jarvis_memory`)
    .get() as { avg: number | null };
  const staleRow = db
    .prepare(`SELECT COUNT(*) AS c FROM jarvis_memory WHERE confidence < 0.3`)
    .get() as { c: number };
  const flaggedRow = db
    .prepare(`SELECT COUNT(*) AS c FROM jarvis_memory WHERE flagged = 1`)
    .get() as { c: number };
  const oldest = db
    .prepare(`SELECT MIN(created_at) AS t FROM jarvis_memory`)
    .get() as { t: string | null };
  const newest = db
    .prepare(`SELECT MAX(last_seen) AS t FROM jarvis_memory`)
    .get() as { t: string | null };

  const byCategoryRows = db
    .prepare(`SELECT category, COUNT(*) AS c FROM jarvis_memory GROUP BY category`)
    .all() as Array<{ category: string; c: number }>;

  const byCategory: Record<string, number> = {};
  for (const row of byCategoryRows) {
    byCategory[row.category] = row.c;
  }

  return {
    totalMemories: totalRow.c,
    byCategory,
    avgConfidence: avgRow.avg ?? 0,
    staleCount: staleRow.c,
    flaggedCount: flaggedRow.c,
    oldestMemory: oldest.t,
    newestMemory: newest.t,
    lastDecayRun: getSystemState("last_memory_decay_run"),
    lastAuditRun: getSystemState("last_memory_audit_run")
  };
}

function ohioDateKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export function applyMemoryConfidenceDecay(): { decayed: number; removed: JarvisMemory[] } {
  const today = ohioDateKey();
  const lastRun = getSystemState("last_memory_decay_run");
  if (lastRun && lastRun.slice(0, 10) === today) {
    return { decayed: 0, removed: [] };
  }

  const placeholders = MEMORY_NEVER_DECAY.map(() => "?").join(", ");
  const decayResult = db
    .prepare(
      `
    UPDATE jarvis_memory
    SET confidence = MAX(0.1, confidence - 0.05)
    WHERE datetime(last_seen) < datetime('now', '-90 days')
      AND (last_retrieved_at IS NULL OR datetime(last_retrieved_at) < datetime('now', '-90 days'))
      AND category NOT IN (${placeholders})
      AND confidence > 0.1
  `
    )
    .run(...MEMORY_NEVER_DECAY);

  const staleRows = db
    .prepare(
      `
    SELECT * FROM jarvis_memory
    WHERE confidence < 0.1
      AND category NOT IN (${placeholders})
  `
    )
    .all(...MEMORY_NEVER_DECAY) as JarvisMemoryRow[];

  const removed = staleRows.map(mapJarvisMemoryRow);

  if (staleRows.length) {
    db.prepare(
      `
      DELETE FROM jarvis_memory
      WHERE confidence < 0.1
        AND category NOT IN (${placeholders})
    `
    ).run(...MEMORY_NEVER_DECAY);
  }

  setSystemState("last_memory_decay_run", new Date().toISOString());
  return { decayed: decayResult.changes, removed };
}

export type ExecutionLogEntry = {
  id: number;
  type: string;
  action: string;
  itemId: string | null;
  summary: string;
  result: string;
  timestamp: string;
};

type ExecutionLogRow = {
  id: number;
  type: string;
  action: string;
  item_id: string | null;
  summary: string;
  result: string;
  timestamp: string;
};

function mapExecutionLogRow(row: ExecutionLogRow): ExecutionLogEntry {
  return {
    id: row.id,
    type: row.type,
    action: row.action,
    itemId: row.item_id,
    summary: row.summary,
    result: row.result,
    timestamp: row.timestamp
  };
}

export function logExecution(entry: {
  type: string;
  action: string;
  item_id?: string | null;
  summary: string;
  result: "success" | "failed";
}) {
  db.prepare(
    `
    INSERT INTO execution_log (type, action, item_id, summary, result)
    VALUES (@type, @action, @item_id, @summary, @result)
  `
  ).run({
    type: entry.type,
    action: entry.action,
    item_id: entry.item_id ?? null,
    summary: entry.summary,
    result: entry.result
  });
}

export function getExecutionLog(since?: Date, limit = 50): ExecutionLogEntry[] {
  if (since) {
    return getExecutionLogSince(since, limit);
  }
  const rows = db
    .prepare(
      `
    SELECT id, type, action, item_id, summary, result, timestamp
    FROM execution_log
    ORDER BY id DESC
    LIMIT @limit
  `
    )
    .all({ limit }) as ExecutionLogRow[];
  return rows.map(mapExecutionLogRow);
}

export function getExecutionLogSince(since: Date, limit = 50): ExecutionLogEntry[] {
  const rows = db
    .prepare(
      `
    SELECT id, type, action, item_id, summary, result, timestamp
    FROM execution_log
    WHERE datetime(timestamp) >= datetime(@since)
    ORDER BY id DESC
    LIMIT @limit
  `
    )
    .all({ since: since.toISOString(), limit }) as ExecutionLogRow[];
  return rows.map(mapExecutionLogRow);
}

export function searchExecutionLog(query: string, limit = 20): ExecutionLogEntry[] {
  const q = `%${query.toLowerCase()}%`;
  const rows = db
    .prepare(
      `
    SELECT id, type, action, item_id, summary, result, timestamp
    FROM execution_log
    WHERE lower(summary) LIKE @q OR lower(item_id) LIKE @q OR lower(action) LIKE @q
    ORDER BY id DESC
    LIMIT @limit
  `
    )
    .all({ q, limit }) as ExecutionLogRow[];
  return rows.map(mapExecutionLogRow);
}

export function getExecutionLogToday(limit = 80): ExecutionLogEntry[] {
  const rows = db
    .prepare(
      `
    SELECT id, type, action, item_id, summary, result, timestamp
    FROM execution_log
    WHERE date(timestamp) = date('now', 'localtime')
    ORDER BY id DESC
    LIMIT @limit
  `
    )
    .all({ limit }) as ExecutionLogRow[];
  return rows.map(mapExecutionLogRow);
}

export function recordJoeActivity() {
  setSystemState("joe_last_active", new Date().toISOString());
}

export type TextLogItem = {
  id: number;
  from: string;
  preview: string;
  time: string;
  timestamp: string;
};

export function getTextsSince(internalDateAfterMs: number, limit = 40): TextLogItem[] {
  const sinceIso = new Date(internalDateAfterMs).toISOString();
  const rows = db
    .prepare(
      `
    SELECT id, from_number, from_name, body, timestamp
    FROM texts
    WHERE handled = 0 AND datetime(timestamp) > datetime(@since)
    ORDER BY id ASC
    LIMIT @limit
  `
    )
    .all({ since: sinceIso, limit }) as Array<{
    id: number;
    from_number: string | null;
    from_name: string | null;
    body: string | null;
    timestamp: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    from: row.from_name || row.from_number || "Unknown",
    preview: (row.body || "").slice(0, 200),
    time: new Date(row.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    timestamp: row.timestamp
  }));
}

export type NoteSource = "voice" | "manual";

export type Note = {
  id: number;
  content: string;
  ohioTime: string;
  createdAt: string;
  source: NoteSource;
  category: string | null;
  linkedEntities: string | null;
  promotedToMemory: number;
  seenInRundown: number;
};

type NoteRow = {
  id: number;
  content: string;
  ohio_time: string;
  created_at: string;
  source: string;
  category: string | null;
  linked_entities: string | null;
  promoted_to_memory: number;
  seen_in_rundown: number;
};

function mapNoteRow(row: NoteRow): Note {
  const source = row.source === "voice" ? "voice" : "manual";
  return {
    id: row.id,
    content: row.content,
    ohioTime: row.ohio_time,
    createdAt: row.created_at,
    source,
    category: row.category,
    linkedEntities: row.linked_entities,
    promotedToMemory: row.promoted_to_memory ?? 0,
    seenInRundown: row.seen_in_rundown ?? 0
  };
}

export function saveNote(
  content: string,
  source: NoteSource,
  ohioTime: string
): Note {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Note content is required");
  }
  const result = db
    .prepare(
      `
    INSERT INTO notes (content, ohio_time, source)
    VALUES (@content, @ohioTime, @source)
  `
    )
    .run({
      content: trimmed.slice(0, 8000),
      ohioTime: ohioTime.slice(0, 200),
      source
    });
  const row = db
    .prepare(`SELECT * FROM notes WHERE id = @id`)
    .get({ id: Number(result.lastInsertRowid) }) as NoteRow;
  return mapNoteRow(row);
}

export function updateNoteMetadata(
  id: number,
  patch: {
    category?: string | null;
    linkedEntities?: string | null;
    promotedToMemory?: number;
  }
): Note {
  if (patch.category !== undefined) {
    db.prepare(`UPDATE notes SET category = @category WHERE id = @id`).run({
      id,
      category: patch.category?.slice(0, 120) ?? null
    });
  }
  if (patch.linkedEntities !== undefined) {
    db.prepare(`UPDATE notes SET linked_entities = @linkedEntities WHERE id = @id`).run({
      id,
      linkedEntities: patch.linkedEntities
    });
  }
  if (patch.promotedToMemory !== undefined) {
    db.prepare(`UPDATE notes SET promoted_to_memory = @promoted WHERE id = @id`).run({
      id,
      promoted: patch.promotedToMemory ? 1 : 0
    });
  }
  const row = db.prepare(`SELECT * FROM notes WHERE id = @id`).get({ id }) as NoteRow;
  return mapNoteRow(row);
}

export function getRecentNotes(limit = 20): Note[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM notes ORDER BY created_at DESC LIMIT @limit
  `
    )
    .all({ limit: Math.min(Math.max(1, limit), 100) }) as NoteRow[];
  return rows.map(mapNoteRow);
}

export function searchNotes(query: string, limit = 20): Note[] {
  const q = query.trim();
  if (!q) return [];
  const rows = db
    .prepare(
      `
    SELECT * FROM notes
    WHERE content LIKE '%' || @q || '%'
    ORDER BY created_at DESC
    LIMIT @limit
  `
    )
    .all({ q: q.slice(0, 200), limit: Math.min(Math.max(1, limit), 50) }) as NoteRow[];
  return rows.map(mapNoteRow);
}

export function getUnacknowledgedNotes(sinceHours = 24): Note[] {
  const hours = Math.min(Math.max(1, sinceHours), 168);
  const rows = db
    .prepare(
      `
    SELECT * FROM notes
    WHERE seen_in_rundown = 0
      AND datetime(created_at) >= datetime('now', @offset)
    ORDER BY created_at DESC
  `
    )
    .all({ offset: `-${hours} hours` }) as NoteRow[];
  return rows.map(mapNoteRow);
}

export function markNotesSeenInRundown(ids: number[]): void {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  if (!unique.length) return;
  const stmt = db.prepare(`UPDATE notes SET seen_in_rundown = 1 WHERE id = @id`);
  for (const id of unique) {
    stmt.run({ id });
  }
}
