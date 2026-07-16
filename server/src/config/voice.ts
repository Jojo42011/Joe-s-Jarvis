export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY?.trim() || '';
// Fallback default only — the voice actually heard in normal use is the
// operator personality's voiceId in config/personalities.ts, which overrides
// this at speak time in services/tts.ts.
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID?.trim() || 'KLON7Nwan8mJxpF2R8Yw';
// Multilingual v2: ElevenLabs' most stable, highest-quality model. Word-level
// stutters survived Flash v2.5 AND Turbo v2.5 even at style=0, so quality wins
// over the ~200-300ms of extra model latency (Joe confirmed the headroom).
// Unlike the v2.5 models it also runs full text normalization.
//
// NOTE: the TTS tuning env vars are deliberately ARLO_TTS_* — production Fly
// secrets still carry stale ELEVENLABS_MODEL_ID/STABILITY/STYLE values from an
// old deploy that silently overrode every fix shipped from code (the boot log
// kept saying eleven_flash_v2_5). Renaming the knobs makes the stale secrets
// inert while keeping the tuning surface for the future.
export const ELEVENLABS_MODEL_ID = process.env.ARLO_TTS_MODEL?.trim() || 'eleven_multilingual_v2';
export const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL?.trim() || 'scribe_v2_realtime';
export const TTS_SAMPLE_RATE = 24000;

// 0.6: ElevenLabs recommends locking stability higher (0.5–0.7) for automated
// pipelines that need predictable output — reliability over expressiveness.
export const TTS_STABILITY = parseFloat(process.env.ARLO_TTS_STABILITY || '0.6');
// 0.75 matches ElevenLabs' recommended default; higher values introduce
// inconsistent speed, mispronunciation, and random volume artifacts.
export const TTS_SIMILARITY = parseFloat(process.env.ARLO_TTS_SIMILARITY || '0.75');
// 0: style exaggeration is documented by ElevenLabs to cause "inconsistent
// speed, mispronunciation and the addition of extra sounds" — i.e. exactly the
// word-level stutter Joe kept hearing across three different voices. Their
// guidance is to keep it at 0, full stop.
export const TTS_STYLE = parseFloat(process.env.ARLO_TTS_STYLE || '0');
export const TTS_SPEED = parseFloat(process.env.ARLO_TTS_SPEED || '1.0');
export const TTS_SPEAKER_BOOST = (process.env.ARLO_TTS_SPEAKER_BOOST || 'true') === 'true';
