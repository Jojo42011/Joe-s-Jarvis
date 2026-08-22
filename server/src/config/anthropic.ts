/**
 * Anthropic kill switch — incident response.
 *
 * The key was never committed to this repo (full history is clean). It was
 * being spent through the app itself: the platform runs with no login wall
 * unless AUTH_ENABLED=1, on a public Fly URL, from a public repository — so
 * every Claude-backed endpoint (/api/brain/*, the unsigned Vapi webhook) was
 * an open proxy anyone could call for free.
 *
 * Claude is therefore switched off at the source. This module is the ONLY
 * place ANTHROPIC_API_KEY may be read, and while ANTHROPIC_ENABLED is false
 * it returns null unconditionally — so every call site falls back to the
 * "key not configured" branch it already handles, and no code path can
 * construct an Anthropic client or spend a token.
 *
 * Deliberately a hardcoded constant, not an env flag: during an incident the
 * brain must not be re-armed by a stray environment variable. Turning Claude
 * back on is a code change plus a deploy, and must not happen until:
 *   1. the exposed key is revoked and replaced at console.anthropic.com, and
 *   2. AUTH_ENABLED=1 is set so the endpoints are behind the login wall.
 */

export const ANTHROPIC_ENABLED = false;

/** The Anthropic key, or null while the brain is switched off. */
export function anthropicApiKey(): string | null {
  if (!ANTHROPIC_ENABLED) return null;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  return key || null;
}
