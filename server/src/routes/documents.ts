import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import {
  deleteDocument,
  ingestDocument,
  listDocuments,
  searchAndAnswerDocuments
} from "../services/documentIntelligence";
import {
  addSessionUploads,
  buildUploadAckSpeech,
  resolveUploadIsImage,
  storeImageBuffer
} from "../services/uploadSession";
import { getSessionId } from "./chat/utils";

export const documentsRouter = Router();

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const UPLOAD_FAIL_SPEECH = "Upload failed sir, please try again.";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES }
});

const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "video/mp4",
  "video/quicktime",
  "video/mpeg"
]);

const EXTENSION_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime"
};

/** iOS/Android often send empty or application/octet-stream — infer from filename. */
function normalizeUploadMime(mime: string, filename: string): string {
  const m = (mime || "").toLowerCase().trim();
  if (m && m !== "application/octet-stream") return m;
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/i)?.[0] || "";
  return EXTENSION_MIME[ext] || m || "application/octet-stream";
}

function mimeAllowed(mime: string, filename: string): boolean {
  const m = normalizeUploadMime(mime, filename);
  if (ALLOWED_MIME.has(m)) return true;
  if (m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/")) return true;
  return /\.(pdf|txt|md|csv|html?|docx?|doc|jpe?g|png|webp|gif|heic|heif|mp3|mp4|mov)$/i.test(
    filename
  );
}

/** Formats we store via text placeholder (no vision/binary parser). */
function requiresTextOnlyIngest(mime: string, filename: string): boolean {
  const m = normalizeUploadMime(mime, filename);
  if (/heic|heif/i.test(m) || /\.heic$/i.test(filename) || /\.heif$/i.test(filename)) return true;
  if (m === "image/gif" || /\.gif$/i.test(filename)) return true;
  if (/^audio\//.test(m) || /^video\//.test(m)) return true;
  return /\.(mp3|mp4|mov)$/i.test(filename);
}

function textOnlyIngestBody(filename: string, mime: string): string {
  const name = filename || "file";
  if (/heic|heif/i.test(mime) || /\.heic|\.heif$/i.test(name)) {
    return `Photo uploaded (${name}). HEIC is saved for reference, sir. For visual finish or analysis, a JPG or PNG copy works best.`;
  }
  if (/^video\//.test(mime) || /\.(mp4|mov)$/i.test(name)) {
    return `Video file uploaded (${name}). Stored for reference — tell me what you need from it, sir.`;
  }
  if (/^audio\//.test(mime) || /\.mp3$/i.test(name)) {
    return `Audio file uploaded (${name}). Stored for reference — tell me what you need from it, sir.`;
  }
  if (/gif/i.test(mime) || /\.gif$/i.test(name)) {
    return `Image uploaded (${name}). Stored for reference, sir.`;
  }
  return `File uploaded (${name}). Stored in your knowledge base, sir.`;
}

function uploadErrorSpeech(err: unknown): string {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return "That file is too large sir, fifty megabytes is the limit.";
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return "Too many files at once sir, try twelve or fewer.";
    }
  }
  return UPLOAD_FAIL_SPEECH;
}

function logUploadError(label: string, err: unknown, extra?: Record<string, unknown>) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[documents/upload] ${label}:`, detail, extra || "");
}

function wrapMulter(
  middleware: (req: Request, res: Response, next: NextFunction) => void
) {
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, (err: unknown) => {
      if (err) {
        logUploadError("multer", err, { path: req.path });
        res.status(400).json({
          error: err instanceof Error ? err.message : "upload_error",
          speech: uploadErrorSpeech(err)
        });
        return;
      }
      next();
    });
  };
}

type UploadedFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};

async function ingestUploadedFile(file: UploadedFile, sessionId: string) {
  const title = String(file.originalname || "Uploaded document").trim() || "Uploaded document";
  const mimeType = normalizeUploadMime(file.mimetype, file.originalname);

  const result = requiresTextOnlyIngest(mimeType, file.originalname)
    ? await ingestDocument({
        text: textOnlyIngestBody(file.originalname, mimeType),
        title,
        mimeType,
        originalFilename: file.originalname,
        source: "upload"
      })
    : await ingestDocument({
        buffer: file.buffer,
        title,
        mimeType,
        originalFilename: file.originalname,
        source: "upload"
      });

  const isImage = resolveUploadIsImage(mimeType, file.originalname, file.buffer);
  const [upload] = addSessionUploads(sessionId, [
    {
      documentId: result.documentId,
      filename: file.originalname,
      mimeType,
      isImage
    }
  ]);

  if (isImage && upload) {
    storeImageBuffer(upload.uploadId, file.buffer);
    console.log(
      `[uploadSession] stored image buffer session=${sessionId.slice(0, 12)} uploadId=${upload.uploadId} bytes=${file.buffer.length} mime=${mimeType}`
    );
  }

  return {
    documentId: result.documentId,
    title,
    chunkCount: result.chunkCount,
    charCount: result.charCount,
    mimeType,
    originalFilename: file.originalname,
    uploadId: upload?.uploadId,
    isImage,
    status: "ready" as const
  };
}

documentsRouter.post(
  "/documents/upload",
  wrapMulter(upload.single("file")),
  async (req, res) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) {
        res.status(400).json({ error: "file is required", speech: UPLOAD_FAIL_SPEECH });
        return;
      }

      if (!mimeAllowed(file.mimetype, file.originalname)) {
        logUploadError("mime_rejected", new Error("Unsupported type"), {
          mime: file.mimetype,
          name: file.originalname
        });
        res.status(400).json({ error: "Unsupported file type", speech: UPLOAD_FAIL_SPEECH });
        return;
      }

      const sessionId = getSessionId(req);
      const ingested = await ingestUploadedFile(file, sessionId);
      const speech = buildUploadAckSpeech([file.originalname]);

      res.json({ ...ingested, speech, files: [ingested] });
    } catch (error) {
      logUploadError("single", error, { name: req.file?.originalname });
      const detail = error instanceof Error ? error.message : "ingest_failed";
      res.status(400).json({
        error: detail,
        speech: UPLOAD_FAIL_SPEECH
      });
    }
  }
);

documentsRouter.post(
  "/documents/upload-batch",
  wrapMulter(upload.array("files", 12)),
  async (req, res) => {
    try {
      const files = req.files as UploadedFile[] | undefined;
      if (!files?.length) {
        res.status(400).json({ error: "files are required", speech: UPLOAD_FAIL_SPEECH });
        return;
      }

      const sessionId = getSessionId(req);
      const ingested: Awaited<ReturnType<typeof ingestUploadedFile>>[] = [];
      const filenames: string[] = [];
      const skipped: string[] = [];

      for (const file of files) {
        if (!file?.buffer?.length) continue;
        if (!mimeAllowed(file.mimetype, file.originalname)) {
          skipped.push(file.originalname);
          continue;
        }
        try {
          ingested.push(await ingestUploadedFile(file, sessionId));
          filenames.push(file.originalname);
        } catch (fileErr) {
          logUploadError("batch_item", fileErr, { name: file.originalname });
        }
      }

      if (!ingested.length) {
        logUploadError("batch_empty", new Error("No supported files ingested"), { skipped });
        res.status(400).json({ error: "No supported files", speech: UPLOAD_FAIL_SPEECH });
        return;
      }

      const speech = buildUploadAckSpeech(filenames);
      res.json({ speech, files: ingested, count: ingested.length });
    } catch (error) {
      logUploadError("batch", error);
      res.status(400).json({
        error: error instanceof Error ? error.message : "batch_failed",
        speech: UPLOAD_FAIL_SPEECH
      });
    }
  }
);

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
