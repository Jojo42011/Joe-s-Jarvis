const SENTENCE_END = /([.!?]+)\s+/;

// Common abbreviations that end in a period but aren't a real sentence boundary
// ("Mr. Smith", "e.g. tile", "approx. $40k"). Splitting on these mid-thought is
// exactly the "rough transition" / choppy cadence that makes TTS sound broken —
// so we look past them for the next REAL sentence end instead.
const ABBREV_RE = /\b(mr|mrs|ms|dr|jr|sr|st|ave|blvd|rd|ln|ct|ft|no|vs|etc|approx|inc|co|corp|e\.g|i\.e|gen|lt|col|sgt|capt|maj|adm|rev|sen|gov|prof|ph\.d|u\.s|a\.m|p\.m)\.$/i;

// Later chunks merge up to ~MIN_TTS_CHARS so speech flows smoothly (no per-fragment
// prosody restart / "stutter"). But the VERY FIRST chunk ships at a much lower
// threshold so Arlo starts talking ~0.5–1s sooner (time-to-first-word), then the
// rest catches up smoothly while he's already speaking.
const MIN_TTS_CHARS = 55;
// Ship the FIRST complete sentence the instant it lands (even a short "Got it.")
// so Arlo starts talking immediately; only later chunks merge for smoothness.
const FIRST_CHUNK_CHARS = 1;

// Belt-and-suspenders: the system prompt tells the model never to use markdown
// since it's spoken, not read — but if it slips (a bullet list, **bold** on a
// number), literal formatting symbols read as garbage/garble the audio around
// them. Strip it from every finalized phrase before it ships to TTS.
function sanitizeForSpeech(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')          // **bold**
    .replace(/__(.+?)__/g, '$1')              // __bold__
    .replace(/(?<!\w)\*(\S(?:.*?\S)?)\*(?!\w)/g, '$1') // *italic*
    .replace(/(?<!\w)_(\S(?:.*?\S)?)_(?!\w)/g, '$1')   // _italic_
    .replace(/`{1,3}([^`]*?)`{1,3}/g, '$1')   // `code` / ```code```
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // # Headers
    .replace(/^\s*[-*+]\s+/gm, '')            // - bullet / * bullet
    .replace(/^\s*\d+[.)]\s+/gm, '')          // 1. numbered list
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) -> text
    // Units & symbols: eleven turbo/flash v2.5 skip full text normalization for
    // speed, so raw symbols can come out garbled or glitch the words around
    // them ("105°F"). Spell them out the way they should be spoken.
    // URLs/domains read badly as raw tokens ("aquaticpoolaz.com" comes out
    // garbled). Spell the brand domain the way a person says it, and make any
    // other bare domain at least say "dot com" cleanly.
    .replace(/https?:\/\/(www\.)?/gi, '')
    .replace(/\baquaticpoolaz\.com\b/gi, 'aquatic pool A Z dot com')
    .replace(/\b([a-z0-9-]{2,})\.(com|net|org|io|ai)\b/gi, '$1 dot $2')
    .replace(/°\s?F\b/g, ' degrees Fahrenheit')
    .replace(/°\s?C\b/g, ' degrees Celsius')
    .replace(/°/g, ' degrees')
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/\s&\s/g, ' and ')
    .replace(/\bsq\.?\s?ft\b\.?/gi, 'square feet')
    .replace(/\blin\.?\s?ft\b\.?/gi, 'linear feet')
    // Emoji and pictographs read as noise or glitch the neighboring word.
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F02F}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+([.,!?;:])/g, '$1')          // no orphaned space before punctuation
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Index just past the next REAL sentence end in `text`, or -1 if none yet. */
function findSentenceEnd(text: string): number {
  let searchFrom = 0;
  while (true) {
    const m = text.slice(searchFrom).match(SENTENCE_END);
    if (!m || m.index === undefined) return -1;
    const idx = searchFrom + m.index;
    const endIdx = idx + m[0].length;
    const before = text.slice(Math.max(0, idx - 12), idx + 1);
    if (ABBREV_RE.test(before.trim())) {
      searchFrom = endIdx; // false boundary — keep looking past it
      continue;
    }
    // A bare "..." is a trailing-off pause ("Wait... actually"), not a real
    // sentence boundary — keep looking past it too, unless it's followed by a
    // capital letter (a genuine new sentence, e.g. "And then... It worked.").
    if (/^\.\.\.$/.test(m[1]) && !/^[A-Z]/.test(text.slice(endIdx))) {
      searchFrom = endIdx;
      continue;
    }
    return endIdx;
  }
}

/**
 * Yields speakable phrases from a streaming token buffer. `emitted` tracks how many
 * phrases have shipped across calls so the first one can go out fast. Keeps the
 * incomplete tail in the buffer for the next chunk.
 */
export function drainSentences(buffer: { text: string; emitted?: number }): string[] {
  if (buffer.emitted == null) buffer.emitted = 0;
  const phrases: string[] = [];
  let remaining = buffer.text;
  let acc = '';

  while (remaining.length > 0) {
    const endIdx = findSentenceEnd(remaining);
    if (endIdx === -1) break;

    const sentence = remaining.slice(0, endIdx).trim();
    remaining = remaining.slice(endIdx);
    if (sentence.length === 0) continue;

    acc = acc ? `${acc} ${sentence}` : sentence;
    const min = (buffer.emitted === 0 && phrases.length === 0) ? FIRST_CHUNK_CHARS : MIN_TTS_CHARS;
    if (acc.length >= min) {
      const clean = sanitizeForSpeech(acc);
      if (clean) phrases.push(clean);
      acc = '';
    }
  }

  buffer.emitted += phrases.length;
  // A short, boundary-terminated remainder goes back into the buffer so it can
  // merge with tokens still streaming in (rather than shipping as a fragment).
  // Kept RAW (pre-sanitize) here — it's not final until flushed/re-drained.
  buffer.text = acc ? `${acc} ${remaining}` : remaining;
  return phrases;
}

export function flushSentenceBuffer(buffer: { text: string }): string | null {
  const tail = sanitizeForSpeech(buffer.text);
  buffer.text = '';
  return tail.length > 0 ? tail : null;
}
