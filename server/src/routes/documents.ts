import { Router } from "express";
import multer from "multer";
import {
  deleteDocument,
  ingestDocument,
  listDocuments,
  searchAndAnswerDocuments
} from "../services/documentIntelligence";

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/octet-stream"
]);

function mimeAllowed(mime: string, filename: string): boolean {
  const m = mime.toLowerCase();
  if (ALLOWED_MIME.has(m)) return true;
  return /\.(pdf|txt|md|csv|html?)$/i.test(filename);
}

documentsRouter.post("/documents/upload", upload.single("file"), async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "file is required" });
      return;
    }

    if (!mimeAllowed(file.mimetype, file.originalname)) {
      res.status(400).json({ error: "Unsupported file type" });
      return;
    }

    const title = String(req.body?.title || file.originalname || "Uploaded document").trim();
    const result = await ingestDocument({
      buffer: file.buffer,
      title,
      mimeType: file.mimetype,
      originalFilename: file.originalname,
      source: "upload"
    });

    res.json({
      documentId: result.documentId,
      title,
      chunkCount: result.chunkCount,
      charCount: result.charCount,
      status: "ready"
    });
  } catch (error) {
    next(error);
  }
});

documentsRouter.post("/documents/upload-text", async (req, res, next) => {
  try {
    const title = String(req.body?.title || "Pasted document").trim();
    const content = String(req.body?.content || "").trim();
    if (!content) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const source = String(req.body?.source || "paste") as "upload" | "gmail" | "drive" | "paste";
    const result = await ingestDocument({
      text: content,
      title,
      type: "text",
      source: source === "paste" ? "paste" : "upload"
    });

    res.json({
      documentId: result.documentId,
      title,
      chunkCount: result.chunkCount,
      status: "ready"
    });
  } catch (error) {
    next(error);
  }
});

documentsRouter.get("/documents", (_req, res) => {
  const documents = listDocuments();
  res.json({ documents, count: documents.length });
});

documentsRouter.delete("/documents/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  const deleted = deleteDocument(id);
  if (!deleted) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.json({ status: "ok", id });
});

documentsRouter.post("/documents/search", async (req, res, next) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const notebookId = req.body?.notebookId ? String(req.body.notebookId) : undefined;
    const result = await searchAndAnswerDocuments(query, notebookId);

    if (!result) {
      res.json({
        answer: null,
        citations: [],
        chunksUsed: []
      });
      return;
    }

    res.json({
      answer: result.answer,
      citations: result.citations,
      chunksUsed: result.chunksUsed.map((c) => ({
        chunkId: c.chunkId,
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        chunkIndex: c.chunkIndex
      }))
    });
  } catch (error) {
    next(error);
  }
});
