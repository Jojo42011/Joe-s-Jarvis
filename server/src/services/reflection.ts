import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_FAST_MODEL } from '../config/models';
import { getDb } from '../db/schema';
import { insertFact } from '../db/memory';
import { embedText, vectorToBuffer } from './embeddings';
import { safeJsonParse } from '../utils/safeJson';
import { broadcast } from '../ws/hub';

/**
 * The Reflection Engine — the difference between a memory pile and a mind.
 *
 * Periodically Jarvis reads his recent raw memories (facts + episodes) and asks
 * himself: "What higher-level truths about Joe and the business do these
 * imply?" Those inferences are written back as first-class memories
 * (category 'reflection'), so future recall surfaces UNDERSTANDING, not just
 * observations — and reflections can themselves be reflected upon over time.
 *
 * This is the mechanism behind believable, deepening agents in the research
 * (Stanford Generative Agents: recency + importance + relevance + reflection).
 */

const MIN_SOURCE_FACTS = 5;

interface ReflectionOut {
  reflections?: { insight: string; importance?: number; keywords?: string }[];
}

const REFLECTION_PROMPT = `You are the reflective layer of Joe's digital twin (Jarvis), owner of
Totally Outdoors LLC, a landscaping, hardscaping, and excavating company in Millersburg, Ohio.

Below are recent OBSERVATIONS (facts) and EPISODES from Joe's world. Step back
and infer higher-level insights: patterns in how he decides, recurring risks,
what clients/subs/vendors reliably do, seasonal or operational tendencies, and
implications he may not have stated outright. Prefer non-obvious synthesis over
restating a single fact.

Return ONLY valid JSON, no markdown:
{"reflections":[{"insight":"one clear sentence","importance":1-10,"keywords":"comma,separated"}]}
Return 3-5 reflections. If there is genuinely nothing to synthesize, return {"reflections":[]}.`;

export async function runReflection(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 0;

  const db = getDb();

  // Source material: recent raw memories, excluding prior reflections so the
  // engine synthesizes from observations rather than looping on itself.
  const facts = db.prepare(`
    SELECT content FROM facts
    WHERE superseded_by IS NULL AND (category IS NULL OR category != 'reflection')
    ORDER BY created_at DESC
    LIMIT 30
  `).all() as { content: string }[];

  if (facts.length < MIN_SOURCE_FACTS) return 0;

  const episodes = db.prepare(`
    SELECT summary FROM episodes ORDER BY created_at DESC LIMIT 8
  `).all() as { summary: string }[];

  const context = [
    'OBSERVATIONS:\n' + facts.map((f) => `- ${f.content}`).join('\n'),
    episodes.length ? 'EPISODES:\n' + episodes.map((e) => `- ${e.summary}`).join('\n') : '',
  ].filter(Boolean).join('\n\n');

  let parsed: ReflectionOut | null = null;
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: ANTHROPIC_FAST_MODEL,
      max_tokens: 1024,
      system: REFLECTION_PROMPT,
      messages: [{ role: 'user', content: context }],
    });
    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return 0;
    parsed = safeJsonParse<ReflectionOut>(block.text);
  } catch (err) {
    console.error('[Reflection] error:', err instanceof Error ? err.message : err);
    return 0;
  }

  if (!parsed?.reflections?.length) return 0;

  let stored = 0;
  for (const r of parsed.reflections) {
    const insight = r.insight?.trim();
    if (!insight) continue;
    const importance = Math.max(1, Math.min(Number(r.importance) || 7, 10));
    const vec = await embedText(insight);
    // Reflections carry above-baseline strength — they are earned conclusions.
    insertFact(insight, 'reflection', r.keywords, 1.2, importance, vec ? vectorToBuffer(vec) : null);
    stored++;
  }

  if (stored > 0) {
    broadcast({ type: 'memory_updated' });
    console.log(`[Reflection] Synthesized ${stored} higher-level insight(s)`);
  }
  return stored;
}
