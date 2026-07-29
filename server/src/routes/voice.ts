import { Router, Request, Response } from 'express';
import {
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  ELEVENLABS_MODEL_ID,
  ELEVENLABS_STT_MODEL,
} from '../config/voice';
import { generateTtsPcm } from '../services/tts';
import { getOpenerAudio, slotForOhioHour, OPENERS } from '../services/greetingCache';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
  const hasElevenlabs = !!ELEVENLABS_API_KEY;

  res.json({
    ready: hasElevenlabs,
    stt: {
      provider: 'elevenlabs-scribe',
      model: ELEVENLABS_STT_MODEL,
      proxyPath: '/api/voice/deepgram/listen',
      wired: hasElevenlabs,
    },
    tts: {
      provider: 'elevenlabs',
      model: ELEVENLABS_MODEL_ID,
      voice: ELEVENLABS_VOICE_ID,
      sampleRate: 24000,
      endpoint: '/api/voice/speak',
      wired: hasElevenlabs,
    },
  });
});

router.post('/speak', async (req: Request, res: Response) => {
  try {
    const { text, previousText } = req.body as { text?: string; previousText?: string };
    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const pcm = await generateTtsPcm(text.trim(), typeof previousText === 'string' ? previousText : undefined);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Sample-Rate', String(24000));
    res.setHeader('X-Audio-Format', 'pcm-s16le-mono');
    res.send(pcm);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'TTS failed';
    console.error('[Jarvis] TTS error:', err);
    res.status(500).json({ error: msg });
  }
});

/**
 * The opener, as audio, straight from memory. The client plays this the moment
 * the orb is tapped and asks for the briefing in parallel, so the first sound
 * lands in milliseconds instead of behind a brain call and a synthesis call.
 */
router.get('/opener', async (_req: Request, res: Response) => {
  try {
    const slot = slotForOhioHour();
    const pcm = await getOpenerAudio(slot);
    if (!pcm) {
      // Say so plainly; the client falls back to the normal greeting path.
      res.status(503).json({ error: 'opener unavailable' });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Sample-Rate', String(24000));
    res.setHeader('X-Audio-Format', 'pcm-s16le-mono');
    res.setHeader('X-Opener-Text', OPENERS[slot]);
    res.send(pcm);
  } catch (err) {
    console.error('[Jarvis] opener error:', err);
    res.status(503).json({ error: 'opener unavailable' });
  }
});

export default router;