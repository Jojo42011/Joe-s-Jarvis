import Anthropic from "@anthropic-ai/sdk";
import {
  getEntityProfile,
  saveMemory,
  saveNote,
  updateNoteMetadata,
  type Note,
  type NoteSource
} from "../db/queries";
import { getOhioDateTimeString } from "../routes/chat/utils";
import { findFastWorkingModel } from "./claude";

const notesAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const ENTITY_PROMPT =
  "Extract any business entity names (clients, crew members, vendors, job names) from this note. Return JSON array of strings only. If none, return [].";

function parseEntityArray(raw: string): string[] {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => String(v).trim())
      .filter((v) => v.length >= 2)
      .slice(0, 12);
  } catch {
    const m = trimmed.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      const parsed = JSON.parse(m[0]) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((v) => String(v).trim()).filter((v) => v.length >= 2).slice(0, 12);
    } catch {
      return [];
    }
  }
}

export async function extractNoteEntities(content: string): Promise<string[]> {
  if (!notesAnthropic) return [];
  try {
    const model = await findFastWorkingModel();
    if (!model) return [];
    const response = await notesAnthropic.messages.create({
      model,
      max_tokens: 50,
      temperature: 0,
      messages: [
        { role: "user", content: `${ENTITY_PROMPT}\n\nNote:\n${content.slice(0, 1500)}` }
      ]
    });
    const text = response.content.find((b) => b.type === "text")?.text || "[]";
    return parseEntityArray(text);
  } catch (error) {
    console.warn("[notes] entity extraction failed:", error);
    return [];
  }
}

function entityAnnotations(entities: string[]): string[] {
  const annotations: string[] = [];
  for (const name of entities.slice(0, 6)) {
    const profile = getEntityProfile(name);
    if (!profile) continue;
    const bits: string[] = [];
    if (profile.entityType) bits.push(profile.entityType);
    if (profile.relationshipSummary) bits.push(profile.relationshipSummary.slice(0, 80));
    if (bits.length) annotations.push(`${name}: ${bits.join(" — ")}`);
  }
  return annotations;
}

function inferMemoryCategory(entities: string[]): string {
  for (const name of entities) {
    const profile = getEntityProfile(name);
    if (profile?.entityType?.toLowerCase() === "client") return "client_relations";
  }
  return "business_context";
}

export type CreateNoteResult = {
  note: Note;
  entities: string[];
  entityAnnotations: string[];
};

export async function createNoteFromInput(
  content: string,
  source: NoteSource
): Promise<CreateNoteResult> {
  const ohioTime = getOhioDateTimeString();
  let note = saveNote(content, source, ohioTime);

  const entities = await extractNoteEntities(note.content);
  const annotations = entityAnnotations(entities);
  const category = entities.length ? inferMemoryCategory(entities) : "business_context";

  note = updateNoteMetadata(note.id, {
    category,
    linkedEntities: entities.length ? JSON.stringify(entities) : null
  });

  const memoryCategory = inferMemoryCategory(entities);
  saveMemory({
    category: memoryCategory,
    key: `note_${note.id}`,
    value: note.content,
    confidence: 0.9,
    source: "joe_note"
  });

  note = updateNoteMetadata(note.id, { promotedToMemory: 1 });

  return { note, entities, entityAnnotations: annotations };
}

export function briefEchoLine(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 72) return oneLine;
  return `${oneLine.slice(0, 69).trim()}…`;
}

export function formatNotesBriefingSnippet(
  notes: Array<{ id: number; content: string }>
): string {
  if (!notes.length) return "";
  const n = notes.length;
  const label = `You have ${n} note${n === 1 ? "" : "s"} from the past 24 hours.`;
  if (n <= 3) {
    const items = notes
      .map((note) => note.content.replace(/\s+/g, " ").trim().slice(0, 72))
      .join("; ");
    return `${label} ${items}`;
  }
  const preview = notes
    .slice(0, 2)
    .map((note) => note.content.replace(/\s+/g, " ").trim().slice(0, 48))
    .join("; ");
  return `${label} Recent: ${preview}, and ${n - 2} more.`;
}
