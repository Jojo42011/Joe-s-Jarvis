import { Router, Request, Response } from 'express';
import { OPERATOR_NAME, CLIENT_NAME } from '../config/constants';
import { ANTHROPIC_MODEL } from '../config/models';
import { googleConfigured, GOOGLE_ACCOUNTS } from '../config/google';
import { getGoogleAccount } from '../db/google';
import { embeddingProvider } from '../services/embeddings';

const router = Router();

/** Present-or-not for each external connection (never the value). Lets Joe/us
 *  see at a glance what still needs a Fly secret without exposing anything. */
function connectionStatus() {
  const has = (k: string) => !!(process.env[k] && process.env[k]!.trim());
  const primaryMailbox = GOOGLE_ACCOUNTS[0];
  const gmailConnected = primaryMailbox
    ? !!getGoogleAccount(primaryMailbox.email)?.refresh_token
    : false;
  return {
    brain_anthropic: has('ANTHROPIC_API_KEY'),        // required — Jarvis's brain, eyes, classification
    web_search_brave: has('BRAVE_API_KEY') || has('BRAVE_SEARCH_API_KEY'),
    voice_elevenlabs: has('ELEVENLABS_API_KEY'),      // voice STT + TTS
    // Which transcriber a session starts on, and whether a fallback exists.
    // Deepgram covers ElevenLabs being keyless, rate-limited or out of quota.
    stt_primary: has('ELEVENLABS_API_KEY') ? 'elevenlabs-scribe' : (has('DEEPGRAM_API_KEY') ? 'deepgram' : 'none'),
    stt_fallback: has('DEEPGRAM_API_KEY') ? 'deepgram' : 'none',
    phone_vapi: has('VAPI_API_KEY'),                  // phone line
    images_gemini: has('GEMINI_API_KEY'),             // Lauren/Paulie image gen
    google_oauth_configured: googleConfigured(),      // client id/secret present (either GOOGLE_* or GMAIL_* names)
    google_mailbox_connected: gmailConnected,          // an actual refresh token is stored — inbox/calendar will sync
    social_zernio: has('ZERNIO_API_KEY'),             // Paulie publishing
    sms_gateway: has('SMS_GATE_USERNAME') && has('SMS_GATE_PASSWORD'),
    seo_github: has('GITHUB_TOKEN'),                  // Lauren publishes pages
    // Semantic recall runs on OpenAI when available and Gemini otherwise, so
    // report the resolved provider rather than one vendor's key.
    memory_semantic_recall: embeddingProvider() !== null,
    memory_embedding_provider: embeddingProvider() || 'none (keyword fallback)',
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
