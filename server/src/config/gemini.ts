/** Gemini API key (image gen + Live voice). Set via Fly secret GEMINI_API_KEY. */
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || "";

export const GEMINI_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ||
  "models/gemini-3.1-flash-live-preview";

/** Prebuilt voice — Zubenelgenubi (Gemini TTS/Live). Override via GEMINI_LIVE_VOICE. */
export const GEMINI_LIVE_VOICE = process.env.GEMINI_LIVE_VOICE || "Zubenelgenubi";

/** Natural-language delivery steer for TTS + Live (no numeric pitch API). */
export const GEMINI_VOICE_DELIVERY =
  "British cadence — refined accent, slightly slower and deliberate, never rushed or corporate. Speak as an AI intelligence system: composed, precise, lightly synthetic; clear machine clarity without cartoon-robotic coldness. Conversational and quick-witted; dry sarcasm and understated wit welcome when the moment fits — not constant, never cruel. No boardroom speak. Confident authority, unmistakably JARVIS running quietly in the background.";

export function isGeminiConfigured(): boolean {
  return GEMINI_API_KEY.length > 0;
}
