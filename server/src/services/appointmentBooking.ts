import Anthropic from "@anthropic-ai/sdk";
import { addAppointment, logExecution } from "../db/queries";
import { checkAvailability, createCalendarEvent, enforceBusinessHours, type CalendarEventResult } from "./googleCalendar";
import { findWorkingModel } from "./claude";
import { claudeCircuit } from "./circuitBreaker";
import { logServiceError } from "../utils/logError";

const OHIO_TZ = "America/New_York";

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export type AppointmentExtraction = {
  shouldBook: boolean;
  callerName: string;
  callerPhone: string;
  serviceRequested: string;
  preferredDate: string;
  preferredTime: string;
  notes: string;
  startDateTime?: string | null;
  endDateTime?: string | null;
};

const APPOINTMENT_EXTRACT_PROMPT = `Extract appointment booking details from this call transcript.
Return JSON only:
{
  "shouldBook": boolean,
  "callerName": string,
  "callerPhone": string,
  "serviceRequested": string,
  "preferredDate": string,
  "preferredTime": string,
  "notes": string,
  "startDateTime": string | null,
  "endDateTime": string | null
}
shouldBook = true only if the caller explicitly requested a consultation, quote, or appointment.
Return shouldBook: false if it was spam, vendor, or no booking was requested.
For preferredDate/time: use what was said or "flexible" if not specified.
When date/time is clear, set startDateTime/endDateTime as ISO 8601 in America/New_York (1 hour duration if end omitted).
Use null for startDateTime/endDateTime when flexible.`;

function ohioParts(date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: OHIO_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value || "";
  return {
    weekday: get("weekday"),
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day"))
  };
}

/** Next weekday at 9:00am Ohio Eastern. */
export function defaultNextWeekdaySlot(from = new Date()): { start: string; end: string } {
  let cursor = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  for (let i = 0; i < 14; i++) {
    const { weekday, year, month, day } = ohioParts(cursor);
    const wd = weekday.toLowerCase();
    if (wd !== "sat" && wd !== "sun") {
      const pad = (n: number) => String(n).padStart(2, "0");
      const start = enforceBusinessHours(`${year}-${pad(month)}-${pad(day)}T09:00:00`);
      const end = `${year}-${pad(month)}-${pad(day)}T10:00:00`;
      return { start, end };
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  const fallback = ohioParts(new Date(from.getTime() + 24 * 60 * 60 * 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const start = enforceBusinessHours(`${fallback.year}-${pad(fallback.month)}-${pad(fallback.day)}T09:00:00`);
  return { start, end: `${fallback.year}-${pad(fallback.month)}-${pad(fallback.day)}T10:00:00` };
}

function isFlexible(value: string) {
  const v = value.trim().toLowerCase();
  return !v || v === "flexible" || v === "unknown" || v === "unspecified" || v === "tbd";
}

export async function parseAppointmentFromCall(input: {
  transcript: string;
  summary: string;
  callerNumber?: string;
  callerName?: string;
}): Promise<AppointmentExtraction | null> {
  if (!anthropic) return null;

  const model = await findWorkingModel();
  if (!model) return null;

  try {
    const response = await claudeCircuit.execute("appointment-extract", () =>
      anthropic!.messages.create({
        model,
        max_tokens: 450,
        temperature: 0.1,
        system: APPOINTMENT_EXTRACT_PROMPT,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              transcript: input.transcript.slice(0, 12000),
              summary: input.summary.slice(0, 2000),
              callerNumber: input.callerNumber || "",
              callerName: input.callerName || ""
            })
          }
        ]
      })
    );

    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "{}";
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const parsed = JSON.parse(
      jsonStart >= 0 && jsonEnd >= jsonStart ? text.slice(jsonStart, jsonEnd + 1) : text
    ) as Record<string, unknown>;

    if (!parsed.shouldBook) {
      return {
        shouldBook: false,
        callerName: "",
        callerPhone: "",
        serviceRequested: "",
        preferredDate: "",
        preferredTime: "",
        notes: ""
      };
    }

    return {
      shouldBook: true,
      callerName: String(parsed.callerName || input.callerName || "Caller").trim(),
      callerPhone: String(parsed.callerPhone || input.callerNumber || "").trim(),
      serviceRequested: String(parsed.serviceRequested || "Consultation").trim(),
      preferredDate: String(parsed.preferredDate || "flexible").trim(),
      preferredTime: String(parsed.preferredTime || "flexible").trim(),
      notes: String(parsed.notes || "").trim(),
      startDateTime: parsed.startDateTime
        ? enforceBusinessHours(String(parsed.startDateTime))
        : null,
      endDateTime: parsed.endDateTime ? String(parsed.endDateTime) : null
    };
  } catch (error) {
    logServiceError("AppointmentBooking", "parseAppointmentFromCall", error);
    return null;
  }
}

async function resolveSlot(extraction: AppointmentExtraction): Promise<{ start: string; end: string }> {
  if (extraction.startDateTime && !isFlexible(extraction.preferredDate)) {
    const start = enforceBusinessHours(extraction.startDateTime);
    let end = extraction.endDateTime || "";
    if (!end) {
      const ms = Date.parse(start.includes("T") && !/[zZ]|[+-]\d{2}:\d{2}$/.test(start) ? `${start}-05:00` : start);
      end = Number.isFinite(ms)
        ? new Date(ms + 60 * 60 * 1000).toISOString()
        : defaultNextWeekdaySlot().end;
    }
    return { start, end };
  }

  if (extraction.startDateTime) {
    const start = enforceBusinessHours(extraction.startDateTime);
    const ms = Date.parse(start.includes("T") && !/[zZ]|[+-]\d{2}:\d{2}$/.test(start) ? `${start}-05:00` : start);
    const end =
      extraction.endDateTime ||
      (Number.isFinite(ms) ? new Date(ms + 3600000).toISOString() : defaultNextWeekdaySlot().end);
    return { start, end };
  }

  return defaultNextWeekdaySlot();
}

async function findAvailableSlot(
  initial: { start: string; end: string }
): Promise<{ start: string; end: string } | null> {
  for (const hours of [0, 1, 2]) {
    const startMs = Date.parse(initial.start) + hours * 60 * 60 * 1000;
    const endMs = Date.parse(initial.end) + hours * 60 * 60 * 1000;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const free = await checkAvailability(start, end);
    if (free === true) return { start, end };
  }
  return null;
}

function formatBookedSpeech(callerName: string, service: string, startIso: string): string {
  const when = new Date(startIso);
  const label = Number.isFinite(when.getTime())
    ? when.toLocaleString("en-US", {
        timeZone: OHIO_TZ,
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      })
    : startIso;
  return `Booked sir. ${callerName} — ${service} — ${label}.`;
}

export async function bookAppointmentFromExtraction(
  extraction: AppointmentExtraction,
  source: "vapi" | "chat" | "manual" = "vapi"
): Promise<{ ok: boolean; speech?: string; event?: CalendarEventResult; appointmentId?: number }> {
  if (!extraction.shouldBook) return { ok: false };

  const initial = await resolveSlot(extraction);
  const slot = await findAvailableSlot(initial);
  if (!slot) {
    logExecution({
      type: "calendar",
      action: "calendar.book_failed",
      summary: `No available slot for ${extraction.callerName} — ${extraction.serviceRequested}`,
      result: "failed"
    });
    return { ok: false };
  }

  const summary = `Totally Outdoors — ${extraction.serviceRequested} — ${extraction.callerName}`;
  const description = [
    `Client: ${extraction.callerName}`,
    `Phone: ${extraction.callerPhone || "unknown"}`,
    `Service: ${extraction.serviceRequested}`,
    `Notes: ${extraction.notes || "—"}`,
    source === "vapi"
      ? "Booked via JARVIS from incoming call"
      : `Booked via JARVIS (${source})`
  ].join("\n");

  const event = await createCalendarEvent({
    summary,
    description,
    startDateTime: slot.start,
    endDateTime: slot.end
  });

  if (!event) return { ok: false };

  const appointmentId = addAppointment({
    callerName: extraction.callerName,
    callerPhone: extraction.callerPhone || null,
    serviceRequested: extraction.serviceRequested,
    preferredDate: extraction.preferredDate || slot.start,
    notes: extraction.notes || null,
    eventId: event.eventId,
    calendarLink: event.htmlLink,
    source
  });

  const whenLabel = new Date(slot.start).toLocaleString("en-US", {
    timeZone: OHIO_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });

  logExecution({
    type: "calendar",
    action: "calendar.book",
    item_id: event.eventId,
    summary: `Booked appointment for ${extraction.callerName} — ${extraction.serviceRequested} — ${whenLabel}`,
    result: "success"
  });

  return {
    ok: true,
    speech: formatBookedSpeech(extraction.callerName, extraction.serviceRequested, slot.start),
    event,
    appointmentId
  };
}

export async function tryBookAppointmentFromVapiCall(body: unknown): Promise<void> {
  try {
    const merged =
      body && typeof body === "object"
        ? (() => {
            const root = body as Record<string, unknown>;
            const msg = root.message;
            if (msg && typeof msg === "object" && !Array.isArray(msg)) {
              return { ...root, ...(msg as Record<string, unknown>) };
            }
            return root;
          })()
        : {};

    const transcript = String(
      merged.transcript ||
        (Array.isArray(merged.messages)
          ? (merged.messages as Array<Record<string, unknown>>)
              .map((m) => `${m.role || "speaker"}: ${m.message || m.content || ""}`)
              .join("\n")
          : "")
    );
    const summary = String(
      merged.summary ||
        (merged.analysis && typeof merged.analysis === "object"
          ? (merged.analysis as Record<string, unknown>).summary
          : "") ||
        ""
    );

    const callerNumber = String(
      merged.caller_number ||
        merged.callerNumber ||
        (merged.call &&
        typeof merged.call === "object" &&
        (merged.call as Record<string, unknown>).customer
          ? ((merged.call as Record<string, unknown>).customer as Record<string, unknown>).number
          : "") ||
        ""
    );
    const callerName = String(merged.caller_name || merged.callerName || "");

    const extraction = await parseAppointmentFromCall({
      transcript,
      summary,
      callerNumber,
      callerName
    });

    if (!extraction?.shouldBook) return;
    await bookAppointmentFromExtraction(extraction, "vapi");
  } catch (error) {
    logServiceError("AppointmentBooking", "tryBookAppointmentFromVapiCall", error);
  }
}
