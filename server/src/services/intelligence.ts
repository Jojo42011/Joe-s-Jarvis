import {
  addToQueue,
  getCallsAfterRowId,
  getLastCallIntelCursor,
  getSystemState,
  pendingQueueItemExists,
  setLastCallIntelCursor,
  setSystemState,
  setActiveAlertState
} from "../db/queries";
import { triageInboundItem, type TriageDecision } from "./claude";
import { archiveGmailMessage, getGmailMessagesSince } from "./gmail";

let loopRunning = false;

function defaultEmailSinceMs(): number {
  const raw = getSystemState("last_email_check");
  if (!raw) {
    return Date.now() - 60 * 60 * 1000;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return Date.now() - 60 * 60 * 1000;
  }
  return parsed;
}

type EmailForIntel = Awaited<ReturnType<typeof getGmailMessagesSince>>[number];

type CallForIntel = ReturnType<typeof getCallsAfterRowId>[number];

function buildEmailPayload(email: EmailForIntel) {
  return JSON.stringify({
    id: email.id,
    threadId: email.threadId,
    from: email.from,
    subject: email.subject,
    snippet: email.snippet,
    priority: email.priority,
    time: email.time
  });
}

function buildCallPayload(call: CallForIntel) {
  return JSON.stringify({
    id: call.id,
    from: call.from,
    reason: call.reason,
    outcome: call.outcome,
    transcript: call.transcript,
    priorityLevel: call.priorityLevel,
    duration: call.duration,
    time: call.time
  });
}

async function applyTriageResult(
  type: "email" | "call",
  sourceId: string,
  triage: TriageDecision,
  email: EmailForIntel | null,
  _call: CallForIntel | null
) {
  const { action, urgency, summary, action_needed: actionNeeded, draft } = triage;

  if (action === "IGNORE") {
    return;
  }

  if (action === "HANDLE" && type === "email" && email) {
    try {
      await archiveGmailMessage(email.id);
    } catch (error) {
      console.warn("[intelligence] Gmail archive failed (check gmail.modify scope):", error);
    }
    return;
  }

  if (action === "HANDLE") {
    return;
  }

  const rawPayload = {
    triage,
    draft: draft || null,
    email: email || undefined,
    call: _call || undefined
  };
  const raw = JSON.stringify(rawPayload);

  if (action === "ESCALATE") {
    const queueId = addToQueue({
      type,
      source_id: sourceId,
      summary,
      action_needed: actionNeeded || "Immediate attention required",
      urgency: "NOW",
      handled: false,
      raw_data: raw
    });
    setActiveAlertState({
      hasAlert: true,
      queueId,
      summary: summary || "Escalation"
    });
    return;
  }

  let queueUrgency = urgency;
  if (action === "DRAFT_REPLY") {
    if (!queueUrgency || queueUrgency === "NONE") {
      queueUrgency = "TODAY";
    }
  } else if (action === "LOG_ONLY") {
    if (!queueUrgency || queueUrgency === "NONE") {
      queueUrgency = "THIS_WEEK";
    }
  }

  addToQueue({
    type,
    source_id: sourceId,
    summary,
    action_needed:
      actionNeeded ||
      (action === "DRAFT_REPLY" ? "Review draft and send when approved" : null),
    urgency: queueUrgency,
    handled: false,
    raw_data: raw
  });
}

async function processEmailBatch() {
  const sinceMs = defaultEmailSinceMs();
  let maxInternal = sinceMs;
  let emails: EmailForIntel[] = [];

  try {
    emails = await getGmailMessagesSince(sinceMs, 40);
  } catch (error) {
    console.warn("[intelligence] Gmail poll skipped:", error);
    return;
  }

  for (const email of emails) {
    const sourceId = `gmail:${email.id}`;
    if (pendingQueueItemExists("email", sourceId)) {
      maxInternal = Math.max(maxInternal, email.internalDate);
      continue;
    }

    const triage = await triageInboundItem("email", buildEmailPayload(email));
    maxInternal = Math.max(maxInternal, email.internalDate);
    await applyTriageResult("email", sourceId, triage, email, null);
  }

  setSystemState("last_email_check", new Date(maxInternal).toISOString());
}

async function processCallBatch() {
  const lastId = getLastCallIntelCursor();
  const calls = getCallsAfterRowId(lastId, 40);
  if (!calls.length) {
    setSystemState("last_call_check", new Date().toISOString());
    return;
  }

  let maxId = lastId;

  for (const call of calls) {
    maxId = Math.max(maxId, call.id);
    const sourceId = `call:${call.id}`;
    if (pendingQueueItemExists("call", sourceId)) {
      continue;
    }

    const triage = await triageInboundItem("vapi_call", buildCallPayload(call));
    await applyTriageResult("call", sourceId, triage, null, call);
  }

  setLastCallIntelCursor(maxId);
  const lastTs = calls[calls.length - 1]?.timestamp;
  setSystemState("last_call_check", lastTs || new Date().toISOString());
}

export async function runIntelligenceLoop() {
  if (loopRunning) {
    console.log("[intelligence] tick skipped — previous run still active");
    return;
  }

  loopRunning = true;
  try {
    await processEmailBatch();
    await processCallBatch();
  } catch (error) {
    console.error("[intelligence] loop error:", error);
  } finally {
    loopRunning = false;
  }
}
