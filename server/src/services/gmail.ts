import { clearGmailAuthAlertIfPresent } from "../db/queries";
import { getGmailAccessToken } from "./googleAuth";
import { gmailCircuit, CircuitOpenError } from "./circuitBreaker";
import { logServiceError } from "../utils/logError";
import { gmailLog } from "../utils/requestLog";
import { sanitizeEmailBody } from "../utils/emailBody";

type GmailListResponse = {
  messages?: Array<{ id: string; threadId: string }>;
};

type GmailMessageResponse = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    mimeType?: string;
    body?: { data?: string; size?: number };
    parts?: GmailMessagePart[];
  };
};

type GmailMessagePart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
};

type GmailProfileResponse = {
  emailAddress: string;
};

type GmailSendResponse = {
  id: string;
  threadId: string;
  labelIds?: string[];
};

export type GmailSummaryItem = {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  snippet: string;
  time: string;
  internalDate: number;
  priority: "HIGH" | "NORMAL" | "SPAM";
  action: string;
};

async function gmailFetch<T>(path: string) {
  return gmailCircuit.execute(`GET ${path}`, async () => {
    const accessToken = await getGmailAccessToken();
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const payload = (await response.json()) as T & {
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(
        payload.error?.message || `Gmail API request failed with ${response.status}`
      );
    }

    return payload;
  });
}

async function gmailPost<T>(path: string, body: unknown) {
  return gmailCircuit.execute(`POST ${path}`, async () => {
    const accessToken = await getGmailAccessToken();
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = (await response.json()) as T & {
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(
        payload.error?.message || `Gmail API request failed with ${response.status}`
      );
    }

    return payload;
  });
}

export function resetGmailCircuit(): void {
  gmailCircuit.reset();
}

export function isGmailCircuitOpen(): boolean {
  return gmailCircuit.isOpen();
}

export { CircuitOpenError };

function getHeader(message: GmailMessageResponse, name: string) {
  return (
    message.payload?.headers?.find(
      (header) => header.name.toLowerCase() === name.toLowerCase()
    )?.value || ""
  );
}

function formatMessageTime(internalDate?: string) {
  if (!internalDate) return "";

  return new Date(Number(internalDate)).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function encodeBase64Url(value: string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sanitizeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const NOTIFICATION_SENDER_MARKERS = [
  "jobtread",
  "noreply",
  "no-reply",
  "notifications",
  "mailer"
];

const EMAIL_IN_TEXT =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** True when the From address is a CRM/notification relay, not the real contact. */
export function isNotificationSender(fromHeader: string): boolean {
  const raw = fromHeader.toLowerCase();
  const email = (extractEmailAddress(fromHeader) || fromHeader).toLowerCase();
  return NOTIFICATION_SENDER_MARKERS.some(
    (marker) => raw.includes(marker) || email.includes(marker)
  );
}

/** Parse bare email from "Name <email@domain.com>" or return trimmed input if already an email. */
export function extractEmailAddress(fromHeader: string): string | null {
  const trimmed = fromHeader.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^>]+@[^>]+)>/);
  if (angle?.[1]) return angle[1].trim().toLowerCase();
  const bare = trimmed.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  return bare ? bare[0].toLowerCase() : null;
}

function isBlockedReplyAddress(email: string): boolean {
  const lower = email.toLowerCase();
  if (isNotificationSender(lower)) return true;
  if (lower.includes("totallyoutdoors@gmail.com")) return true;
  return false;
}

/** Extract the real human sender from forwarded/notification email body text. */
export function extractRealSenderFromBody(text: string): string | null {
  if (!text?.trim()) return null;

  const replyToMatch = text.match(
    /reply[- ]?to:\s*(?:<([^>]+@[^>]+)>|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}))/i
  );
  if (replyToMatch) {
    const candidate = (replyToMatch[1] || replyToMatch[2] || "").trim().toLowerCase();
    if (candidate && !isBlockedReplyAddress(candidate)) return candidate;
  }

  const fromLineMatch = text.match(
    /^from:\s*(?:[^<\n]*<([^>]+@[^>]+)>|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}))/im
  );
  if (fromLineMatch) {
    const candidate = (fromLineMatch[1] || fromLineMatch[2] || "").trim().toLowerCase();
    if (candidate && !isBlockedReplyAddress(candidate)) return candidate;
  }

  const contactMatch = text.match(
    /(?:contact|customer|client|sender|email)[:\s]+<?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/i
  );
  if (contactMatch?.[1]) {
    const candidate = contactMatch[1].trim().toLowerCase();
    if (!isBlockedReplyAddress(candidate)) return candidate;
  }

  const seen = new Set<string>();
  for (const match of text.matchAll(EMAIL_IN_TEXT)) {
    const email = match[0].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    if (!isBlockedReplyAddress(email)) return email;
  }

  return null;
}

function decodeBase64UrlBody(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function extractTextFromParts(part: GmailMessagePart | undefined): string {
  if (!part) return "";
  if (part.body?.data) {
    try {
      return decodeBase64UrlBody(part.body.data);
    } catch {
      return "";
    }
  }
  if (part.parts?.length) {
    const plain = part.parts.find((p) => p.mimeType === "text/plain");
    if (plain) return extractTextFromParts(plain);
    return part.parts.map((p) => extractTextFromParts(p)).filter(Boolean).join("\n");
  }
  return "";
}

export async function getMessageBody(messageId: string): Promise<string> {
  if (!messageId) return "";
  try {
    const message = await gmailFetch<GmailMessageResponse>(
      `/users/me/messages/${messageId}?format=full`
    );
    const headerText = (message.payload?.headers || [])
      .map((h) => `${h.name}: ${h.value}`)
      .join("\n");
    const bodyText = extractTextFromParts(message.payload);
    const snippet = message.snippet || "";
    return [headerText, bodyText, snippet].filter(Boolean).join("\n\n");
  } catch (error) {
    logServiceError("Gmail", "getMessageBody", error);
    return "";
  }
}

function normalizeReadableEmailText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/^[\w-]+:\s*.+$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when inbound email has enough readable content to reply intelligently. */
export async function hasReadableInboundEmailContent(input: {
  messageId: string;
  snippet?: string;
  subject?: string;
}): Promise<boolean> {
  const snippet = normalizeReadableEmailText(input.snippet || "");
  const subject = normalizeReadableEmailText(input.subject || "");

  let bodyText = "";
  if (input.messageId) {
    try {
      const message = await gmailFetch<GmailMessageResponse>(
        `/users/me/messages/${input.messageId}?format=full`
      );
      bodyText = normalizeReadableEmailText(extractTextFromParts(message.payload));
    } catch {
      bodyText = "";
    }
  }

  const combined = [subject, snippet, bodyText].filter(Boolean).join(" ").trim();
  if (combined.length < 20) return false;

  const words = combined.split(/\s+/).filter((w) => /[a-zA-Z]{2,}/.test(w));
  return words.length >= 4;
}

export async function resolveReplyRecipient(input: {
  fromHeader: string;
  messageId: string;
  snippet?: string;
}): Promise<{ to: string | null; isNotification: boolean }> {
  const direct = extractEmailAddress(input.fromHeader) || input.fromHeader.trim();
  if (!isNotificationSender(input.fromHeader)) {
    return { to: direct || null, isNotification: false };
  }

  const bodyParts = [input.snippet || ""];
  if (input.messageId) {
    bodyParts.push(await getMessageBody(input.messageId));
  }
  const real = extractRealSenderFromBody(bodyParts.join("\n\n"));
  return { to: real, isNotification: true };
}

function buildReplySubject(subject: string) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function classifyEmail(item: {
  from: string;
  subject: string;
  snippet: string;
}): Pick<GmailSummaryItem, "priority" | "action"> {
  const haystack = `${item.from} ${item.subject} ${item.snippet}`.toLowerCase();

  if (
    haystack.includes("unsubscribe") ||
    haystack.includes("promotion") ||
    haystack.includes("limited time") ||
    haystack.includes("sale")
  ) {
    return { priority: "SPAM", action: "Filtered" };
  }

  if (
    haystack.includes("quote") ||
    haystack.includes("approval") ||
    haystack.includes("invoice") ||
    haystack.includes("urgent") ||
    haystack.includes("schedule") ||
    haystack.includes("crew")
  ) {
    return { priority: "HIGH", action: "Review today" };
  }

  return { priority: "NORMAL", action: "No immediate action" };
}

const GMAIL_LIST_MAX_RESULTS = 50;
const GMAIL_METADATA_BATCH_SIZE = 5;
const GMAIL_METADATA_BATCH_DELAY_MS = 200;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fourteenDaysAgoMs() {
  return Date.now() - FOURTEEN_DAYS_MS;
}

function mapMessageToSummary(message: GmailMessageResponse): GmailSummaryItem {
  const item = {
    id: message.id,
    threadId: message.threadId,
    from: getHeader(message, "From") || "Unknown sender",
    subject: getHeader(message, "Subject") || "No subject",
    snippet: message.snippet || "",
    time: formatMessageTime(message.internalDate),
    internalDate: Number(message.internalDate) || 0,
    priority: "NORMAL" as const,
    action: "No immediate action"
  };
  const classification = classifyEmail(item);
  return { ...item, ...classification };
}

async function fetchMessageMetadataBatch(ids: string[]) {
  const messages: GmailMessageResponse[] = [];
  for (const id of ids) {
    messages.push(
      await gmailFetch<GmailMessageResponse>(
        `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`
      )
    );
  }
  return messages;
}

async function listGmailMessageSummaries(maxResults = GMAIL_LIST_MAX_RESULTS) {
  const startedAt = Date.now();
  const list = await gmailFetch<GmailListResponse>(
    `/users/me/messages?maxResults=${maxResults}`
  );

  const ids = (list.messages || []).map((message) => message.id);
  const messages: GmailMessageResponse[] = [];

  for (let i = 0; i < ids.length; i += GMAIL_METADATA_BATCH_SIZE) {
    const batch = ids.slice(i, i + GMAIL_METADATA_BATCH_SIZE);
    messages.push(...(await fetchMessageMetadataBatch(batch)));
    if (i + GMAIL_METADATA_BATCH_SIZE < ids.length) {
      await sleep(GMAIL_METADATA_BATCH_DELAY_MS);
    }
  }

  const summaries = messages.map(mapMessageToSummary);
  clearGmailAuthAlertIfPresent();
  gmailLog(`fetched ${summaries.length} messages — ${Date.now() - startedAt}ms`);
  return summaries;
}

function messageInternalDate(item: GmailSummaryItem) {
  return item.internalDate ?? 0;
}

export async function getRecentGmailMessages(limit = 8) {
  const cutoff = fourteenDaysAgoMs();
  const recent = (await listGmailMessageSummaries())
    .filter((item) => messageInternalDate(item) >= cutoff)
    .sort((a, b) => messageInternalDate(b) - messageInternalDate(a))
    .slice(0, limit);

  return recent;
}

export async function getGmailMessagesSince(internalDateAfterMs: number, limit = 40) {
  const cutoff = fourteenDaysAgoMs();
  const enriched = (await listGmailMessageSummaries())
    .filter((item) => {
      const internalDate = messageInternalDate(item);
      return internalDate > internalDateAfterMs && internalDate >= cutoff;
    })
    .sort((a, b) => messageInternalDate(a) - messageInternalDate(b))
    .slice(0, limit);

  return enriched;
}

export async function archiveGmailMessage(messageId: string) {
  const startedAt = Date.now();
  const result = await gmailPost<{ id: string }>(`/users/me/messages/${messageId}/modify`, {
    removeLabelIds: ["INBOX"]
  });
  gmailLog(`archived 1 message — ${Date.now() - startedAt}ms`);
  return result;
}

export async function sendGmailReply(input: {
  messageId: string;
  threadId?: string;
  to: string;
  subject: string;
  body: string;
  snippet?: string;
}) {
  const body = sanitizeEmailBody(input.body);
  if (!body) {
    throw new Error("Email body is empty or contains only operator commentary");
  }

  let toAddress = input.to;
  if (isNotificationSender(input.to)) {
    const resolved = await resolveReplyRecipient({
      fromHeader: input.to,
      messageId: input.messageId,
      snippet: input.snippet
    });
    if (!resolved.to) {
      throw new Error(
        "Cannot reply — notification/relay sender with no extractable real contact email"
      );
    }
    toAddress = resolved.to;
  } else {
    const parsed = extractEmailAddress(input.to);
    if (parsed) toAddress = parsed;
  }

  const profile = await gmailFetch<GmailProfileResponse>("/users/me/profile");
  const subject = buildReplySubject(input.subject || "No subject");
  const to = sanitizeHeader(toAddress);
  const from = sanitizeHeader(profile.emailAddress);

  const rawMessage = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${sanitizeHeader(subject)}`,
    `In-Reply-To: ${sanitizeHeader(input.messageId)}`,
    `References: ${sanitizeHeader(input.messageId)}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    body
  ].join("\r\n");

  const startedAt = Date.now();
  const result = await gmailPost<GmailSendResponse>("/users/me/messages/send", {
    raw: encodeBase64Url(rawMessage),
    threadId: input.threadId
  });
  gmailLog(`sent reply — ${Date.now() - startedAt}ms`);
  return result;
}
