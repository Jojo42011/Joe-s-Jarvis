import { getRecentNotes, searchNotes } from "../../db/queries";
import { briefEchoLine, createNoteFromInput } from "../../services/notes";
import type { IntentResponse } from "./types";

const SAVE_TRIGGERS = [
  /\bremember this\b/i,
  /\bnote that\b/i,
  /\bmake a note\b/i,
  /\badd a note\b/i,
  /\bwrite this down\b/i,
  /\bdon'?t forget\b/i,
  /\bkeep in mind\b/i
];

const OPEN_NOTES =
  /\b(open notes|show my notes|what are my notes|show notes|my notes)\b/i;

const SEARCH_NOTE =
  /(?:what did i note about|find my note on|what(?:'s| is) my note (?:about|on))\s+(.+)/i;

function emptyUi(): IntentResponse["ui"] {
  return { panel: null, data: [], action: null };
}

function stripJarvisPrefix(message: string): string {
  return message.replace(/^(?:hey\s+)?jarvis[,]?\s+/i, "").trim();
}

function stripSaveTrigger(message: string): string | null {
  let text = stripJarvisPrefix(message);
  for (const pattern of SAVE_TRIGGERS) {
    if (pattern.test(text)) {
      text = text.replace(pattern, "").replace(/^[,:\s-]+/, "").trim();
      return text.length >= 2 ? text : null;
    }
  }
  return null;
}

function matchesSaveIntent(message: string): boolean {
  const text = stripJarvisPrefix(message);
  return SAVE_TRIGGERS.some((p) => p.test(text));
}

export async function tryNotesRoute(message: string): Promise<IntentResponse | null> {
  const trimmed = message.trim();
  if (!trimmed) return null;

  if (OPEN_NOTES.test(trimmed)) {
    const notes = getRecentNotes(20);
    return {
      speech: notes.length
        ? `Opening your notes, sir. You have ${notes.length} on file.`
        : "Opening your notes, sir. You have none saved yet.",
      intent: "open_notes",
      entities: {},
      ui: { panel: "notes", action: "open", data: [{ notes }] },
      tool: { name: "notes", args: {} }
    };
  }

  const searchMatch = trimmed.match(SEARCH_NOTE);
  if (searchMatch?.[1]) {
    const query = searchMatch[1].replace(/[?.!]+$/, "").trim();
    const hits = searchNotes(query, 5);
    if (!hits.length) {
      return {
        speech: `I don't have a note on ${query}, sir.`,
        intent: "search_notes",
        entities: { query },
        ui: { panel: "notes", action: "open", data: [{ notes: [] }] },
        tool: { name: "notes", args: { query } }
      };
    }
    const top = hits[0];
    return {
      speech: `Sir, your note: ${top.content.slice(0, 220)}.`,
      intent: "search_notes",
      entities: { query, noteId: top.id },
      ui: { panel: "notes", action: "open", data: [{ notes: hits }] },
      tool: { name: "notes", args: { query } }
    };
  }

  if (!matchesSaveIntent(trimmed)) return null;

  const content = stripSaveTrigger(trimmed);
  if (!content) {
    return {
      speech: "What should I note, sir?",
      intent: "save_note",
      entities: {},
      ui: emptyUi(),
      tool: { name: "notes", args: {} }
    };
  }

  const { note } = await createNoteFromInput(content, "voice");
  const echo = briefEchoLine(note.content);

  return {
    speech: `Noted, sir. ${echo}.`,
    intent: "save_note",
    entities: { noteId: note.id },
    ui: { panel: "notes", action: "flash", data: [{ note }] },
    tool: { name: "notes", args: {} }
  };
}
