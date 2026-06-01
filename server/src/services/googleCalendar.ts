import { getValidAccessToken } from "./googleAuth";
import { logServiceError } from "../utils/logError";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TZ = "America/New_York";

const APPOINTMENT_EARLIEST_MINUTES = 8 * 60 + 45;
const APPOINTMENT_LATEST_MINUTES = 17 * 60;
const DEFAULT_APPOINTMENT_HOUR = 9;
const DEFAULT_APPOINTMENT_MINUTE = 0;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ohioWallParts(date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ,
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
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
}

function formatOhioLocal(year: number, month: number, day: number, hour: number, minute: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00`;
}

function isWeekendWeekday(weekday: string): boolean {
  const wd = weekday.toLowerCase();
  return wd === "sat" || wd === "sun";
}

function addOhioDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function nextBusinessDay9amFrom(from: Date): string {
  let cursor = addOhioDays(from, 1);
  for (let i = 0; i < 14; i++) {
    const parts = ohioWallParts(cursor);
    if (!isWeekendWeekday(parts.weekday)) {
      return formatOhioLocal(parts.year, parts.month, parts.day, DEFAULT_APPOINTMENT_HOUR, DEFAULT_APPOINTMENT_MINUTE);
    }
    cursor = addOhioDays(cursor, 1);
  }
  const fallback = ohioWallParts(cursor);
  return formatOhioLocal(
    fallback.year,
    fallback.month,
    fallback.day,
    DEFAULT_APPOINTMENT_HOUR,
    DEFAULT_APPOINTMENT_MINUTE
  );
}

function monday9amFromWeekend(from: Date): string {
  let cursor = addOhioDays(from, 1);
  for (let i = 0; i < 7; i++) {
    const parts = ohioWallParts(cursor);
    if (parts.weekday.toLowerCase() === "mon") {
      return formatOhioLocal(parts.year, parts.month, parts.day, DEFAULT_APPOINTMENT_HOUR, DEFAULT_APPOINTMENT_MINUTE);
    }
    cursor = addOhioDays(cursor, 1);
  }
  return nextBusinessDay9amFrom(from);
}

/** Enforce Joe's appointment window: weekdays 8:45am–5pm Ohio; default slot 9am. */
export function enforceBusinessHours(startDateTime: string): string {
  const trimmed = startDateTime.trim();
  if (!trimmed) {
    return nextBusinessDay9amFrom(new Date());
  }

  let parsed = Date.parse(toRfc3339(trimmed));
  if (!Number.isFinite(parsed)) {
    return nextBusinessDay9amFrom(new Date());
  }

  for (let attempt = 0; attempt < 14; attempt++) {
    const parts = ohioWallParts(new Date(parsed));

    if (isWeekendWeekday(parts.weekday)) {
      return monday9amFromWeekend(new Date(parsed));
    }

    const minutes = parts.hour * 60 + parts.minute;

    if (minutes < APPOINTMENT_EARLIEST_MINUTES) {
      return formatOhioLocal(parts.year, parts.month, parts.day, DEFAULT_APPOINTMENT_HOUR, DEFAULT_APPOINTMENT_MINUTE);
    }

    if (minutes >= APPOINTMENT_LATEST_MINUTES) {
      parsed = Date.parse(nextBusinessDay9amFrom(new Date(parsed)));
      continue;
    }

    return formatOhioLocal(parts.year, parts.month, parts.day, parts.hour, parts.minute);
  }

  return nextBusinessDay9amFrom(new Date());
}

export function defaultFlexibleAppointmentSlot(from = new Date()): string {
  return enforceBusinessHours(nextBusinessDay9amFrom(from));
}

export type CalendarEventResult = {
  eventId: string;
  htmlLink: string;
  status: string;
};

export type CalendarEventSummary = {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  htmlLink?: string;
  status?: string;
};

async function calendarRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T | null> {
  try {
    const token = await getValidAccessToken();
    const res = await fetch(`${CALENDAR_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers || {})
      }
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Calendar API ${res.status}: ${detail.slice(0, 300)}`);
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
  } catch (error) {
    logServiceError("GoogleCalendar", path, error);
    return null;
  }
}

function parseEventRow(item: Record<string, unknown>): CalendarEventSummary {
  const startObj = item.start as Record<string, unknown> | undefined;
  const endObj = item.end as Record<string, unknown> | undefined;
  return {
    id: String(item.id || ""),
    summary: String(item.summary || "Untitled"),
    description: item.description ? String(item.description) : undefined,
    start: String(startObj?.dateTime || startObj?.date || ""),
    end: String(endObj?.dateTime || endObj?.date || ""),
    htmlLink: item.htmlLink ? String(item.htmlLink) : undefined,
    status: item.status ? String(item.status) : undefined
  };
}

function toRfc3339(dateTime: string): string {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(dateTime)) return dateTime;
  return dateTime;
}

export async function createCalendarEvent(input: {
  summary: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  calendarId?: string;
}): Promise<CalendarEventResult | null> {
  const calendarId = encodeURIComponent(input.calendarId || "primary");
  const adjustedStart = enforceBusinessHours(input.startDateTime);
  const start = toRfc3339(adjustedStart);
  let end = toRfc3339(input.endDateTime);

  if (!end && start) {
    const startMs = Date.parse(start);
    if (Number.isFinite(startMs)) {
      end = new Date(startMs + 60 * 60 * 1000).toISOString();
    }
  } else if (start) {
    const startMs = Date.parse(start.includes("T") && !/[zZ]|[+-]\d{2}:\d{2}$/.test(start) ? `${start}-05:00` : start);
    const endMs = Date.parse(end);
    const durationMs =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
        ? endMs - startMs
        : 60 * 60 * 1000;
    if (Number.isFinite(startMs)) {
      end = new Date(startMs + durationMs).toISOString();
    }
  }

  const payload = {
    summary: input.summary.slice(0, 500),
    description: input.description.slice(0, 8000),
    start: { dateTime: start.replace(/Z$/, ""), timeZone: DEFAULT_TZ },
    end: { dateTime: end.replace(/Z$/, ""), timeZone: DEFAULT_TZ }
  };

  const result = await calendarRequest<Record<string, unknown>>(`/calendars/${calendarId}/events`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!result?.id) return null;

  return {
    eventId: String(result.id),
    htmlLink: String(result.htmlLink || ""),
    status: String(result.status || "confirmed")
  };
}

export async function getUpcomingEvents(days: number): Promise<CalendarEventSummary[] | null> {
  const calendarId = encodeURIComponent("primary");
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  const result = await calendarRequest<{ items?: Record<string, unknown>[] }>(
    `/calendars/${calendarId}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=50`
  );

  if (!result) return null;
  return (result.items || []).map((item) => parseEventRow(item));
}

export async function deleteCalendarEvent(
  eventId: string,
  calendarId = "primary"
): Promise<boolean> {
  const cal = encodeURIComponent(calendarId);
  const id = encodeURIComponent(eventId);
  const result = await calendarRequest<Record<string, never>>(`/calendars/${cal}/events/${id}`, {
    method: "DELETE"
  });
  return result !== null;
}

function eventsOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number
): boolean {
  return startA < endB && endA > startB;
}

export async function checkAvailability(
  startDateTime: string,
  endDateTime: string
): Promise<boolean | null> {
  const startMs = Date.parse(startDateTime);
  const endMs = Date.parse(endDateTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const calendarId = encodeURIComponent("primary");
  const result = await calendarRequest<{ items?: Record<string, unknown>[] }>(
    `/calendars/${calendarId}/events?timeMin=${encodeURIComponent(new Date(startMs - 60_000).toISOString())}&timeMax=${encodeURIComponent(new Date(endMs + 60_000).toISOString())}&singleEvents=true&maxResults=25`
  );

  if (!result) return null;

  for (const item of result.items || []) {
    if (String(item.status || "") === "cancelled") continue;
    const row = parseEventRow(item);
    const evStart = Date.parse(row.start);
    const evEnd = Date.parse(row.end);
    if (Number.isFinite(evStart) && Number.isFinite(evEnd) && eventsOverlap(startMs, endMs, evStart, evEnd)) {
      return false;
    }
  }

  return true;
}
