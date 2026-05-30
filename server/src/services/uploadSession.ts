import { randomUUID } from "node:crypto";

export type SessionUpload = {
  uploadId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  isImage: boolean;
  uploadedAt: number;
};

export type GeneratedImage = {
  imageBase64: string;
  mimeType: string;
  sourceUploadId: string;
  sourceFilename: string;
  generatedAt: number;
};

const imageBuffers = new Map<string, Buffer>();
const sessionUploads = new Map<string, SessionUpload[]>();
const sessionGenerated = new Map<string, GeneratedImage>();

function isImageMime(mime: string, filename: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif|bmp|tiff?)$/i.test(filename);
}

/** Detect image payloads when mobile sends application/octet-stream without a useful extension. */
export function bufferLooksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true;
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return true;
  const ftyp = buffer.subarray(4, 8).toString("ascii");
  if (ftyp === "ftyp" || ftyp === "heic" || ftyp === "heix" || ftyp === "mif1") return true;
  return false;
}

export function resolveUploadIsImage(mime: string, filename: string, buffer: Buffer): boolean {
  return isImageMime(mime, filename) || bufferLooksLikeImage(buffer);
}

export function storeImageBuffer(uploadId: string, buffer: Buffer) {
  imageBuffers.set(uploadId, buffer);
}

export function getImageBuffer(uploadId: string): Buffer | null {
  const buf = imageBuffers.get(uploadId) || null;
  if (!buf) {
    console.warn(
      `[uploadSession] getImageBuffer miss uploadId=${uploadId} buffered=${imageBuffers.size}`
    );
  } else {
    console.log(
      `[uploadSession] getImageBuffer hit uploadId=${uploadId} bytes=${buf.length}`
    );
  }
  return buf;
}

export function addSessionUploads(sessionId: string, uploads: Omit<SessionUpload, "uploadId" | "uploadedAt">[]) {
  const batch = uploads.map((u) => ({
    ...u,
    uploadId: randomUUID(),
    uploadedAt: Date.now()
  }));
  const replaceNames = new Set(batch.map((u) => u.filename.toLowerCase()));
  const existing = sessionUploads.get(sessionId) || [];
  const kept = existing.filter((u) => {
    if (!replaceNames.has(u.filename.toLowerCase())) return true;
    imageBuffers.delete(u.uploadId);
    return false;
  });
  sessionUploads.set(sessionId, [...kept, ...batch]);
  return batch;
}

export function getSessionUploads(sessionId: string): SessionUpload[] {
  return sessionUploads.get(sessionId) || [];
}

export function getSessionImages(sessionId: string): SessionUpload[] {
  return getSessionUploads(sessionId).filter((u) => u.isImage || imageBuffers.has(u.uploadId));
}

export function findUploadByFilename(sessionId: string, hint: string): SessionUpload | null {
  const lower = hint.toLowerCase();
  const uploads = getSessionUploads(sessionId);
  return uploads.find((u) => u.filename.toLowerCase().includes(lower)) || null;
}

export function setGeneratedImage(sessionId: string, image: GeneratedImage) {
  sessionGenerated.set(sessionId, image);
}

export function getGeneratedImage(sessionId: string): GeneratedImage | null {
  return sessionGenerated.get(sessionId) || null;
}

export function clearSessionUploadContext(sessionId: string) {
  for (const upload of getSessionUploads(sessionId)) {
    imageBuffers.delete(upload.uploadId);
  }
  sessionUploads.delete(sessionId);
  sessionGenerated.delete(sessionId);
}

export function buildUploadAckSpeech(filenames: string[]): string {
  if (!filenames.length) return "Upload failed sir, please try again.";
  if (filenames.length === 1) {
    return `Received ${filenames[0]}, sir. What would you like me to do with it?`;
  }
  const names = filenames.slice(0, 4).join(", ");
  const extra = filenames.length > 4 ? ` and ${filenames.length - 4} more` : "";
  return `Received ${filenames.length} files — ${names}${extra}. What would you like me to do with them?`;
}

export { isImageMime };
