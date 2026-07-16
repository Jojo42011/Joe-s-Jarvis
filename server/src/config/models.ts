/** OpenAI — voice/chat brain (agentLoop) */
export const ARLO_MODEL =
  process.env.ARLO_MODEL || 'gpt-4o';

export const ARLO_FAST_MODEL =
  process.env.ARLO_FAST_MODEL || 'gpt-4o-mini';

/** Anthropic — SEO, crons, memory extraction (unchanged stack) */
export const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

export const ANTHROPIC_FAST_MODEL =
  process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001';

// Arlo is a VOICE assistant — the system prompt asks for 1–3 sentences unless
// Arthur explicitly wants depth. 8192 was a wide-open ceiling that let replies
// ramble and added tail latency; 900 tokens (~650 words) is still generous for
// a "give me the full rundown" moment but bounds the normal case tightly.
export const ARLO_MAX_TOKENS = parseInt(
  process.env.ARLO_MAX_TOKENS || '900',
  10
);
