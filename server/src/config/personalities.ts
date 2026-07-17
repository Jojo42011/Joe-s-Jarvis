/**
 * Jarvis's selectable personalities. Each is a layer on top of the base identity
 * (who Joe is, the business, the boundaries) — it changes HOW he talks, not
 * WHAT he knows. Each carries its own ElevenLabs voice so switching personality
 * switches the voice too. Selection is stored in system_state.
 *
 * Voice IDs are ElevenLabs voices resolved by ID at TTS call time — either a
 * premade voice (available on every account) or a public Voice Library pick,
 * which resolves by ID directly with no need to "add" it to the account first.
 */

export interface Personality {
  id: string;
  name: string;
  blurb: string;   // short UI description
  voiceId: string; // ElevenLabs voice for this personality
  prompt: string;  // injected into the system prompt when selected
}

export const DEFAULT_PERSONALITY = 'operator';

export const PERSONALITIES: Personality[] = [
  {
    id: 'operator',
    name: 'Operator',
    blurb: 'Calm, minimal, all signal. Fewest words, most output.',
    // Joe's pick from the ElevenLabs Voice Library. Easy to swap: paste any
    // other ElevenLabs Voice ID here (from the Voice Library or a custom
    // clone) to try another.
    voiceId: 'DwwuoY7Uz8AP8zrY5TAo',
    prompt: `PERSONALITY — OPERATOR.
Calm, minimal, all business. The fewest words that fully answer — no fluff, no
jokes, no profanity. Lead with the decision or the status, stop talking. This is
the voice for heads-down work: respect his focus, give him signal, get out of the
way.`,
  },
];

export function getPersonalityById(id: string | null | undefined): Personality {
  return PERSONALITIES.find((p) => p.id === id) || PERSONALITIES.find((p) => p.id === DEFAULT_PERSONALITY)!;
}
