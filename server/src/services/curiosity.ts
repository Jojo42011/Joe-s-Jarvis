import { getDb } from '../db/schema';
import { CURIOSITY_QUESTIONS, IDENTITY_DIMENSIONS, IdentityDimension } from '../config/curiosity';
import { insertFact } from '../db/memory';
import { embedText, vectorToBuffer } from './embeddings';

export function getDimensionConfidence(): Map<IdentityDimension, number> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT dimension,
           COUNT(CASE WHEN answer IS NOT NULL THEN 1 END) as answered
    FROM identity_questions
    GROUP BY dimension
  `).all() as { dimension: string; answered: number }[];

  const map = new Map<IdentityDimension, number>();
  for (const dim of IDENTITY_DIMENSIONS) map.set(dim, 0);
  for (const row of rows) {
    const dim = row.dimension as IdentityDimension;
    if (IDENTITY_DIMENSIONS.includes(dim)) {
      map.set(dim, Math.min(row.answered * 0.2, 1.0));
    }
  }
  return map;
}

function getAskedQuestions(): Set<string> {
  const db = getDb();
  const rows = db.prepare('SELECT question FROM identity_questions').all() as { question: string }[];
  return new Set(rows.map((r) => r.question));
}

function getLastQuestionTime(): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT asked_at FROM identity_questions ORDER BY asked_at DESC LIMIT 1'
  ).get() as { asked_at: string } | undefined;
  return row ? new Date(row.asked_at).getTime() : 0;
}

export function maybeGenerateCuriosityQuestion(): string | null {
  if (Math.random() > 0.3) return null;

  const lastAsked = getLastQuestionTime();
  if (Date.now() - lastAsked < 3600000) return null;

  const confidence = getDimensionConfidence();
  const asked = getAskedQuestions();

  const sorted = [...IDENTITY_DIMENSIONS].sort(
    (a, b) => (confidence.get(a) ?? 0) - (confidence.get(b) ?? 0)
  );

  for (const dim of sorted) {
    const pool = CURIOSITY_QUESTIONS[dim];
    for (const q of pool) {
      if (!asked.has(q)) {
        const db = getDb();
        db.prepare(
          'INSERT INTO identity_questions (dimension, question) VALUES (?, ?)'
        ).run(dim, q);
        return q;
      }
    }
  }

  return null;
}

export async function recordCuriosityAnswer(question: string, answer: string): Promise<void> {
  const db = getDb();
  db.prepare(`
    UPDATE identity_questions
    SET answer = ?, answered_at = CURRENT_TIMESTAMP
    WHERE question = ? AND answer IS NULL
  `).run(answer, question);

  const row = db.prepare(
    'SELECT dimension FROM identity_questions WHERE question = ?'
  ).get(question) as { dimension: string } | undefined;

  if (row) {
    // Identity answers are the highest-value memories the clone owns.
    const content = `[${row.dimension}] ${answer}`;
    const vec = await embedText(content);
    insertFact(
      content,
      'identity',
      row.dimension.toLowerCase(),
      1.5,
      9,
      vec ? vectorToBuffer(vec) : null
    );
  }
}
