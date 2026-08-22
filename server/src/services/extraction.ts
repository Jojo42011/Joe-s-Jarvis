import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '../config/anthropic';
import { ANTHROPIC_FAST_MODEL } from '../config/models';
import { safeJsonParse } from '../utils/safeJson';
import {
  findOrCreateNode,
  insertEdge,
  insertEpisode,
  insertFact,
  upsertRule,
} from '../db/memory';
import { embedText, vectorToBuffer } from './embeddings';
import { broadcast } from '../ws/hub';

interface ExtractionResult {
  facts?: { content: string; category?: string; keywords?: string; importance?: number }[];
  entities?: { name: string; type: string; relationship?: string; target?: string }[];
  rules?: string[];
  episode?: {
    summary: string;
    key_decisions?: string;
    emotional_tone?: string;
    entities?: string;
  };
}

const EXTRACTION_PROMPT = `You extract structured memory from a conversation transcript.
Return ONLY valid JSON — no markdown, no backticks.
Schema:
{
  "facts": [{"content": "...", "category": "business|identity|client", "keywords": "...", "importance": 1-10}],
  "entities": [{"name": "...", "type": "person|company|project|tool|concept", "relationship": "...", "target": "..."}],
  "rules": ["business rule reinforced"],
  "episode": {"summary": "2-3 sentences", "key_decisions": "...", "emotional_tone": "...", "entities": "comma-separated"}
}
If nothing worth storing, return {"facts":[],"entities":[],"rules":[],"episode":null}`;

export async function runPostConversationExtraction(
  transcript: { role: string; content: string }[]
): Promise<void> {
  const apiKey = anthropicApiKey();
  if (!apiKey || transcript.length < 2) return;

  const text = transcript
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n');

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: ANTHROPIC_FAST_MODEL,
    max_tokens: 2048,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') return;

  const parsed = safeJsonParse<ExtractionResult>(block.text);
  if (!parsed) {
    console.error('[Jarvis] Extraction JSON parse failed');
    return;
  }

  for (const fact of parsed.facts ?? []) {
    const content = fact.content?.trim();
    if (!content) continue;
    const importance = Math.max(1, Math.min(Number(fact.importance) || 5, 10));
    const vec = await embedText(content);
    insertFact(
      content,
      fact.category,
      fact.keywords,
      1.0,
      importance,
      vec ? vectorToBuffer(vec) : null
    );
  }

  for (const entity of parsed.entities ?? []) {
    if (!entity.name?.trim()) continue;
    const nodeId = findOrCreateNode(entity.name, entity.type || 'concept');
    if (entity.target && entity.relationship) {
      const targetId = findOrCreateNode(entity.target, 'concept');
      insertEdge(nodeId, targetId, entity.relationship);
    }
  }

  for (const rule of parsed.rules ?? []) {
    if (rule?.trim()) upsertRule(rule.trim());
  }

  if (parsed.episode?.summary) {
    insertEpisode(
      parsed.episode.summary,
      parsed.episode.key_decisions,
      parsed.episode.emotional_tone,
      parsed.episode.entities
    );
  }

  broadcast({ type: 'memory_updated' });
  console.log('[Jarvis] Memory extraction complete');
}
