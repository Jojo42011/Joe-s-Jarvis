import {
  ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, TTS_SAMPLE_RATE,
  TTS_STABILITY, TTS_SIMILARITY, TTS_STYLE, TTS_SPEED, TTS_SPEAKER_BOOST,
} from '../config/voice';
import { getSelectedPersonality } from './personality';
import { respellForTts } from './pronounce';

const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 50;
const ttsCache = new Map<string, { data: Buffer; timestamp: number }>();

// Concurrency gate: the client requests audio for every sentence of a response
// in parallel, so one long answer fired 10+ simultaneous ElevenLabs calls —
// past the account's concurrency limit they all stall upstream and time out
// together (production saw ~14 TimeoutErrors land in the same second). Cap
// in-flight upstream calls and queue the rest; the 30s timeout only starts
// once a call actually goes out.
const MAX_CONCURRENT_TTS = 3;
let ttsActive = 0;
const ttsWaiters: (() => void)[] = [];

function acquireTtsSlot(): Promise<void> {
  if (ttsActive < MAX_CONCURRENT_TTS) { ttsActive++; return Promise.resolve(); }
  return new Promise((resolve) => ttsWaiters.push(() => { ttsActive++; resolve(); }));
}

function releaseTtsSlot(): void {
  ttsActive--;
  const next = ttsWaiters.shift();
  if (next) next();
}

/** Last `maxChars` of `text`, trimmed back to the nearest whole word. */
function trimToWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(-maxChars);
  const spaceIdx = cut.indexOf(' ');
  return spaceIdx === -1 ? cut : cut.slice(spaceIdx + 1);
}

export async function generateTtsPcm(text: string, previousText?: string): Promise<Buffer> {
  if (!ELEVENLABS_API_KEY || !text.trim()) {
    throw new Error('ElevenLabs TTS not configured');
  }

  // Niche-word respelling (trade terms, abbreviations…) — audio path only;
  // the displayed transcript keeps the real spelling. previous_text gets the
  // same treatment so cross-sentence context matches what was actually spoken.
  text = respellForTts(text);
  if (previousText) previousText = respellForTts(previousText);

  // Voice follows the selected personality (falls back to the configured default).
  let voiceId = ELEVENLABS_VOICE_ID;
  try { voiceId = getSelectedPersonality().voiceId || ELEVENLABS_VOICE_ID; } catch { /* db not ready */ }

  const cacheKey = `${voiceId}:${(previousText || '').trim().toLowerCase().slice(-50)}:${text.trim().toLowerCase().slice(0, 200)}`;
  const cached = ttsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_${TTS_SAMPLE_RATE}`;
  await acquireTtsSlot();
  try {
    // Another parallel call may have filled the cache while we waited in line.
    const cachedNow = ttsCache.get(cacheKey);
    if (cachedNow && Date.now() - cachedNow.timestamp < CACHE_TTL) {
      return cachedNow.data;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/pcm',
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        text: text.trim(),
        model_id: ELEVENLABS_MODEL_ID,
        // Each sentence in a response is a separate isolated TTS call — previous_text
        // gives ElevenLabs the prior sentence as context so pacing/prosody carries
        // across the join instead of every chunk restarting cold (a source of the
        // "little drop" between sentences Joe described). Trimmed on a WORD
        // boundary, never mid-word — a broken trailing word as "context" risks the
        // model treating it as something to continue/complete, which reads as a
        // stutter right at the start of the next chunk.
        ...(previousText ? { previous_text: trimToWordBoundary(previousText.trim(), 300) } : {}),
        voice_settings: {
          stability: TTS_STABILITY,
          similarity_boost: TTS_SIMILARITY,
          style: TTS_STYLE,
          use_speaker_boost: TTS_SPEAKER_BOOST,
          speed: TTS_SPEED,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Arlo] ElevenLabs TTS error: ${response.status} ${errorText}`);
      throw new Error(`ElevenLabs TTS failed: ${response.status}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    if (ttsCache.size >= CACHE_MAX) {
      const oldest = ttsCache.keys().next().value;
      if (oldest) ttsCache.delete(oldest);
    }
    ttsCache.set(cacheKey, { data: audioBuffer, timestamp: Date.now() });
    return audioBuffer;
  } finally {
    releaseTtsSlot();
  }
}
