import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '../config/anthropic';
import { ANTHROPIC_MODEL } from '../config/models';
import { ARLO_SYSTEM_PROMPT } from '../config/constants';
import { insertFact, insertEpisode } from '../db/memory';
import { embedText, vectorToBuffer } from './embeddings';
import { safeJsonParse } from '../utils/safeJson';
import { broadcast } from '../ws/hub';

/**
 * Jarvis's eyes + document reading. Claude is multimodal, so this is real:
 * - analyzeImage: look at a photo (job site, damage, a document photo, a
 *   whiteboard) and describe what matters to Joe, then remember it.
 * - ingestDocument: read pasted/uploaded text (contract, spec, email), summarize
 *   it, and store durable facts into memory with embeddings.
 */

/** Turn a data URL or https URL into an Anthropic image content block. */
function imageBlock(image: string): Record<string, unknown> {
  const dataUrl = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } };
  }
  return { type: 'image', source: { type: 'url', url: image } };
}

function textFrom(resp: Anthropic.Message): string {
  const block = resp.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

export async function analyzeImage(image: string, prompt?: string): Promise<string> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new Error('Claude is disabled on this deployment (see server/src/config/anthropic.ts)');
  const client = new Anthropic({ apiKey });

  const ask = prompt?.trim() ||
    "Look at this image for Joe. Describe what's relevant to his landscaping, hardscaping, and excavating business — job-site conditions, damage, materials, measurements, equipment, or any document/text in it. Be concise and useful; if it's a document, pull the key details.";

  const resp = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: `${ARLO_SYSTEM_PROMPT}\n\nJoe just shared an image with you. ${ask}`,
    messages: [{
      role: 'user',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: [imageBlock(image) as any, { type: 'text', text: ask }],
    }],
  });

  const text = textFrom(resp);
  if (text.trim()) {
    insertEpisode(`Joe shared an image. Jarvis saw: ${text.slice(0, 280)}`, undefined, 'neutral', undefined);
    broadcast({ type: 'memory_updated' });
  }
  return text;
}

interface DocExtract { summary?: string; facts?: { content: string; importance?: number }[] }

export async function ingestDocument(text: string, filename?: string, prompt?: string): Promise<{ summary: string; stored: number }> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new Error('Claude is disabled on this deployment (see server/src/config/anthropic.ts)');
  const client = new Anthropic({ apiKey });

  const sys = `You are Jarvis, Joe's right hand. Read this document${filename ? ` ("${filename}")` : ''} and return ONLY JSON:
{"summary":"2-4 sentence plain summary for Joe","facts":[{"content":"a durable fact worth remembering","importance":1-10}]}
Pull anything Joe would want remembered — names, numbers, dates, terms, obligations. If nothing durable, facts:[].`;

  const resp = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: sys,
    messages: [{ role: 'user', content: (prompt ? `${prompt}\n\n` : '') + text.slice(0, 24000) }],
  });

  const raw = textFrom(resp);
  const parsed = safeJsonParse<DocExtract>(raw) || {};
  const summary = parsed.summary?.trim() || raw.slice(0, 400);

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
