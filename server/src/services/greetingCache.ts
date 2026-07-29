import { generateTtsPcm } from './tts';

/**
 * Pre-rendered opener audio.
 *
 * Tapping the orb used to buy five or six seconds of silence before Jarvis made
 * a sound: the client asked for a greeting, that greeting waited on a memory
 * packet plus a Claude call, and only then did the text go out to ElevenLabs for
 * synthesis. Three serial round trips before the first sample.
 *
 * The opener is one of three fixed phrases, so it does not need generating at
 * all. Render each once, keep the PCM in memory, and serve it from RAM the
 * instant the orb is tapped. The briefing still comes from the brain — it just
 * arrives behind an opener Joe can already hear, rather than behind silence.
 */

export type Slot = 'morning' | 'afternoon' | 'evening';

export const OPENERS: Record<Slot, string> = {
  morning: 'Good morning, Joe.',
  afternoon: 'Good afternoon, Joe.',
  evening: 'Good evening, Joe.',
};

const cache = new Map<Slot, Buffer>();
const inFlight = new Map<Slot, Promise<Buffer | null>>();

export function slotForOhioHour(): Slot {
  const hour = parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }),
    10,
  );
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * PCM for a slot's opener, rendering on first use. Returns null when TTS is
 * unavailable so the caller can fall back to the normal path rather than
 * serving silence — a greeting that cannot be spoken must not look like one
 * that was.
 */
export async function getOpenerAudio(slot: Slot): Promise<Buffer | null> {
  const hit = cache.get(slot);
  if (hit) return hit;

  // Two taps in the same second must not both pay for a render.
  const pending = inFlight.get(slot);
  if (pending) return pending;

  const job = (async (): Promise<Buffer | null> => {
    try {
      const pcm = await generateTtsPcm(OPENERS[slot]);
      if (pcm && pcm.length) {
        cache.set(slot, pcm);
        return pcm;
      }
      return null;
    } catch (err) {
      console.error('[Greeting] opener render failed:', err instanceof Error ? err.message : err);
      return null;
    } finally {
      inFlight.delete(slot);
    }
  })();

  inFlight.set(slot, job);
  return job;
}

/**
 * Warm the slot Joe is most likely to hit next, at boot and hourly after.
 * Best-effort: a failure here costs nothing but the old latency.
 */
export function warmGreetingCache(): void {
  const warm = () => {
    const slot = slotForOhioHour();
    if (cache.has(slot)) return;
    void getOpenerAudio(slot).then((pcm) => {
      if (pcm) console.log(`[Greeting] opener pre-rendered for ${slot} (${pcm.length} bytes)`);
    });
  };
  // Give the process a moment to finish booting before spending a TTS call.
  setTimeout(warm, 4000);
  setInterval(warm, 30 * 60 * 1000);
}
