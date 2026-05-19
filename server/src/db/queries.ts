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
    flagReason: row.flag_reason ?? null
  };
}

export function saveMemory(input: {
  category: string;
  key: string;
  value: string;
  confidence?: number;
}) {
  const confidence = input.confidence ?? 1.0;
  db.prepare(
    `
    INSERT INTO jarvis_memory (category, key, value, confidence, occurrence_count, last_seen, created_at)
    VALUES (@category, @key, @value, @confidence, 1, datetime('now'), datetime('now'))
    ON CONFLICT(category, key) DO UPDATE SET
      value = excluded.value,
      occurrence_count = jarvis_memory.occurrence_count + 1,
      last_seen = datetime('now'),
      confidence = MIN(1.0, MAX(jarvis_memory.confidence, excluded.confidence))
  `
  ).run({
    category: input.category.slice(0, 120),
    key: input.key.slice(0, 200),
    value: input.value.slice(0, 8000),
    confidence
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
    ORDER BY id ASC
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
    ORDER BY id ASC
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
