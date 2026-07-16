import { Router, Request, Response } from 'express';
import { runAgentLoop, streamAgentLoop } from '../brain/agentLoop';
import { handleActivation } from '../services/crons';
import { ANTHROPIC_MODEL } from '../config/models';
import { listPersonalities, setSelectedPersonality } from '../services/personality';
import { analyzeImage, ingestDocument } from '../services/vision';

const router = Router();

// Arlo's eyes: analyze an uploaded image (data URL or https URL).
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { image, prompt } = req.body as { image?: string; prompt?: string };
    if (!image) { res.status(400).json({ error: 'image (data URL or URL) required' }); return; }
    const text = await analyzeImage(image, prompt);
    res.json({ text, speech: text });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'analyze failed' });
  }
});

// Document ingestion: read text, summarize, remember key facts.
router.post('/ingest', async (req: Request, res: Response) => {
  try {
    const { text, filename, prompt } = req.body as { text?: string; filename?: string; prompt?: string };
    if (!text || !text.trim()) { res.status(400).json({ error: 'text required' }); return; }
    const result = await ingestDocument(text, filename, prompt);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'ingest failed' });
  }
});

router.get('/personalities', (_req: Request, res: Response) => {
  res.json(listPersonalities());
});

router.post('/personality', (req: Request, res: Response) => {
  const { id } = req.body as { id?: string };
  if (!id) { res.status(400).json({ error: 'id required' }); return; }
  const p = setSelectedPersonality(id);
  res.json({ ok: true, current: p.id, name: p.name });
});

router.get('/status', (_req: Request, res: Response) => {
  res.json({
    ready: true,
    pipeline: {
      ears: 'elevenlabs-scribe',
      brain: ANTHROPIC_MODEL,
      mouth: 'elevenlabs',
    },
  });
});

router.get('/activate', async (_req: Request, res: Response) => {
  try {
    const greeting = await handleActivation();
    res.json({ speech: greeting, text: greeting });
  } catch (err) {
    res.status(500).json({ error: 'Activation failed' });
  }
});

router.post('/process', async (req: Request, res: Response) => {
  try {
    const { message } = req.body as { message?: string; sessionId?: string };
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const result = await runAgentLoop({ message });
    res.json({
      text: result.text,
      speech: result.speech,
      curiosityQuestion: result.curiosityQuestion ?? null,
      navigate: result.navigate ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Brain processing failed';
    console.error('[Arlo] Brain error:', err);
    res.status(500).json({ error: msg });
  }
});

router.post('/stream', async (req: Request, res: Response) => {
  try {
    const { message } = req.body as { message?: string; sessionId?: string };
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    await streamAgentLoop({ message }, res);
  } catch (err) {
    console.error('[Arlo] Stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream failed' });
    }
  }
});

export default router;
