import OpenAI from 'openai';
import { ARLO_MODEL } from '../config/models';
import { ARLO_SYSTEM_PROMPT } from '../config/constants';
import { insertFact, insertEpisode } from '../db/memory';
import { embedText, vectorToBuffer } from './embeddings';
import { safeJsonParse } from '../utils/safeJson';
import { broadcast } from '../ws/hub';

/**
 * Arlo's eyes + document reading. gpt-4o is multimodal, so this is real:
 * - analyzeImage: look at a photo (job site, damage, a document photo, a
 *   whiteboard) and describe what matters to Joe, then remember it.
 * - ingestDocument: read pasted/uploaded text (contract, spec, email), summarize
 *   it, and store durable facts into memory with embeddings.
 */

export async function analyzeImage(image: string, prompt?: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const client = new OpenAI({ apiKey });

  const ask = prompt?.trim() ||
    "Look at this image for Joe. Describe what's relevant to his landscaping, hardscaping, and excavating business — job-site conditions, damage, materials, measurements, equipment, or any document/text in it. Be concise and useful; if it's a document, pull the key details.";

  const resp = await client.responses.create({
    model: ARLO_MODEL,
    instructions: `${ARLO_SYSTEM_PROMPT}\n\nJoe just shared an image with you. ${ask}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: [{ role: 'user', content: [
      { type: 'input_text', text: ask },
      { type: 'input_image', image_url: image },
    ] }] as any,
  });

  const text = resp.output_text || '';
  if (text.trim()) {
    insertEpisode(`Joe shared an image. Arlo saw: ${text.slice(0, 280)}`, undefined, 'neutral', undefined);
    broadcast({ type: 'memory_updated' });
  }
  return text;
}

interface DocExtract { summary?: string; facts?: { content: string; importance?: number }[] }

export async function ingestDocument(text: string, filename?: string, prompt?: string): Promise<{ summary: string; stored: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const client = new OpenAI({ apiKey });

  const sys = `You are Arlo, Joe's right hand. Read this document${filename ? ` ("${filename}")` : ''} and return ONLY JSON:
{"summary":"2-4 sentence plain summary for Joe","facts":[{"content":"a durable fact worth remembering","importance":1-10}]}
Pull anything Joe would want remembered — names, numbers, dates, terms, obligations. If nothing durable, facts:[].`;

  const resp = await client.responses.create({
    model: ARLO_MODEL,
    instructions: sys,
    input: (prompt ? `${prompt}\n\n` : '') + text.slice(0, 24000),
  });

  const parsed = safeJsonParse<DocExtract>(resp.output_text || '') || {};
  const summary = parsed.summary?.trim() || (resp.output_text || '').slice(0, 400);

  let stored = 0;
  for (const f of parsed.facts ?? []) {
    const content = f.content?.trim();
    if (!content) continue;
    const importance = Math.max(1, Math.min(Number(f.importance) || 5, 10));
    const vec = await embedText(content);
    insertFact(content, 'document', filename || 'document', 1.0, importance, vec ? vectorToBuffer(vec) : null);
    stored++;
  }
  if (summary) insertEpisode(`Joe shared a document${filename ? ` (${filename})` : ''}: ${summary.slice(0, 260)}`, undefined, 'neutral', undefined);
  if (stored || summary) broadcast({ type: 'memory_updated' });

  return { summary, stored };
}
