import type { PriorityContact } from "../db/queries";

const joePrivateNumber = process.env.JOE_PRIVATE_NUMBER || "";

/** Vapi often wraps events in `{ message: { type, ... } }`; merge for parsers. */
export function mergeVapiBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};

  const root = body as Record<string, unknown>;
  const msg = root.message;
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    return { ...root, ...(msg as Record<string, unknown>) };
  }

  return root;
}

function nestedValue(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

function readPhoneNumber(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.number === "string" && parsed.number.trim()) {
          return parsed.number.trim();
        }
      } catch {
        return null;
      }
    }
    return trimmed;
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const num = (value as Record<string, unknown>).number;
    if (typeof num === "string" && num.trim()) return num.trim();
  }

  return null;
}

/** Extract E.164 or raw phone string from a Vapi webhook payload. */
export function extractCallerNumberFromVapiPayload(body: unknown): string {
  const payload = mergeVapiBody(body);

  const candidates = [
    nestedValue(payload, "call.customer.number"),
    nestedValue(payload, "customer.number"),
    nestedValue(payload, "phoneNumber.number"),
    payload.phoneNumber,
    payload.from
  ];

  for (const candidate of candidates) {
    const number = readPhoneNumber(candidate);
    if (number) return number;
  }

  return "Unknown";
}

export const vapiAgentConfig = {
  name: "JARVIS",
  firstMessage: "Joe Stewart's office. Who's calling and what can I help you with?",
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: `You are JARVIS, Joe Stewart's personal AI assistant and gatekeeper.

Joe runs a multimillion dollar landscaping business in Ohio. Your job is to screen every caller professionally and protect Joe's time.

SCREENING RULES:

Priority — forward to Joe immediately:
- Anyone already in Joe's contacts
- Existing clients calling about active jobs
- Family members
- His foreman or crew leads
- Anyone calling about an urgent job site issue

Take a message — log and notify Joe:
- New potential clients wanting a quote
- Vendors and suppliers
- Legitimate business inquiries
- Anyone who sounds professional and has a real reason

Terminate politely:
- Obvious spam or robocalls
- Sales pitches for services Joe doesn't need
- Repeated unknown callers with no clear purpose
- Anyone who refuses to give their name or reason

CONVERSATION STYLE:
- Professional, warm, efficient
- You represent Joe's business
- Never reveal Joe's private number
- Never confirm or deny Joe's availability until you've screened the caller
- Get: full name, company if applicable, reason for calling, urgency level
- Maximum 3-4 exchanges to make a decision
- If taking a message get a callback number

After screening respond with a JSON action:
{
  "action": "forward" | "message" | "terminate",
  "priority": "high" | "medium" | "low",
  "summary": "one sentence of who and why",
  "caller_name": "",
  "caller_reason": "",
  "callback_number": ""
}`
  },
  voice: {
    provider: "elevenlabs",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    stability: 0.75,
    similarityBoost: 0.85
  },
  endCallFunctionEnabled: true,
  recordingEnabled: true,
  transcriptPlan: {
    enabled: true
  }
};

export function buildVapiAgentConfig(input: {
  callerNumber?: string | null;
  priorityContact?: PriorityContact | null;
}) {
  const contextLines = [
    `Incoming caller number: ${input.callerNumber || "unknown"}.`,
    input.priorityContact
      ? `Priority contact match: ${input.priorityContact.name || "Unnamed"} (${input.priorityContact.relationship || "priority contact"}). Always forward: ${input.priorityContact.alwaysForward ? "yes" : "no"}.`
      : "No priority contact match found."
  ];

  return {
    ...vapiAgentConfig,
    model: {
      ...vapiAgentConfig.model,
      systemPrompt: `${vapiAgentConfig.model.systemPrompt}

LIVE CALL CONTEXT:
${contextLines.join("\n")}

If this is a matched priority contact and always_forward is true, screen briefly, mark priority high, and choose action "forward".`
    },
    forwardingPhoneNumber: joePrivateNumber || undefined,
    metadata: {
      callerNumber: input.callerNumber || null,
      priorityContactId: input.priorityContact?.id || null
    }
  };
}
