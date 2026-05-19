import { getGmailAccessToken } from "./googleAuth";
import { gmailCircuit, CircuitOpenError } from "./circuitBreaker";
import { logServiceError } from "../utils/logError";

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
  };
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
  internalDate?: number;
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

export async function getRecentGmailMessages(limit = 8) {
  const list = await gmailFetch<GmailListResponse>(
    `/users/me/messages?maxResults=${limit}&q=${encodeURIComponent("newer_than:14d")}`
  );

  const messages = await Promise.all(
    (list.messages || []).map((message) =>
      gmailFetch<GmailMessageResponse>(
        `/users/me/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`
      )
    )
  );

  return messages.map((message) => {
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

    return {
      ...item,
      ...classification
    };
  });
}

export async function getGmailMessagesSince(internalDateAfterMs: number, limit = 40) {
  const list = await gmailFetch<GmailListResponse>(
    `/users/me/messages?maxResults=50&q=${encodeURIComponent("newer_than:14d")}`
  );

  const messages = await Promise.all(
    (list.messages || []).map((message) =>
      gmailFetch<GmailMessageResponse>(
        `/users/me/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`
      )
    )
  );

  const enriched = messages
    .map((message) => {
      const internalDate = Number(message.internalDate) || 0;
      const item = {
        id: message.id,
        threadId: message.threadId,
        from: getHeader(message, "From") || "Unknown sender",
        subject: getHeader(message, "Subject") || "No subject",
        snippet: message.snippet || "",
        time: formatMessageTime(message.internalDate),
        internalDate,
        priority: "NORMAL" as const,
        action: "No immediate action"
      };
      const classification = classifyEmail(item);
      return { ...item, ...classification };
    })
    .filter((item) => item.internalDate > internalDateAfterMs)
    .sort((a, b) => a.internalDate - b.internalDate)
    .slice(0, limit);

  return enriched;
}

export async function archiveGmailMessage(messageId: string) {
  return gmailPost<{ id: string }>(`/users/me/messages/${messageId}/modify`, {
    removeLabelIds: ["INBOX"]
  });
}

export async function sendGmailReply(input: {
  messageId: string;
  threadId?: string;
  to: string;
  subject: string;
  body: string;
}) {
  const profile = await gmailFetch<GmailProfileResponse>("/users/me/profile");
  const subject = buildReplySubject(input.subject || "No subject");
  const to = sanitizeHeader(input.to);
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
    input.body
  ].join("\r\n");

  return gmailPost<GmailSendResponse>("/users/me/messages/send", {
    raw: encodeBase64Url(rawMessage),
    threadId: input.threadId
  });
}
