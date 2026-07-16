import { getDb } from './schema';
import { IDENTITY_DIMENSIONS } from '../config/curiosity';
import { bufferToVector, cosineSimilarity } from '../services/embeddings';

export interface FactRow {
  id: number;
  content: string;
  category: string | null;
  keywords: string | null;
  strength: number;
  importance: number;
  last_accessed: string;
  embedding?: Buffer | null;
}

export interface ScoredFact {
  id: number;
  content: string;
  category: string | null;
  score: number;
}

function keywordOverlap(query: string, text: string): number {
  const qWords = new Set(
    query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  );
  if (qWords.size === 0) return 0;
  const tWords = text.toLowerCase().split(/\W+/);
  let hits = 0;
  for (const w of tWords) {
    if (qWords.has(w)) hits++;
  }
  return Math.min(hits / qWords.size, 1);
}

function recencyScore(lastAccessed: string): number {
  const days = (Date.now() - new Date(lastAccessed).getTime()) / 86400000;
  return 1 / (days + 1);
}

function reinforce(top: ScoredFact[]): void {
  if (top.length === 0) return;
  const db = getDb();
  const bump = db.prepare(
    'UPDATE facts SET last_accessed = CURRENT_TIMESTAMP, strength = MIN(strength + 0.02, 1.5) WHERE id = ?'
  );
  for (const f of top) bump.run(f.id);
}

/** normalize importance (stored 1–10) into [0,1]. */
function normImportance(importance: number | null | undefined): number {
  const v = typeof importance === 'number' ? importance : 5;
  return Math.max(0, Math.min(v / 10, 1));
}

/**
 * Keyword-only retrieval (fallback when semantic embeddings are unavailable).
 * Blends keyword overlap, strength (reinforcement), recency, and importance.
 */
export function searchFacts(query: string, limit = 8): ScoredFact[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, content, category, keywords, strength, importance, last_accessed
    FROM facts
    WHERE superseded_by IS NULL
    ORDER BY strength DESC
    LIMIT 200
  `).all() as FactRow[];

  const scored = rows.map((row) => {
    const kw = keywordOverlap(query, `${row.content} ${row.keywords || ''}`);
    const recency = recencyScore(row.last_accessed);
    const score =
      kw * 0.50 +
      row.strength * 0.15 +
      recency * 0.10 +
      normImportance(row.importance) * 0.25;
    return { id: row.id, content: row.content, category: row.category, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  reinforce(top);
  return top;
}

/**
 * Hybrid semantic retrieval — the Aethon recall model.
 * Requires a precomputed query embedding (async work is done by the caller).
 *   score = relevance(cosine)·0.50 + keyword·0.20 + strength·0.10
 *         + recency·0.05 + importance·0.15
 * Facts without a stored vector fall back to keyword relevance so nothing is lost.
 */
export function searchFactsSemantic(
  query: string,
  queryEmbedding: Float32Array,
  limit = 8
): ScoredFact[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, content, category, keywords, strength, importance, last_accessed, embedding
    FROM facts
    WHERE superseded_by IS NULL
    ORDER BY strength DESC
    LIMIT 400
  `).all() as FactRow[];

  const scored = rows.map((row) => {
    const kw = keywordOverlap(query, `${row.content} ${row.keywords || ''}`);
    let relevance = kw; // fallback relevance if no vector
    if (row.embedding) {
      try {
        const sim = cosineSimilarity(queryEmbedding, bufferToVector(row.embedding));
        relevance = Math.max(0, sim); // clamp negative similarity to 0
      } catch {
        relevance = kw;
      }
    }
    const recency = recencyScore(row.last_accessed);
    const score =
      relevance * 0.50 +
      kw * 0.20 +
      row.strength * 0.10 +
      recency * 0.05 +
      normImportance(row.importance) * 0.15;
    return { id: row.id, content: row.content, category: row.category, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  reinforce(top);
  return top;
}

export function getTopRules(limit = 5): { rule: string; confidence: number }[] {
  const db = getDb();
  return db.prepare(`
    SELECT rule, confidence FROM rules
    ORDER BY confidence DESC
    LIMIT ?
  `).all(limit) as { rule: string; confidence: number }[];
}

export function getRecentEpisodes(limit = 3): { summary: string; emotional_tone: string | null }[] {
  const db = getDb();
  return db.prepare(`
    SELECT summary, emotional_tone FROM episodes
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as { summary: string; emotional_tone: string | null }[];
}

export function getLatestSynthesis(): string | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT content FROM syntheses ORDER BY created_at DESC LIMIT 1'
  ).get() as { content: string } | undefined;
  return row?.content ?? null;
}

export function getIdentityProfile(): { dimension: string; confidence: number }[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT dimension,
           COUNT(CASE WHEN answer IS NOT NULL THEN 1 END) as answered
    FROM identity_questions
    GROUP BY dimension
  `).all() as { dimension: string; answered: number }[];

  const map = new Map(rows.map((r) => [r.dimension, Math.min(r.answered * 0.2, 1)]));

  return IDENTITY_DIMENSIONS.map((dim) => ({
    dimension: dim,
    confidence: map.get(dim) ?? 0,
  }));
}

export function insertFact(
  content: string,
  category?: string,
  keywords?: string,
  strength = 1.0,
  importance = 5.0,
  embedding?: Buffer | null
): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO facts (content, category, keywords, strength, importance, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(content, category ?? null, keywords ?? null, strength, importance, embedding ?? null);
  return Number(result.lastInsertRowid);
}

export function insertEpisode(
  summary: string,
  keyDecisions?: string,
  emotionalTone?: string,
  entities?: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO episodes (summary, key_decisions, emotional_tone, entities)
    VALUES (?, ?, ?, ?)
  `).run(summary, keyDecisions ?? null, emotionalTone ?? null, entities ?? null);
}

export function findOrCreateNode(name: string, type: string, properties?: string): number {
  const db = getDb();
  const normalized = name.trim().toLowerCase();
  const existing = db.prepare('SELECT id, name FROM nodes').all() as { id: number; name: string }[];

  for (const node of existing) {
    const n = node.name.toLowerCase();
    if (n === normalized) return node.id;
    if (n.includes(normalized) || normalized.includes(n)) return node.id;
    const nWords = new Set(n.split(/\W+/));
    const qWords = normalized.split(/\W+/);
    const overlap = qWords.filter((w) => nWords.has(w)).length;
    if (overlap / Math.max(qWords.length, 1) >= 0.6) return node.id;
  }

  const result = db.prepare(
    'INSERT INTO nodes (name, type, properties) VALUES (?, ?, ?)'
  ).run(name.trim(), type, properties ?? '{}');
  return Number(result.lastInsertRowid);
}

export function insertEdge(sourceId: number, targetId: number, relationship: string, strength = 1.0): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO edges (source_id, target_id, relationship, strength)
    VALUES (?, ?, ?, ?)
  `).run(sourceId, targetId, relationship, strength);
}

export function upsertRule(rule: string, delta = 0.1): void {
  const db = getDb();
  const existing = db.prepare('SELECT id, confidence FROM rules WHERE rule = ?').get(rule) as
    | { id: number; confidence: number }
    | undefined;

  if (existing) {
    db.prepare(`
      UPDATE rules SET confidence = MIN(confidence + ?, 1.0),
      last_reinforced = CURRENT_TIMESTAMP WHERE id = ?
    `).run(delta, existing.id);
  } else {
    db.prepare('INSERT INTO rules (rule, confidence) VALUES (?, ?)').run(rule, 0.5 + delta);
  }
}

export function getMemoryStats() {
  const db = getDb();
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;

  return {
    facts: count('facts'),
    episodes: count('episodes'),
    nodes: count('nodes'),
    edges: count('edges'),
    rules: count('rules'),
    syntheses: count('syntheses'),
    identityQuestions: count('identity_questions'),
  };
}

export function getAllMemoryData() {
  const db = getDb();
  return {
    facts: db.prepare('SELECT * FROM facts WHERE superseded_by IS NULL ORDER BY strength DESC LIMIT 100').all(),
    episodes: db.prepare('SELECT * FROM episodes ORDER BY created_at DESC LIMIT 20').all(),
    nodes: db.prepare('SELECT * FROM nodes ORDER BY created_at DESC').all(),
    edges: db.prepare('SELECT * FROM edges').all(),
    rules: db.prepare('SELECT * FROM rules ORDER BY confidence DESC').all(),
    stats: getMemoryStats(),
    identityProfile: getIdentityProfile(),
  };
}

export function getRetrievalConfidence(facts: ScoredFact[]): number {
  if (facts.length === 0) return 0;
  return facts.reduce((s, f) => s + f.score, 0) / facts.length;
}
