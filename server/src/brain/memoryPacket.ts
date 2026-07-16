import { getIdentityProfile, getLatestSynthesis, getRecentEpisodes, getTopRules, searchFacts, searchFactsSemantic } from '../db/memory';
import { embedText } from '../services/embeddings';

const MEMORY_PACKET_CHAR_CAP = 2500;

export interface MemoryPacket {
  text: string;
  factCount: number;
  ruleCount: number;
  episodeCount: number;
  confidence: number;
}

// Below this, keyword recall is considered "thin" and worth paying the embedding
// round-trip to try to do better. Above it, keyword hits are already good enough
// that semantic search would just confirm the same answer slower.
const KEYWORD_CONFIDENCE_FLOOR = 0.32;
const MIN_STRONG_KEYWORD_HITS = 4;

export async function getMemoryPacket(query: string): Promise<MemoryPacket> {
  const q = (query || '').trim();

  // Keyword recall is a pure in-memory SQLite scan — effectively free. Try it
  // first and only pay for an embedding API round-trip (a real network hop on
  // the latency-critical path, before the LLM call can even start) when the
  // keyword match looks weak. Most operational chatter already scores well on
  // keyword overlap with stored facts, so this skips the embedding call on the
  // majority of turns without losing recall quality — semantic search still
  // kicks in whenever keyword search alone wouldn't cut it.
  let facts = q.length >= 3 ? searchFacts(query, 8) : [];
  const keywordLooksThin = facts.length < MIN_STRONG_KEYWORD_HITS || (facts[0]?.score ?? 0) < KEYWORD_CONFIDENCE_FLOOR;

  if (q.length >= 12 && keywordLooksThin) {
    const queryEmbedding = await embedText(q);
    if (queryEmbedding) facts = searchFactsSemantic(query, queryEmbedding, 8);
  }
  const rules = getTopRules(5);
  const episodes = getRecentEpisodes(3);
  const synthesis = getLatestSynthesis();
  const identity = getIdentityProfile();

  const lines: string[] = [];

  if (facts.length > 0) {
    lines.push('### FACTS');
    for (const f of facts) {
      lines.push(`- ${f.content}`);
    }
  }

  if (rules.length > 0) {
    lines.push('### RULES');
    for (const r of rules) {
      lines.push(`- [${r.confidence.toFixed(2)}] ${r.rule}`);
    }
  }

  if (episodes.length > 0) {
    lines.push('### RECENT EPISODES');
    for (const e of episodes) {
      lines.push(`- ${e.summary}`);
    }
  }

  if (synthesis) {
    lines.push('### WEEKLY SYNTHESIS');
    lines.push(synthesis.slice(0, 400));
  }

  const identityLines = identity.filter((d) => d.confidence > 0);
  if (identityLines.length > 0) {
    lines.push('### IDENTITY PROFILE');
    for (const d of identityLines) {
      lines.push(`- ${d.dimension}: ${Math.round(d.confidence * 100)}% mapped`);
    }
  }

  if (lines.length === 0) {
    lines.push('[Memory empty — founder intake not yet seeded.]');
  }

  const text = lines.join('\n').slice(0, MEMORY_PACKET_CHAR_CAP);
  const confidence = facts.length > 0
    ? facts.reduce((s, f) => s + f.score, 0) / facts.length
    : 0;

  return {
    text,
    factCount: facts.length,
    ruleCount: rules.length,
    episodeCount: episodes.length,
    confidence,
  };
}
