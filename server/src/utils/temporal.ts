import type { JarvisMemory } from "../db/queries";
import { humanizeLogSummary } from "./executionSummary";

const OHIO_TZ = "America/New_York";

export function formatCurrentTimeForPrompt(now: Date = new Date()): string {
  const formatted = now.toLocaleString("en-US", {
    timeZone: OHIO_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
  return `Current time: ${formatted}`;
}

function ohioDateKey(at: Date): string {
  return at.toLocaleDateString("en-CA", { timeZone: OHIO_TZ });
}

function ohioHour(at: Date): number {
  const h = at.toLocaleString("en-US", { timeZone: OHIO_TZ, hour: "numeric", hour12: false });
  return Number.parseInt(h, 10);
}

function ohioDayDiff(from: Date, to: Date): number {
  const fromKey = ohioDateKey(from);
  const toKey = ohioDateKey(to);
  const fromMs = Date.parse(`${fromKey}T12:00:00`);
  const toMs = Date.parse(`${toKey}T12:00:00`);
  return Math.round((toMs - fromMs) / 86_400_000);
}

/** Relative age using Ohio Eastern calendar days — "today" = since midnight Ohio time. */
export function formatRelativeAge(isoOrDate: string | Date, now: Date = new Date()): string {
  const then = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(then.getTime())) return "some time ago";

  const thenDay = ohioDateKey(then);
  const nowDay = ohioDateKey(now);
  const dayDiff = ohioDayDiff(then, now);

  if (thenDay === nowDay) {
    const diffMs = Math.max(0, now.getTime() - then.getTime());
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 2) return "just now";
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;

    const thenHour = ohioHour(then);
    const nowHour = ohioHour(now);
    if (thenHour < 12 && nowHour >= 12) return "this morning";

    const diffHr = Math.floor(diffMin / 60);
    if (diffHr === 1) return "1 hour ago";
    if (diffHr < 6) return `${diffHr} hours ago`;
    return "earlier today";
  }

  if (dayDiff === 1) return "yesterday";
  if (dayDiff === 2) return "two days ago";
  if (dayDiff < 7) return `${dayDiff} days ago`;
  if (dayDiff < 14) return "last week";
  if (dayDiff < 30) return `${Math.floor(dayDiff / 7)} weeks ago`;
  return then.toLocaleDateString("en-US", { timeZone: OHIO_TZ, month: "long", day: "numeric" });
}

export function formatMemoryLine(memory: JarvisMemory): string {
  const age = formatRelativeAge(memory.lastSeen);
  const prefix =
    age === "this morning" || age === "earlier today" || age === "just now"
      ? `Remembered ${age}`
      : age === "yesterday" || age.endsWith("ago") || age === "last week" || age.includes("weeks ago")
        ? `Remembered ${age}`
        : `Remembered on ${age}`;
  return `${prefix}: ${memory.category} — ${memory.key} = ${memory.value}`;
}

export function formatExecutionLogLine(summary: string, timestamp: string): string {
  const age = formatRelativeAge(timestamp);
  const label = age.charAt(0).toUpperCase() + age.slice(1);
  const human = humanizeLogSummary(summary || "Action logged");
  return `${label}: ${human}`;
}

export function formatBriefingTimePhrase(hoursElapsed: number): string {
  if (hoursElapsed < 6) return "This morning";
  if (hoursElapsed < 24) return "Today";
  if (hoursElapsed < 48) return "Since yesterday";
  return `In the last ${Math.round(hoursElapsed)} hours`;
}

/** Spoken greeting for activation briefing (Ohio Eastern). */
export function getOhioTimeOfDayGreeting(now: Date = new Date()): string {
  const h = ohioHour(now);
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  return "Evening sir";
}

/** Natural elapsed phrase since Joe was last active (e.g. "4 hours", "2 days"). */
export function formatElapsedSinceActive(lastActive: Date | null, now: Date = new Date()): string {
  if (!lastActive || Number.isNaN(lastActive.getTime())) return "some time";
  const diffMs = Math.max(0, now.getTime() - lastActive.getTime());
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return "a few minutes";
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? "1 hour" : `${hrs} hours`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "1 day" : `${days} days`;
}
