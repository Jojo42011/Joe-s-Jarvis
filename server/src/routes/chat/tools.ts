import {
  addPriorityContact,
  clearAlertIfMatchingQueueItem,
  getActiveAlertPayload,
  getPriorityContacts,
  getQueue,
  getQueueGroupedByUrgency,
  getRecentCalls,
  getState,
  getTextsSince,
  logExecution,
  markQueueItemHandled,
  setState,
  type ConversationState
} from "../../db/queries";
import {
  generateAutonomousEmailReply,
  generateOperatorBriefing
} from "../../services/claude";
import { getRecentGmailMessages, sendGmailReply } from "../../services/gmail";
import { communication } from "../../brain/cycle";
import { logServiceError } from "../../utils/logError";
import { findEmailFromMessage } from "./truthGuard";
import { extractNameRefs } from "./truthGuard";
import { isSendCommand, normalizeText, resolveItemFromState } from "./utils";
import type { EmailStateItem, IntentResponse, JarvisUiPayload } from "./types";

﻿function summarizeDraft(draft: string) {
  const firstLine = draft
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^hi[,\s]*$/i.test(line) && !/^thank you\.?$/i.test(line));

  return firstLine || "I drafted a short professional reply.";
}

export function buildDraftPanelData(selected: EmailStateItem, draft: string, items: unknown[]) {
  return [
    {
      priority: "DRAFT",
      from: `Draft to ${selected.from || "recipient"}`,
      subject: selected.subject || "Reply ready",
      action: draft,
      time: "Now"
    },
    ...items
  ];
}

export function briefEmailSummary(emails: Array<Record<string, unknown>>) {
  if (!emails.length) return "No recent emails found, sir.";
  const priority = emails.filter((email) => email.priority === "HIGH");
  const top = (priority[0] || emails[0]) as { from?: string; subject?: string };

  if (priority.length) {
    return `I found ${emails.length} recent emails. ${priority.length} look worth attention. Top one is ${top.from}: ${top.subject}.`;
  }

  return `I found ${emails.length} recent emails. Nothing looks urgent. Top item is ${top.from}: ${top.subject}.`;
}

export function briefCallSummary(calls: Array<{ outcome?: string; from?: string; reason?: string }>) {
  if (!calls.length) return "No calls logged yet, sir.";
  const forwarded = calls.filter((call) => call.outcome === "FORWARDED").length;
  const messages = calls.filter((call) => call.outcome === "MESSAGE").length;
  const blocked = calls.filter((call) => call.outcome === "BLOCKED").length;
  const top = calls[0];

  return `I found ${calls.length} recent calls: ${forwarded} forwarded, ${messages} messages, ${blocked} blocked. Latest was ${top.from}: ${top.reason}.`;
}

export function addContactFromArgs(args: Record<string, unknown>, entities: Record<string, unknown>) {
  const name = String(args.name || entities.name || entities.contactName || "").trim();
  const phoneNumber = String(
    args.phoneNumber || args.phone_number || entities.phoneNumber || entities.phone_number || entities.number || ""
  ).trim();
  const relationship = String(args.relationship || entities.relationship || "priority contact").trim();

  if (!name || !phoneNumber) return null;

  return addPriorityContact({
    name,
    phoneNumber,
    relationship,
    alwaysForward: args.alwaysForward === false || args.always_forward === false ? false : true
  });
}

export function normalizeStatePatch(
  current: ConversationState,
  patch: Partial<ConversationState>
): Partial<ConversationState> {
  const activeItems = patch.activeItems ?? current.activeItems;
  const selectedItem = Object.prototype.hasOwnProperty.call(patch, "selectedItem")
    ? patch.selectedItem
    : current.selectedItem;

  return {
    ...patch,
    activeItems,
    selectedItem
  };
}

export function stateForResponse(state: ConversationState) {
  return {
    activePanel: state.activePanel,
    activeItems: state.activeItems,
    selectedItem: state.selectedItem,
    lastIntent: state.lastIntent
  };
}

export async function sendEmailImmediately(
  selected: EmailStateItem | null,
  bodyHint: string,
  currentMessage: string,
  sessionId: string
) {
  if (!selected?.id || !selected.from || !selected.subject) {
    return null;
  }

  const body =
    bodyHint.trim() ||
    (await generateAutonomousEmailReply({
      from: selected.from,
      subject: selected.subject,
      snippet: selected.snippet || currentMessage,
      emailType: selected.priority || "general"
    }));

  await sendGmailReply({
    messageId: selected.id,
    threadId: selected.threadId,
    to: selected.from,
    subject: selected.subject,
    body
  });

  const summary = `Sent reply to ${selected.from} re: ${selected.subject}`;
  logExecution({
    type: "email",
    action: "gmail.send_reply",
    item_id: `gmail:${selected.id}`,
    summary,
    result: "success"
  });

  const operatorContext = {
    ...getState(sessionId).operatorContext,
    lastEmailAction: {
      messageId: selected.id,
      from: selected.from,
      subject: selected.subject,
      summary,
      at: new Date().toISOString()
    },
    recentTopics: [
      normalizeText(selected.from),
      ...((getState(sessionId).operatorContext.recentTopics || []) as string[])
    ].slice(0, 8)
  };

  setState(sessionId, {
    operatorContext,
    selectedItem: selected,
    activePanel: "emails"
  });

  return { selected, summary };
}

export async function sendReplyFromState(state: ConversationState) {
  const selected = state.selectedItem as EmailStateItem | null;
  const draft = String(state.draft || "").trim();

  if (!selected?.id || !selected.from || !selected.subject || !draft) {
    return null;
  }

  await sendGmailReply({
    messageId: selected.id,
    threadId: selected.threadId,
    to: selected.from,
    subject: selected.subject,
    body: draft
  });

  return selected;
}

export async function executeTool(
  response: IntentResponse,
  state: ConversationState,
  currentMessage: string,
  sessionId: string
): Promise<{ response: IntentResponse; statePatch: Partial<ConversationState>; sentEmail?: boolean }> {
  const toolName = response.tool.name;
  const args = response.tool.args || {};

  if (response.intent === "execute.cancel") {
    return {
      sentEmail: false,
      response: {
        ...response,
        speech: response.speech || "Cancelled, sir.",
        ui: {
          panel: state.activePanel as JarvisUiPayload["panel"],
          action: "keep_open",
          data: state.activeItems
        }
      },
      statePatch: {
        selectedItem: null,
        lastIntent: "execute.cancel"
      }
    };
  }

  if (response.intent === "execute.edit" || response.intent === "execute.send") {
    const activeItems = state.activeItems.length
      ? (state.activeItems as EmailStateItem[])
      : await getRecentGmailMessages(8);
    const workingState: ConversationState = {
      ...state,
      activePanel: "emails",
      activeItems
    };
    const selected =
      (await findEmailFromMessage(currentMessage, workingState)) ||
      (resolveItemFromState(workingState, args, response.entities) as EmailStateItem | null);
    const draftHint = String(args.body || args.draft || response.entities.draft || "").trim();

    try {
      const sent = await sendEmailImmediately(selected, draftHint, currentMessage, sessionId);
      if (sent) {
        return {
          sentEmail: true,
          response: {
            ...response,
            speech: response.speech || `Sent, sir. ${sent.summary}`,
            ui: { panel: "emails", action: "keep_open", data: activeItems }
          },
          statePatch: {
            activePanel: "emails",
            activeItems,
            selectedItem: sent.selected,
            lastIntent: "gmail.send_reply"
          }
        };
      }
    } catch (error) {
      logServiceError("Gmail", "send", error);
      return {
        sentEmail: false,
        response: {
          ...response,
          speech: "Send failed, sir.",
          ui: { panel: "emails", action: "keep_open", data: activeItems }
        },
        statePatch: { lastIntent: "gmail.send_reply" }
      };
    }
  }

  if (response.intent === "execution.log" || toolName === "execution.log") {
    const summary = await communication.summarizeExecutionLogToday();
    return {
      sentEmail: false,
      response: {
        ...response,
        speech: response.speech || summary,
        ui: { panel: null, data: [], action: null }
      },
      statePatch: { lastIntent: "execution.log" }
    };
  }

  if (response.intent === "fetch.emails") {
    const emails = await getRecentGmailMessages(8);
    return {
      response: {
        ...response,
        speech: response.speech || briefEmailSummary(emails),
        ui: {
          panel: "emails",
          action: "open",
          data: emails
        }
      },
      statePatch: {
        activePanel: "emails",
        activeItems: emails,
        selectedItem: emails[0] || null,
        lastIntent: "fetch.emails"
      }
    };
  }

  if (response.intent === "unclear") {
    const clarification =
      typeof response.speech === "string" && response.speech.includes("?")
        ? response.speech
        : "What should I do, sir?";

    return {
      response: {
        ...response,
        speech: clarification,
        ui: {
          panel: state.activePanel as JarvisUiPayload["panel"],
          action: "keep_open",
          data: state.activeItems
        }
      },
      statePatch: {
        lastIntent: "unclear"
      }
    };
  }

  if (response.intent === "general.clear" || response.intent === "state.clear") {
    return {
      response: {
        ...response,
        ui: { panel: null, data: [], action: "close" }
      },
      statePatch: {
        activePanel: null,
        activeItems: [],
        selectedItem: null,
        lastIntent: response.intent
      }
    };
  }

  if (toolName === "gmail.fetch" || toolName === "gmail.fetch_unread") {
    const emails = await getRecentGmailMessages(8);
    return {
      response: {
        ...response,
        speech: response.speech || briefEmailSummary(emails),
        ui: {
          panel: "emails",
          action: "open",
          data: emails
        }
      },
      statePatch: {
        activePanel: "emails",
        activeItems: emails,
        selectedItem: emails[0] || null,
        lastIntent: response.intent
      }
    };
  }

  if (
    toolName === "gmail.prepare_reply" ||
    toolName === "gmail.edit_draft" ||
    response.intent === "email.reply.edit" ||
    toolName === "gmail.send_reply"
  ) {
    const emails = state.activeItems.length ? (state.activeItems as EmailStateItem[]) : await getRecentGmailMessages(30);
    const workingState = { ...state, activeItems: emails, activePanel: "emails" as const };
    const selected =
      (await findEmailFromMessage(currentMessage, workingState)) ||
      ((resolveItemFromState(workingState, args, response.entities) ||
        state.selectedItem) as EmailStateItem | null);
    const bodyHint = String(args.body || args.draft || response.entities.body || "").trim();

    try {
      const sent = await sendEmailImmediately(selected, bodyHint, currentMessage, sessionId);
      if (sent) {
        return {
          sentEmail: true,
          response: {
            ...response,
            speech: response.speech || `Sent, sir. ${sent.summary}`,
            ui: { panel: "emails", action: "keep_open", data: emails }
          },
          statePatch: {
            activePanel: "emails",
            activeItems: emails,
            selectedItem: sent.selected,
            lastIntent: "gmail.send_reply"
          }
        };
      }
    } catch (error) {
      logServiceError("Gmail", "send", error);
      return {
        sentEmail: false,
        response: {
          ...response,
          speech: "Send failed, sir.",
          ui: { panel: "emails", action: "keep_open", data: emails }
        },
        statePatch: { lastIntent: "gmail.send_reply" }
      };
    }

    const ref = extractNameRefs(currentMessage)[0];
    return {
      sentEmail: false,
      response: {
        ...response,
        speech: ref
          ? `I cannot find ${ref} in the inbox, sir. Say pull emails and I will match the thread.`
          : "I need the thread, sir. Who am I replying to?",
        ui: { panel: "emails", action: "open", data: emails }
      },
      statePatch: { activePanel: "emails", activeItems: emails, lastIntent: "unclear" }
    };
  }

  if (response.intent === "text.fetch") {
    const texts = getTextsSince(Date.now() - 7 * 24 * 60 * 60 * 1000, 30);
    return {
      response: {
        ...response,
        ui: { panel: "texts", action: "open", data: texts }
      },
      statePatch: {
        activePanel: "texts",
        activeItems: texts,
        selectedItem: texts[0] || null,
        lastIntent: response.intent
      }
    };
  }

  if (response.intent === "call.fetch" || toolName === "calls.get_log") {
    const calls = getRecentCalls(20);
    return {
      response: {
        ...response,
        speech: response.speech || briefCallSummary(calls),
        ui: { panel: "calls", action: "open", data: calls }
      },
      statePatch: {
        activePanel: "calls",
        activeItems: calls,
        selectedItem: calls[0] || null,
        lastIntent: response.intent
      }
    };
  }

  if (response.intent === "call.contacts.add" || toolName === "calls.add_contact") {
    const contact = addContactFromArgs(args, response.entities);

    if (!contact) {
      return {
        response: {
          ...response,
          intent: "unclear",
          speech: response.speech?.includes("?")
            ? response.speech
            : "Name and number, sir?"
        },
        statePatch: {
          lastIntent: "unclear"
        }
      };
    }

    const contacts = getPriorityContacts();
    return {
      response: {
        ...response,
        speech: response.speech || `${contact.name || "Contact"} is now priority, sir.`,
        ui: { panel: null, action: null, data: [] }
      },
      statePatch: {
        activeItems: contacts,
        selectedItem: contact,
        lastIntent: "call.contacts.add"
      }
    };
  }

  if (response.intent === "call.contacts.list" || toolName === "calls.get_contacts") {
    const contacts = getPriorityContacts();
    return {
      response: {
        ...response,
        speech:
          response.speech ||
          (contacts.length
            ? `${contacts.length} priority contacts loaded, sir.`
            : "No priority contacts yet, sir."),
        ui: { panel: null, action: null, data: [] }
      },
      statePatch: {
        activeItems: contacts,
        selectedItem: contacts[0] || null,
        lastIntent: "call.contacts.list"
      }
    };
  }

  if (response.intent === "rundown.full") {
    const grouped = getQueueGroupedByUrgency();
    const briefing = await generateOperatorBriefing(
      JSON.stringify({ grouped, source: "rundown.full" })
    );
    const emails = await getRecentGmailMessages(8);
    const calls = getRecentCalls(20);
    const texts = getTextsSince(Date.now() - 7 * 24 * 60 * 60 * 1000, 30);
    const data = {
      emails,
      texts,
      calls,
      briefing,
      priorityQueue: grouped
    };

    return {
      response: {
        ...response,
        speech: response.speech || briefing,
        ui: { panel: "rundown", action: "open", data: [data] }
      },
      statePatch: {
        activePanel: "rundown",
        activeItems: [...emails, ...calls],
        selectedItem: emails[0] || calls[0] || null,
        lastIntent: response.intent
      }
    };
  }

  if (response.intent === "intelligence.queue" || toolName === "intelligence.get_queue") {
    const grouped = getQueueGroupedByUrgency();
    const total = grouped.NOW.length + grouped.TODAY.length + grouped.THIS_WEEK.length;
    return {
      response: {
        ...response,
        speech: response.speech || `${total} open queue items, sir. Most urgent first on screen.`,
        ui: { panel: "rundown", action: "open", data: [{ priorityQueue: grouped }] }
      },
      statePatch: {
        activePanel: "rundown",
        activeItems: [grouped],
        selectedItem: grouped.NOW[0] || grouped.TODAY[0] || grouped.THIS_WEEK[0] || null,
        lastIntent: response.intent
      }
    };
  }

  if (response.intent === "intelligence.rundown" || toolName === "intelligence.rundown") {
    const grouped = getQueueGroupedByUrgency();
    const briefing = await generateOperatorBriefing(JSON.stringify({ grouped, source: "intelligence.rundown" }));
    return {
      response: {
        ...response,
        speech: response.speech || briefing,
        ui: { panel: "rundown", action: "open", data: [{ priorityQueue: grouped, briefing }] }
      },
      statePatch: {
        activePanel: "rundown",
        activeItems: [grouped],
        selectedItem: grouped.NOW[0] || grouped.TODAY[0] || null,
        lastIntent: response.intent
      }
    };
  }

  if (response.intent === "intelligence.alerts" || toolName === "intelligence.get_alerts") {
    const { hasAlert, alert } = getActiveAlertPayload();
    const line =
      hasAlert && alert
        ? `Active alert: ${alert.summary || "Priority item"}, sir.`
        : "No active alerts, sir.";
    return {
      response: {
        ...response,
        speech: response.speech || line,
        ui: {
          panel: state.activePanel as JarvisUiPayload["panel"],
          action: "keep_open",
          data: state.activeItems
        }
      },
      statePatch: {
        lastIntent: response.intent
      }
    };
  }

  if (response.intent === "intelligence.handled" || toolName === "intelligence.mark_handled") {
    const argId = Number(args.id);
    const queue = getQueue(false);
    const targetId =
      Number.isFinite(argId) && argId > 0
        ? argId
        : queue.find((item) => item.urgency === "NOW")?.id || queue[0]?.id || 0;

    if (targetId) {
      markQueueItemHandled(targetId);
      clearAlertIfMatchingQueueItem(targetId);
    }

    return {
      response: {
        ...response,
        speech:
          response.speech ||
          (targetId ? `Item ${targetId} is marked handled, sir.` : "No open queue item matched, sir."),
        ui: {
          panel: state.activePanel as JarvisUiPayload["panel"],
          action: "keep_open",
          data: state.activeItems
        }
      },
      statePatch: {
        lastIntent: response.intent
      }
    };
  }

  return {
    sentEmail: false,
    response,
    statePatch: {
      activePanel: response.ui.panel ?? state.activePanel,
      activeItems: response.ui.data?.length ? response.ui.data : state.activeItems,
      selectedItem: response.entities.selectedItem || state.selectedItem,
      lastIntent: response.intent
    }
  };
}
