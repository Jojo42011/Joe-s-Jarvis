import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { logExecution } from "../db/queries";
import { findWorkingModel } from "./claude";
import { claudeCircuit } from "./circuitBreaker";

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 100;
const MAX_SEARCH_CHUNKS = 120;
const MAX_RESULTS = 5;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export type DocumentType = "pdf" | "text" | "url" | "image" | "html";
export type DocumentSource = "upload" | "gmail" | "drive" | "paste";

export type DocumentListItem = {
  id: string;
  notebookId: string;
  title: string;
  type: string;
  status: string;
  uploadedAt: string;
  charCount: number;
  source: string;
  chunkCount: number;
  originalFilename: string | null;
};

export type DocumentChunkResult = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  charStart: number;
  charEnd: number;
};

export type DocumentCitation = {
  docTitle: string;
  chunkIndex: number;
  documentId: string;
};

export type DocumentAnswer = {
  answer: string;
  citations: DocumentCitation[];
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const mod = await import("pdf-parse");
  const pdfParse =
    typeof mod === "function"
      ? (mod as (b: Buffer) => Promise<{ text?: string }>)
      : (mod as { default: (b: Buffer) => Promise<{ text?: string }> }).default;
  const data = await pdfParse(buffer);
  return String(data.text || "").trim();
}

function chunkText(text: string): Array<{ content: string; charStart: number; charEnd: number }> {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const chunks: Array<{ content: string; charStart: number; charEnd: number }> = [];
  let start = 0;

  while (start < normalized.length) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length);
    chunks.push({
      content: normalized.slice(start, end),
      charStart: start,
      charEnd: end
    });
    if (end >= normalized.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }

  return chunks;
}

function refreshNotebookDocumentCount(notebookId: string) {
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM documents WHERE notebook_id = @notebookId`)
    .get({ notebookId }) as { c: number };
  db.prepare(`UPDATE notebooks SET document_count = @c WHERE id = @notebookId`).run({
    c: row.c,
    notebookId
  });
}

function parseJsonIdArray(raw: string): string[] {
  try {
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const start = jsonText.indexOf("[");
    const end = jsonText.lastIndexOf("]");
    const parsed = JSON.parse(
      start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String).filter(Boolean);
  } catch {
    return [];
  }
}

export async function ingestDocument(input: {
  buffer?: Buffer;
  text?: string;
  title: string;
  mimeType?: string;
  originalFilename?: string;
  type?: DocumentType;
  source?: DocumentSource;
  notebookId?: string;
}): Promise<{ documentId: string; chunkCount: number; charCount: number }> {
  const documentId = randomUUID();
  const notebookId = input.notebookId || "default";
  const source = input.source || "upload";
  let docType: DocumentType = input.type || "text";
  let rawText = "";

  const mime = (input.mimeType || "").toLowerCase();
  const filename = (input.originalFilename || "").toLowerCase();

  if (input.text) {
    rawText = input.text;
    docType = "text";
  } else if (input.buffer) {
    if (mime.includes("pdf") || filename.endsWith(".pdf")) {
      docType = "pdf";
      rawText = await extractPdfText(input.buffer);
    } else if (mime.includes("html") || filename.endsWith(".html") || filename.endsWith(".htm")) {
      docType = "html";
      rawText = stripHtml(input.buffer.toString("utf8"));
    } else if (
      mime.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp)$/i.test(filename)
    ) {
      docType = "image";
      rawText = "Image upload — OCR not yet supported. No searchable text extracted.";
    } else {
      docType = "text";
      rawText = input.buffer.toString("utf8");
    }
  }

  const title = input.title.trim() || input.originalFilename || "Untitled document";
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO documents (id, notebook_id, title, type, original_filename, content_raw, status, uploaded_at, char_count, source)
    VALUES (@id, @notebookId, @title, @type, @originalFilename, @contentRaw, 'processing', @uploadedAt, 0, @source)
  `
  ).run({
    id: documentId,
    notebookId,
    title,
    type: docType,
    originalFilename: input.originalFilename || null,
    contentRaw: rawText,
    uploadedAt: now,
    source
  });

  try {
    const pieces = chunkText(rawText);
    const insertChunk = db.prepare(
      `
      INSERT INTO document_chunks (id, document_id, chunk_index, content, char_start, char_end, created_at)
      VALUES (@id, @documentId, @chunkIndex, @content, @charStart, @charEnd, @createdAt)
    `
    );

    pieces.forEach((piece, index) => {
      insertChunk.run({
        id: randomUUID(),
        documentId,
        chunkIndex: index,
        content: piece.content,
        charStart: piece.charStart,
        charEnd: piece.charEnd,
        createdAt: now
      });
    });

    db.prepare(
      `
      UPDATE documents SET status = 'ready', char_count = @charCount, content_raw = @contentRaw WHERE id = @id
    `
    ).run({
      id: documentId,
      charCount: rawText.length,
      contentRaw: rawText
    });

    refreshNotebookDocumentCount(notebookId);

    logExecution({
      type: "document",
      action: "ingest",
      item_id: documentId,
      summary: `Document ingested: ${title} (${pieces.length} chunks, ${rawText.length} chars)`,
      result: "success"
    });

    return { documentId, chunkCount: pieces.length, charCount: rawText.length };
  } catch (error) {
    db.prepare(`UPDATE documents SET status = 'error' WHERE id = @id`).run({ id: documentId });
    throw error;
  }
}

function getChunksForSearch(notebookId?: string): DocumentChunkResult[] {
  const notebookSql = notebookId ? ` AND d.notebook_id = @notebookId` : "";
  const rows = db
    .prepare(
      `
    SELECT c.id, c.document_id, c.chunk_index, c.content, c.char_start, c.char_end,
           d.title as document_title
    FROM document_chunks c
    INNER JOIN documents d ON d.id = c.document_id
    WHERE d.status = 'ready'${notebookSql}
    ORDER BY d.uploaded_at DESC, c.chunk_index ASC
    LIMIT @limit
  `
    )
    .all({
      ...(notebookId ? { notebookId } : {}),
      limit: MAX_SEARCH_CHUNKS
    }) as Array<{
    id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    char_start: number;
    char_end: number;
    document_title: string;
  }>;

  return rows.map((row) => ({
    chunkId: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    chunkIndex: row.chunk_index,
    content: row.content,
    charStart: row.char_start,
    charEnd: row.char_end
  }));
}

function fetchChunksByIds(ids: string[]): DocumentChunkResult[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
    SELECT c.id, c.document_id, c.chunk_index, c.content, c.char_start, c.char_end,
           d.title as document_title
    FROM document_chunks c
    INNER JOIN documents d ON d.id = c.document_id
    WHERE c.id IN (${placeholders})
  `
    )
    .all(...ids) as Array<{
    id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    char_start: number;
    char_end: number;
    document_title: string;
  }>;

  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .map((row) => ({
      chunkId: row.id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      chunkIndex: row.chunk_index,
      content: row.content,
      charStart: row.char_start,
      charEnd: row.char_end
    }))
    .sort((a, b) => (order.get(a.chunkId) ?? 0) - (order.get(b.chunkId) ?? 0));
}

export async function searchDocuments(
  query: string,
  notebookId?: string
): Promise<DocumentChunkResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const allChunks = getChunksForSearch(notebookId);
  if (!allChunks.length) return [];

  if (!anthropic) {
    const q = trimmed.toLowerCase();
    return allChunks
      .filter((c) => c.content.toLowerCase().includes(q) || c.documentTitle.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }

  const model = await findWorkingModel();
  if (!model) {
    const q = trimmed.toLowerCase();
    return allChunks
      .filter((c) => c.content.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }

  const catalog = allChunks
    .map((c) => {
      const preview = c.content.replace(/\s+/g, " ").slice(0, 220);
      return `[${c.chunkId}] ${c.documentTitle} | section ${c.chunkIndex}: ${preview}`;
    })
    .join("\n");

  try {
    const response = await claudeCircuit.execute("document-search", () =>
      anthropic.messages.create({
        model,
        max_tokens: 400,
        temperature: 0.1,
        system: "Return only valid JSON. No markdown.",
        messages: [
          {
            role: "user",
            content: `You are searching Joe Stewart's business documents.
Query: ${trimmed}

Here are document chunks available:
${catalog}

Return the IDs of the up to ${MAX_RESULTS} most relevant chunks for this query. Return only a JSON array of chunk IDs.
Example: ["chunk_id_1", "chunk_id_2"]`
          }
        ]
      })
    );

    const text = response.content.find((b) => b.type === "text")?.text?.trim() || "[]";
    const ids = parseJsonIdArray(text).slice(0, MAX_RESULTS);
    const matched = fetchChunksByIds(ids);
    if (matched.length) return matched;

    const q = trimmed.toLowerCase();
    return allChunks
      .filter((c) => c.content.toLowerCase().includes(q) || c.documentTitle.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  } catch (error) {
    console.warn("[documentIntelligence] searchDocuments failed:", error);
    const q = trimmed.toLowerCase();
    return allChunks
      .filter((c) => c.content.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }
}

export async function answerFromDocuments(
  query: string,
  chunks: DocumentChunkResult[]
): Promise<DocumentAnswer | null> {
  if (!chunks.length) return null;

  const sections = chunks
    .map(
      (c) =>
        `[Document: ${c.documentTitle} | Section ${c.chunkIndex}]\n${c.content}\n---`
    )
    .join("\n");

  const citations: DocumentCitation[] = chunks.map((c) => ({
    docTitle: c.documentTitle,
    chunkIndex: c.chunkIndex,
    documentId: c.documentId
  }));

  if (!anthropic) {
    return {
      answer: `Sir, I found relevant material in ${citations[0].docTitle}, section ${citations[0].chunkIndex}. ${chunks[0].content.slice(0, 400)}`,
      citations
    };
  }

  const model = await findWorkingModel();
  if (!model) {
    return {
      answer: `Sir, document data is in ${citations[0].docTitle} but Claude is unavailable to synthesize an answer.`,
      citations
    };
  }

  try {
    const response = await claudeCircuit.execute("document-answer", () =>
      anthropic.messages.create({
        model,
        max_tokens: 500,
        temperature: 0.2,
        system: "Answer in plain text only. No JSON. No markdown.",
        messages: [
          {
            role: "user",
            content: `You are JARVIS, answering a question about Joe Stewart's Totally Outdoors LLC business.

Answer ONLY from the documents provided below.
If the answer isn't in the documents, say:
"Sir, I don't have that information in the documents I've been given."

Never make up numbers, dates, or names.
Always cite which document your answer came from.

QUERY: ${query}

RELEVANT DOCUMENT SECTIONS:
${sections}

Answer concisely. Cite document name for every fact.`
          }
        ]
      })
    );

    const answer =
      response.content.find((b) => b.type === "text")?.text?.trim() ||
      "Sir, I don't have that information in the documents I've been given.";

    return { answer, citations };
  } catch (error) {
    console.warn("[documentIntelligence] answerFromDocuments failed:", error);
    return null;
  }
}

export function listDocuments(notebookId?: string): DocumentListItem[] {
  const notebookSql = notebookId ? ` WHERE d.notebook_id = @notebookId` : "";
  const rows = db
    .prepare(
      `
    SELECT d.id, d.notebook_id, d.title, d.type, d.status, d.uploaded_at, d.char_count, d.source, d.original_filename,
           (SELECT COUNT(*) FROM document_chunks c WHERE c.document_id = d.id) as chunk_count
    FROM documents d${notebookSql}
    ORDER BY d.uploaded_at DESC
  `
    )
    .all(notebookId ? { notebookId } : {}) as Array<{
    id: string;
    notebook_id: string;
    title: string;
    type: string;
    status: string;
    uploaded_at: string;
    char_count: number;
    source: string;
    original_filename: string | null;
    chunk_count: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    notebookId: row.notebook_id,
    title: row.title,
    type: row.type,
    status: row.status,
    uploadedAt: row.uploaded_at,
    charCount: row.char_count,
    source: row.source,
    chunkCount: row.chunk_count,
    originalFilename: row.original_filename
  }));
}

export function getDocumentCount(notebookId?: string): number {
  const notebookSql = notebookId ? ` AND notebook_id = @notebookId` : "";
  const row = db
    .prepare(
      `
    SELECT COUNT(*) as c FROM documents
    WHERE status = 'ready'${notebookSql}
  `
    )
    .get(notebookId ? { notebookId } : {}) as { c: number };
  return row.c;
}

export function deleteDocument(documentId: string): boolean {
  const doc = db.prepare(`SELECT id, notebook_id, title FROM documents WHERE id = @id`).get({
    id: documentId
  }) as { id: string; notebook_id: string; title: string } | undefined;

  if (!doc) return false;

  db.prepare(`DELETE FROM document_chunks WHERE document_id = @id`).run({ id: documentId });
  db.prepare(`DELETE FROM documents WHERE id = @id`).run({ id: documentId });
  refreshNotebookDocumentCount(doc.notebook_id);

  logExecution({
    type: "document",
    action: "delete",
    item_id: documentId,
    summary: `Document deleted: ${doc.title}`,
    result: "success"
  });

  return true;
}

export async function searchAndAnswerDocuments(
  query: string,
  notebookId?: string
): Promise<{ answer: string; citations: DocumentCitation[]; chunksUsed: DocumentChunkResult[] } | null> {
  const chunks = await searchDocuments(query, notebookId);
  if (!chunks.length) return null;

  const result = await answerFromDocuments(query, chunks);
  if (!result) return null;

  const primary = result.citations[0];
  logExecution({
    type: "document",
    action: "search",
    item_id: primary?.documentId || null,
    summary: `Document search: ${query.slice(0, 120)} → ${primary?.docTitle || "document"} cited`,
    result: "success"
  });

  return {
    answer: result.answer,
    citations: result.citations,
    chunksUsed: chunks
  };
}
