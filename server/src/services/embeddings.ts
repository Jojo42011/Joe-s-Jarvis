import OpenAI from 'openai';
import { getDb } from '../db/schema';

/**
 * Semantic embeddings for memory retrieval (the "relevance" leg of hybrid recall).
 *
 * Mirrors the Aethon design: every fact is embedded so memories can be found by
 * MEANING, not just keyword overlap. Entirely optional — if OPENAI_API_KEY is
 * absent or a call fails, every function degrades gracefully to null and the
 * memory system falls back to keyword + strength + recency + importance scoring.
 * The clone never crashes for lack of an embedding.
 */

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

let warnedNoKey = false;

export function embeddingsEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/** Embed a single string. Returns null on any failure (never throws). */
export async function embedText(text: string): Promise<Float32Array | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (!warnedNoKey) {
      console.log('[Memory] OPENAI_API_KEY missing — semantic recall disabled, using keyword fallback');
      warnedNoKey = true;
    }
    return null;
  }
  const clean = (text || '').trim();
  if (!clean) return null;

  try {
    const client = new OpenAI({ apiKey });
    const res = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: clean.slice(0, 8000),
    });
    const vec = res.data?.[0]?.embedding;
    if (!vec || !vec.length) return null;
    return Float32Array.from(vec);
  } catch (err) {
    console.error('[Memory] embedText failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Pack a Float32Array into a Buffer for BLOB storage in SQLite. */
export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Restore a Float32Array from a stored BLOB. */
export function bufferToVector(buf: Buffer): Float32Array {
  // Copy to guarantee correct byte alignment for Float32Array.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

/** Cosine similarity in [-1, 1]; 0 if either vector is empty or mismatched. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Startup backfill: embed up to `limit` facts that have no vector yet.
 * Non-blocking and best-effort — fire and forget from app boot.
 */
export async function backfillEmbeddings(limit = 100): Promise<void> {
  if (!embeddingsEnabled()) return;
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  const rows = db.prepare(`
    SELECT id, content FROM facts
    WHERE embedding IS NULL AND superseded_by IS NULL
    ORDER BY strength DESC
    LIMIT ?
  `).all(limit) as { id: number; content: string }[];

  if (rows.length === 0) return;
  console.log(`[Memory] Backfilling embeddings for ${rows.length} fact(s)…`);

  const update = db.prepare('UPDATE facts SET embedding = ? WHERE id = ?');
  let done = 0;
  for (const row of rows) {
    const vec = await embedText(row.content);
    if (vec) {
      update.run(vectorToBuffer(vec), row.id);
      done++;
    }
    // Gentle throttle so backfill never hammers the API.
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`[Memory] Embedding backfill complete — ${done}/${rows.length} embedded`);
}
