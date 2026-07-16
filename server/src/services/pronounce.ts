/**
 * TTS pronunciation lexicon — niche landscaping-industry terms the voice
 * model fumbles. Applied ONLY on the audio path (services/tts.ts), never to
 * displayed text, so the screen keeps real spelling while the voice gets a
 * phonetic respelling it can't misread.
 *
 * ElevenLabs' proper fix for this (phoneme tags / PLS dictionaries) only works
 * on their older English models — for multilingual v2 the supported approach
 * is exactly this: alias/respell the word before synthesis.
 *
 * REBUILT EMPIRICALLY for Totally Outdoors: this is a deliberately small
 * starter set of genuinely mispronunciation-prone landscaping terms. Add
 * entries as Joe reports real mispronunciations: key = the real word (matched
 * on word boundaries, case-insensitive), value = how it should be SOUNDED OUT.
 */

const LEXICON: [RegExp, string][] = [
  // ── Hardscape / earthwork terms ──
  [/\bhardscape(s|d)?\b/gi, 'hard-scape$1'],
  [/\bpaver(s)?\b/gi, 'pay-ver$1'],             // not "pah-ver"
  [/\bswale(s)?\b/gi, 'swayl$1'],
  [/\briprap\b/gi, 'rip-rap'],
  [/\bgeotextile(s)?\b/gi, 'gee-oh-tex-tile$1'],

  // ── Plant names ──
  [/\bTaxus\b/gi, 'tax-us'],
  [/\barborvitae(s)?\b/gi, 'ar-bor-vy-tee$1'],
  [/\bhosta(s)?\b/gi, 'hoss-tuh$1'],
  [/\bliriope\b/gi, 'lih-rye-oh-pee'],
  [/\bfescue\b/gi, 'fess-kyoo'],
];

/** Respell niche words for speech. Audio path only — never show this text. */
export function respellForTts(text: string): string {
  let out = text;
  for (const [pattern, spoken] of LEXICON) {
    out = out.replace(pattern, spoken);
  }
  return out;
}
