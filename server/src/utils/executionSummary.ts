import type { ExecutionLogEntry } from "../db/queries";

const HEX_ID = /\b[a-f0-9]{12,}\b/gi;
const LOG_PREFIX = /^\[(Claude|Gmail|Brave)\]/i;

export function isOperatorFacingLog(log: ExecutionLogEntry): boolean {
  if (log.type === "system") return false;
  if (log.action?.startsWith("circuit.")) return false;
  if (LOG_PREFIX.test(log.summary || "")) return false;
  if (/circuit\.(open|closed|rate_limit)/i.test(log.summary || "")) return false;
  return true;
}

export function stripHexIds(text: string): string {
  return text.replace(HEX_ID, "a message").replace(/\s+/g, " ").trim();
}

export function humanizeLogSummary(summary: string): string {
  let s = stripHexIds(summary);
  s = s.replace(/^Archived\s+a message\.?$/i, "Archived a spam email");
  s = s.replace(/^Archived\s+/i, "Archived email ");
  return s;
}

export function buildExecutionSummarySpeech(logs: ExecutionLogEntry[]): string {
  const filtered = logs.filter(isOperatorFacingLog);
  if (!filtered.length) {
    return "Nothing logged autonomously in that window yet, sir.";
  }

  const autoHandleActions = new Set([
    "draft_and_send",
    "send_reply",
    "email.send_reply",
    "archive",
    "email.archive"
  ]);

  let archived = 0;
  let sent = 0;
  let brave = 0;
  let queued = 0;
  let other = 0;

  for (const row of filtered) {
    if (row.result !== "success") continue;
    const action = row.action || "";
    if (action === "archive" || action === "email.archive") archived += 1;
    else if (autoHandleActions.has(action) && action !== "archive" && action !== "email.archive")
      sent += 1;
    else if (action === "brave.search") brave += 1;
    else if (action.startsWith("queue.") || action === "brain.cycle") queued += 1;
    else other += 1;
  }

  const parts: string[] = [];
  if (archived) parts.push(`archived ${archived} email${archived === 1 ? "" : "s"}`);
  if (sent) parts.push(`sent or handled ${sent} email${sent === 1 ? "" : "s"}`);
  if (brave) parts.push(`ran ${brave} live search${brave === 1 ? "" : "es"}`);
  if (queued) parts.push(`processed ${queued} queue action${queued === 1 ? "" : "s"}`);
  if (other) parts.push(`${other} other action${other === 1 ? "" : "s"}`);

  if (!parts.length) {
    return `I logged ${filtered.length} action${filtered.length === 1 ? "" : "s"} in that period, sir.`;
  }

  const prefix =
    filtered.length > parts.reduce((n, p) => n + 1, 0)
      ? `Since then, sir: `
      : "Sir, ";
  return `${prefix}${parts.join(", ")}.`;
}

export function executionLogWindowMs(message: string): number {
  const t = message.toLowerCase();
  if (/\b(last night|overnight|while i slept|while you were running)\b/.test(t)) {
    return 24 * 60 * 60 * 1000;
  }
  if (/\b(today|this morning|so far today)\b/.test(t)) {
    return 24 * 60 * 60 * 1000;
  }
  return 24 * 60 * 60 * 1000;
}
