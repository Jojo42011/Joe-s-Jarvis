import {
  addPriorityContact,
  clearAlertIfMatchingQueueItem,
  getActiveAlertPayload,
  getAppointmentById,
  getPriorityContacts,
  getQueue,
  getQueueGroupedByUrgency,
  getRecentCalls,
  getState,
  getTextsSince,
  getUpcomingAppointments,
  logExecution,
  markQueueItemHandled,
  setState,
  updateAppointmentStatus,
  type ConversationState
} from "../../db/queries";
import { generateOperatorBriefing } from "../../services/claude";
import { getRecentGmailMessages, sendGmailReply } from "../../services/gmail";
import { generateAutonomousEmailReply } from "../../services/claude";
import { resolveOutboundEmailBody } from "../../utils/emailBody";
import { communication } from "../../brain/cycle";
import { logServiceError } from "../../utils/logError";
import { toolLog } from "../../utils/requestLog";
import { findEmailFromMessage } from "./truthGuard";
import { extractNameRefs } from "./truthGuard";
import { isSendCommand, normalizeText, resolveItemFromState } from "./utils";
import {
  resolveImageGenerationTarget,
  runImageGeneration
} from "./uploadOrchestrator";
import { getSessionImages } from "../../services/uploadSession";
import {
  bookAppointmentFromExtraction,
  defaultNextWeekdaySlot,
  type AppointmentExtraction
} from "../../services/appointmentBooking";
import {
  checkAvailability,
  deleteCalendarEvent,
  getUpcomingEvents
} from "../../services/googleCalendar";
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

  const messageId = selected.id;
  const to = selected.from;
  const subject = selected.subject;

  const body = await resolveOutboundEmailBody(bodyHint, () =>
    generateAutonomousEmailReply({
      from: to,
      subject,
      snippet: selected.snippet || currentMessage,
      emailType: selected.priority || "general"
    })
  );

  await sendGmailReply({
    messageId,
    threadId: selected.threadId,
    to,
    subject,
    body
  });

  const summary = `Sent reply to ${to} re: ${subject}`;
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
  const draftHint = String(state.draft || "").trim();

  if (!selected?.id || !selected.from || !selected.subject || !draftHint) {
    return null;
  }

  const messageId = selected.id;
  const to = selected.from;
  const subject = selected.subject;

  const body = await resolveOutboundEmailBody(draftHint, () =>
    generateAutonomousEmailReply({
      from: to,
      subject,
      snippet: selected.snippet || "",
      emailType: selected.priority || "general"
    })
  );

  await sendGmailReply({
    messageId,
    threadId: selected.threadId,
    to,
    subject,
    body
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
  toolLog(
    `execute: intent=${response.intent} tool=${toolName || "none"} session=${sessionId.slice(0, 12)}`
  );

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

  if (
    toolName === "image.generate" ||
    response.intent === "image.generate" ||
    (typeof response.intent === "string" && response.intent.startsWith("image.generate"))
  ) {
    toolLog("image.generate tool handler — invoking Gemini");
    const prompt = String(
      args.prompt || args.message || args.text || response.entities?.prompt || currentMessage
    ).trim();
    const target = resolveImageGenerationTarget(
      sessionId,
      prompt || currentMessage,
      args,
      currentMessage
    );

    if (target === null && getSessionImages(sessionId).length > 1) {
      const names = getSessionImages(sessionId).map((i) => i.filename).join(" or ");
      return {
        sentEmail: false,
        response: {
          speech: `Which image sir — ${names}?`,
          intent: "image.generate.select",
          entities: {},
          ui: { panel: null, data: [], action: null },
          tool: { name: null, args: {} }
        },
        statePatch: { lastIntent: "image.generate.select" }
      };
    }

    const genResult = await runImageGeneration(
      prompt || currentMessage,
      sessionId,
      target
    );

    return {
      sentEmail: false,
      response: genResult,
      statePatch: {
        activePanel: (genResult.ui.panel as ConversationState["activePanel"]) || "photo",
        activeItems: genResult.ui.data || [],
        lastIntent: genResult.intent
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
    logExecution({
      type: "email",
      action: "gmail.fetch",
      summary: `Inbox opened — ${emails.length} message${emails.length === 1 ? "" : "s"} loaded for Joe`,
      result: "success"
    });
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
    logExecution({
      type: "email",
      action: toolName,
      summary: `Inbox opened — ${emails.length} message${emails.length === 1 ? "" : "s"} loaded for Joe`,
      result: "success"
    });
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

  if (
    response.intent === "calendar.list" ||
    toolName === "calendar.list" ||
    response.intent === "calendar.check" ||
    toolName === "calendar.check" ||
    response.intent === "calendar.create" ||
    toolName === "calendar.create" ||
    response.intent === "calendar.cancel" ||
    toolName === "calendar.cancel"
  ) {
    const days = Number(args.days) || 7;

    if (response.intent === "calendar.list" || toolName === "calendar.list") {
      const [events, localAppts] = await Promise.all([
        getUpcomingEvents(days),
        Promise.resolve(getUpcomingAppointments(20))
      ]);
      const lines: string[] = [];
      if (events?.length) {
        for (const ev of events.slice(0, 8)) {
          const when = ev.start
            ? new Date(ev.start).toLocaleString("en-US", {
                timeZone: "America/New_York",
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit"
              })
            : "TBD";
          lines.push(`${when}: ${ev.summary}`);
        }
      }
      if (localAppts.length) {
        for (const a of localAppts.slice(0, 5)) {
          lines.push(
            `${a.callerName || "Client"} — ${a.serviceRequested || "appointment"} (${a.preferredDate || "scheduled"})`
          );
        }
      }
      const speech =
        response.speech ||
        (lines.length
          ? `On the calendar sir: ${lines.join(". ")}.`
          : "Nothing on the calendar for that window, sir.");
      return {
        response: {
          ...response,
          speech,
          ui: {
            panel: "rundown",
            action: "open",
            data: [{ calendarEvents: events || [], appointments: localAppts }]
          }
        },
        statePatch: { lastIntent: "calendar.list", activePanel: "rundown" }
      };
    }

    if (response.intent === "calendar.check" || toolName === "calendar.check") {
      const startRaw = String(args.startDateTime || args.start || "").trim();
      const endRaw = String(args.endDateTime || args.end || "").trim();
      let start = startRaw;
      let end = endRaw;
      if (!start) {
        const slot = defaultNextWeekdaySlot();
        start = slot.start;
        end = slot.end;
      } else if (!end) {
        const ms = Date.parse(start);
        end = Number.isFinite(ms) ? new Date(ms + 3600000).toISOString() : start;
      }
      const free = await checkAvailability(start, end);
      const when = new Date(start).toLocaleString("en-US", {
        timeZone: "America/New_York",
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
      const speech =
        response.speech ||
        (free === true
          ? `You're clear at ${when}, sir.`
          : free === false
            ? `That slot is taken, sir — ${when} has a conflict.`
            : "I couldn't reach the calendar right now, sir.");
      return {
        response: { ...response, speech, ui: { panel: null, data: [], action: null } },
        statePatch: { lastIntent: "calendar.check" }
      };
    }

    if (response.intent === "calendar.create" || toolName === "calendar.create") {
      const extraction: AppointmentExtraction = {
        shouldBook: true,
        callerName: String(args.callerName || args.name || response.entities?.name || "Client").trim(),
        callerPhone: String(args.callerPhone || args.phone || "").trim(),
        serviceRequested: String(
          args.serviceRequested || args.service || args.summary || "Consultation"
        ).trim(),
        preferredDate: String(args.preferredDate || args.date || "flexible").trim(),
        preferredTime: String(args.preferredTime || args.time || "flexible").trim(),
        notes: String(args.notes || currentMessage).trim(),
        startDateTime: args.startDateTime ? String(args.startDateTime) : null,
        endDateTime: args.endDateTime ? String(args.endDateTime) : null
      };
      const booked = await bookAppointmentFromExtraction(extraction, "chat");
      return {
        response: {
          ...response,
          speech:
            response.speech ||
            (booked.ok && booked.speech
              ? booked.speech
              : "Couldn't lock that appointment in, sir. Calendar may be unavailable."),
          ui: { panel: "rundown", action: "open", data: [{ appointmentBooked: booked.ok }] }
        },
        statePatch: { lastIntent: "calendar.create", activePanel: "rundown" }
      };
    }

    if (response.intent === "calendar.cancel" || toolName === "calendar.cancel") {
      const apptId = Number(args.appointmentId || args.id);
      const eventId = String(args.eventId || "").trim();
      let appt = Number.isFinite(apptId) && apptId > 0 ? getAppointmentById(apptId) : null;
      if (!appt && eventId) {
        const all = getUpcomingAppointments(50);
        appt = all.find((a) => a.eventId === eventId) || null;
      }
      if (!appt?.eventId) {
        return {
          response: {
            ...response,
            speech: response.speech || "No matching appointment to cancel, sir.",
            ui: { panel: null, data: [], action: null }
          },
          statePatch: { lastIntent: "calendar.cancel" }
        };
      }
      const deleted = await deleteCalendarEvent(appt.eventId);
      if (deleted) {
        updateAppointmentStatus(appt.id, "cancelled");
        logExecution({
          type: "calendar",
          action: "calendar.cancel",
          item_id: appt.eventId,
          summary: `Cancelled appointment for ${appt.callerName || "client"}`,
          result: "success"
        });
      }
      return {
        response: {
          ...response,
          speech:
            response.speech ||
            (deleted
              ? `Cancelled, sir. ${appt.callerName || "Client"} — ${appt.serviceRequested || "appointment"}.`
              : "Calendar cancel failed, sir."),
          ui: { panel: null, data: [], action: null }
        },
        statePatch: { lastIntent: "calendar.cancel" }
      };
    }
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
