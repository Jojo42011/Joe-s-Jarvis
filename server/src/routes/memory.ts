import { Router, Request, Response } from 'express';
import { getAllMemoryData, getIdentityProfile } from '../db/memory';
import { runPostConversationExtraction } from '../services/extraction';
import { recordCuriosityAnswer } from '../services/curiosity';
import { getDb } from '../db/schema';
import { getRecentConversation } from '../db/queries';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
  const data = getAllMemoryData();
  res.json({
    ready: true,
    counts: data.stats,
    neuralMapPath: '/memory.html',
  });
});

router.get('/all', (_req: Request, res: Response) => {
  res.json(getAllMemoryData());
});

router.get('/graph', (_req: Request, res: Response) => {
  const data = getAllMemoryData();
  res.json({ nodes: data.nodes, edges: data.edges });
});

router.get('/episodes', (_req: Request, res: Response) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM episodes ORDER BY created_at DESC LIMIT 20').all());
});

router.get('/rules', (_req: Request, res: Response) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM rules ORDER BY confidence DESC').all());
});

router.get('/identity', (_req: Request, res: Response) => {
  const db = getDb();
  const profile = getIdentityProfile();
  const recentQuestions = db.prepare(`
    SELECT dimension, question, answer, asked_at, answered_at
    FROM identity_questions
    ORDER BY asked_at DESC LIMIT 10
  `).all();
  res.json({ profile, recentQuestions });
});

router.post('/extract-voice', async (req: Request, res: Response) => {
  try {
    const { transcript } = req.body as {
      transcript?: { role: string; content: string }[];
    };
    if (!transcript || !Array.isArray(transcript)) {
      res.status(400).json({ error: 'transcript array required' });
      return;
    }
    // The turn(s) in `transcript` are already persisted (agentLoop writes to
    // `conversations` before the client flushes here), so pull a little PRECEDING
    // context and prepend it — pronouns and follow-ups ("that one", "the same
    // guy") only resolve correctly with what came right before. This never
    // touches what gets stored, just what the extraction model gets to see.
    const window = getRecentConversation(transcript.length + 6);
    const priorContext = window.slice(0, Math.max(0, window.length - transcript.length));
    const enriched = [...priorContext, ...transcript];
    await runPostConversationExtraction(enriched);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Jarvis] Voice extraction error:', err);
    res.status(500).json({ error: 'Extraction failed' });
  }
});

router.post('/curiosity/answer', async (req: Request, res: Response) => {
  const { question, answer } = req.body as { question?: string; answer?: string };
  if (!question || !answer) {
    res.status(400).json({ error: 'question and answer required' });
    return;
  }
  await recordCuriosityAnswer(question, answer);
  res.json({ ok: true });
});

export default router;
