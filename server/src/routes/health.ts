import { Router, Request, Response } from 'express';
import { OPERATOR_NAME, CLIENT_NAME } from '../config/constants';
import { ANTHROPIC_MODEL } from '../config/models';

const router = Router();

/** Present-or-not for each external connection (never the value). Lets Joe/us
 *  see at a glance what still needs a Fly secret without exposing anything. */
function connectionStatus() {
  const has = (k: string) => !!(process.env[k] && process.env[k]!.trim());
  return {
    brain_anthropic: has('ANTHROPIC_API_KEY'),        // required — Jarvis's brain, eyes, classification
    web_search_brave: has('BRAVE_API_KEY') || has('BRAVE_SEARCH_API_KEY'),
    voice_elevenlabs: has('ELEVENLABS_API_KEY'),      // voice STT + TTS
    phone_vapi: has('VAPI_API_KEY'),                  // Sofia (phone)
    images_gemini: has('GEMINI_API_KEY'),             // Lauren/Paulie image gen
    google_oauth: has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET'),
    social_zernio: has('ZERNIO_API_KEY'),             // Paulie publishing
    sms_gateway: has('SMS_GATE_USERNAME') && has('SMS_GATE_PASSWORD'),
    seo_github: has('GITHUB_TOKEN'),                  // Lauren publishes pages
    embeddings_openai: has('OPENAI_API_KEY'),         // optional — semantic recall (keyword fallback otherwise)
  };
}

router.get('/', (_req: Request, res: Response) => {
  const connections = connectionStatus();
  res.json({
    status: 'ok',
    operator: OPERATOR_NAME,
    client: CLIENT_NAME,
    brain_ready: connections.brain_anthropic,
    pipeline: {
      ears: 'elevenlabs-scribe',
      brain: ANTHROPIC_MODEL,
      mouth: 'elevenlabs',
      memory: 'sqlite-6-layer',
    },
    connections,
  });
});

export default router;
