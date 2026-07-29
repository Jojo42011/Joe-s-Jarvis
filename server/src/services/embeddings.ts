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
// gemini-embedding-001 is what Joe's key actually serves — the older
// text-embedding-004 404s on this project. Overridable if that changes.
const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';

let warnedNoKey = false;

/**
 * Which provider backs semantic recall.
 *
 * OpenAI wins when its key is present (it is what the vectors were originally
 * written with), but Gemini is a first-class alternative so a deployment holding
 * only GEMINI_API_KEY still gets meaning-based recall instead of silently
 * dropping to keyword matching.
 */
export function embeddingProvider(): 'openai' | 'gemini' | null {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

export function embeddingsEnabled(): boolean {
  return embeddingProvider() !== null;
}

/**
 * Vectors from different providers have different dimensions and live in
 * different spaces, so they can never be compared. cosineSimilarity already
 * returns 0 on a length mismatch, which means a provider switch degrades to
 * keyword scoring rather than producing confident nonsense — the stored vectors
 * from the old provider simply stop matching until they are re-embedded.
 */
async function embedViaGemini(clean: string): Promise<Float32Array | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text: clean.slice(0, 8000) }] },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini embedContent returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json() as { embedding?: { values?: number[] } };
  const vec = json.embedding?.values;
  if (!vec || !vec.length) return null;
  return Float32Array.from(vec);
}

async function embedViaOpenAI(clean: string): Promise<Float32Array | null> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: clean.slice(0, 8000),
  });
  const vec = res.data?.[0]?.embedding;
  if (!vec || !vec.length) return null;
  return Float32Array.from(vec);
}

/** Embed a single string. Returns null on any failure (never throws). */
export async function embedText(text: string): Promise<Float32Array | null> {
  const provider = embeddingProvider();
  if (!provider) {
    if (!warnedNoKey) {
      console.log('[Memory] no OPENAI_API_KEY or GEMINI_API_KEY — semantic recall disabled, using keyword fallback');
      warnedNoKey = true;
    }
    return null;
  }
  const clean = (text || '').trim();
  if (!clean) return null;

  try {
    return provider === 'openai' ? await embedViaOpenAI(clean) : await embedViaGemini(clean);
  } catch (err) {
    console.error(`[Memory] embedText failed (${provider}):`, err instanceof Error ? err.message : err);
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
  console.log(`[Memory] Backfilling embeddings for ${rows.length} fact(s) via ${embeddingProvider()}…`);

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
