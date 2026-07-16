/**
 * TTS pronunciation lexicon — niche pool-industry and Arizona terms the voice
 * model fumbles. Applied ONLY on the audio path (services/tts.ts), never to
 * displayed text, so the screen keeps real spelling while the voice gets a
 * phonetic respelling it can't misread.
 *
 * ElevenLabs' proper fix for this (phoneme tags / PLS dictionaries) only works
 * on their older English models — for multilingual v2 the supported approach
 * is exactly this: alias/respell the word before synthesis.
 *
 * Add entries as Arthur reports them: key = the real word (matched on word
 * boundaries, case-insensitive), value = how it should be SOUNDED OUT.
 */

const LEXICON: [RegExp, string][] = [
  // ── Pool construction terms ──
  [/\bgunite\b/gi, 'gunn-ite'],                 // GUN-ite, not "gyoo-nite"
  [/\bshotcrete\b/gi, 'shot-creet'],
  [/\bpebble\s?tec\b/gi, 'pebble tek'],
  [/\btravertine\b/gi, 'travver-teen'],         // -teen, not -tine
  [/\bbaja\b/gi, 'bah-hah'],                    // baja shelf/step
  [/\bramada\b/gi, 'ruh-mah-dah'],
  [/\bkool\s?deck\b/gi, 'cool deck'],
  [/\bmuriatic\b/gi, 'myur-ee-attic'],          // muriatic acid
  [/\bcantilever(ed)?\b/gi, 'canti-leever$1'],
  [/\bmastic\b/gi, 'mass-tick'],                // deck joint mastic
  [/\bwaterline\b/gi, 'water-line'],

  // ── Acronyms that get read as words ──
  [/\bROC\b/g, 'R O C'],                        // AZ Registrar of Contractors — not "rock"
  [/\bHOA\b/g, 'H O A'],
  [/\bAPS\b/g, 'A P S'],                        // the utility
  [/\bSRP\b/g, 'S R P'],
  [/\bPSI\b/g, 'P S I'],

  // ── Arizona ──
  [/\bAZ\b/g, 'Arizona'],                       // "Phoenix, AZ" — not "azz"
  [/\bTempe\b/gi, 'tem-pee'],                   // not "temp"
];

/** Respell niche words for speech. Audio path only — never show this text. */
export function respellForTts(text: string): string {
  let out = text;
  for (const [pattern, spoken] of LEXICON) {
    out = out.replace(pattern, spoken);
  }
  return out;
}
