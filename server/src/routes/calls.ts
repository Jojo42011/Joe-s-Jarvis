import { Router, type Response } from "express";
import {
  addCallLog,
  addPriorityContact,
  findPriorityContactByPhone,
  getPriorityContacts,
  getRecentCalls,
  setState
} from "../db/queries";
import { buildVapiAgentConfig } from "../services/vapi";
import { tryBookAppointmentFromVapiCall } from "../services/appointmentBooking";

export const callsRouter = Router();

function scheduleVapiAppointmentBooking(body: unknown) {
  setImmediate(() => {
    void tryBookAppointmentFromVapiCall(body);
  });
}

/** Vapi often wraps events in `{ message: { type, ... } }`; merge for parsers. */
function mergeVapiBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};

  const root = body as Record<string, unknown>;
  const msg = root.message;
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    return { ...root, ...(msg as Record<string, unknown>) };
  }

  return root;
}

function getVapiEventType(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  if (typeof root.type === "string") return root.type;
  const msg = root.message;
  if (msg && typeof msg === "object" && typeof (msg as Record<string, unknown>).type === "string") {
    return (msg as Record<string, unknown>).type as string;
  }
  return undefined;
}

function getNestedValue(source: unknown, paths: string[]) {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((current, key) => {
      if (!current || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[key];
    }, source);

    if (value !== undefined && value !== null && value !== "") return value;
  }

  return undefined;
}

function asString(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getCallerNumber(body: unknown) {
  return asString(
    getNestedValue(body, [
      "caller_number",
      "callerNumber",
      "from",
      "phoneNumber",
      "call.customer.number",
      "customer.number",
      "message.call.customer.number",
      "message.customer.number"
    ])
  );
}

function extractTranscript(body: unknown) {
  const transcript = getNestedValue(body, [
    "transcript",
    "artifact.transcript",
    "call.transcript",
    "message.transcript",
    "messages",
    "artifact.messages"
  ]);

  if (Array.isArray(transcript)) {
    return transcript
      .map((entry) => {
        if (!entry || typeof entry !== "object") return String(entry);
        const row = entry as Record<string, unknown>;
        const role = row.role || row.speaker || "speaker";
        const message = row.message || row.content || row.text || "";
        return `${role}: ${message}`;
      })
      .join("\n");
  }

  return asString(transcript);
}

function extractJsonAction(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};

  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeOutcome(action: unknown) {
  const value = asString(action).toLowerCase();
  if (value === "forward" || value === "forwarded") return "FORWARDED";
  if (value === "terminate" || value === "blocked" || value === "block") return "BLOCKED";
  return "MESSAGE";
}

function parseWebhookOutcome(body: unknown) {
  const merged = mergeVapiBody(body);
  const transcript = extractTranscript(merged);
  const analysis = getNestedValue(merged, [
    "analysis",
    "artifact.analysis",
    "structuredData",
    "structured_data",
    "message.analysis"
  ]);
  const actionJson = {
    ...(analysis && typeof analysis === "object" ? (analysis as Record<string, unknown>) : {}),
    ...extractJsonAction(transcript)
  };

  const summary =
    asString(actionJson.summary) ||
    asString(getNestedValue(merged, ["summary", "analysis.summary", "call.summary"])) ||
    "Call screened by JARVIS.";
  const callerName =
    asString(actionJson.caller_name || actionJson.callerName) ||
    asString(getNestedValue(merged, ["caller_name", "callerName", "call.customer.name", "customer.name"]));
  const callerReason =
    asString(actionJson.caller_reason || actionJson.callerReason || actionJson.reason) || summary;
  const callerNumber =
    getCallerNumber(merged) || asString(actionJson.callback_number || actionJson.callbackNumber);
  const durationSeconds =
    asNumber(
      getNestedValue(merged, [
        "duration_seconds",
        "durationSeconds",
        "duration",
        "call.durationSeconds",
        "call.durationMs",
        "message.durationSeconds"
      ])
    ) ??
    (() => {
      const ms = asNumber(getNestedValue(merged, ["durationMs", "call.durationMs"]));
      return ms != null ? Math.round(ms / 1000) : null;
    })();
  const outcome = normalizeOutcome(actionJson.action || getNestedValue(merged, ["outcome", "call.outcome"]));
  const priorityLevel = asString(actionJson.priority || getNestedValue(merged, ["priority", "call.priority"]));
  const forwardedTo = outcome === "FORWARDED" ? process.env.JOE_PRIVATE_NUMBER || null : null;

  return {
    callerNumber,
    callerName,
    callReason: callerReason,
    transcript,
    outcome,
    durationSeconds,
    priorityLevel,
    forwardedTo
  };
}

function logCall(body: unknown) {
  const parsed = parseWebhookOutcome(body);
  const call = addCallLog(parsed);
  const recentCalls = getRecentCalls(20);

  setState("default", {
    activePanel: "calls",
    activeItems: recentCalls,
    selectedItem: call,
    lastIntent: "call.webhook"
  });

  return call;
}

function respondAssistantConfig(reqBody: unknown, res: Response) {
  const merged = mergeVapiBody(reqBody);
  const callerNumber = getCallerNumber(merged);
  const priorityContact = findPriorityContactByPhone(callerNumber);
  const config = buildVapiAgentConfig({ callerNumber, priorityContact });

  res.json({
    assistant: config,
    priorityContact,
    shouldForwardImmediately: Boolean(priorityContact?.alwaysForward)
  });
}

callsRouter.post("/calls/incoming", (req, res) => {
  try {
    const type = getVapiEventType(req.body);

    if (type === "end-of-call-report") {
      logCall(req.body);
      scheduleVapiAppointmentBooking(req.body);
      return res.json({ received: true });
    }

    if (type === "transcript") {
      return res.json({ received: true });
    }

    if (type === "status-update") {
      return res.json({ received: true });
    }

    if (type === "function-call") {
      return res.json({ received: true });
    }

    if (type === "hang" || type === "speech-update" || type === "voice-input" || type === "model-output") {
      return res.json({ received: true });
    }

    if (type === "assistant-request") {
      return respondAssistantConfig(req.body, res);
    }

    return respondAssistantConfig(req.body, res);
  } catch (error) {
    console.error("/api/calls/incoming error:", error);
    res.status(500).json({
      error: "incoming handler failed",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

callsRouter.post("/calls/webhook", (req, res) => {
  try {
    const type = getVapiEventType(req.body);
    if (type === "end-of-call-report" || !type) {
      const call = logCall(req.body);
      scheduleVapiAppointmentBooking(req.body);
      return res.json({
        received: true,
        status: "logged",
        call
      });
    }

    return res.json({ received: true, status: "ignored", type });
  } catch (error) {
    console.error("/api/calls/webhook error:", error);
    res.status(500).json({
      error: "webhook failed",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

callsRouter.get("/calls/log", (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  res.json({
    status: "ready",
    calls: getRecentCalls(limit)
  });
});

callsRouter.post("/calls/contacts", (req, res) => {
  const contact = addPriorityContact({
    name: req.body?.name,
    phoneNumber: req.body?.phoneNumber || req.body?.phone_number,
    relationship: req.body?.relationship,
    alwaysForward: req.body?.alwaysForward ?? req.body?.always_forward
  });

  res.status(201).json({
    status: "created",
    contact
  });
});

callsRouter.get("/calls/contacts", (_req, res) => {
  res.json({
    status: "ready",
    contacts: getPriorityContacts()
  });
});
