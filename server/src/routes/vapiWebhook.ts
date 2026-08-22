import { Router, Request, Response } from 'express';
import { anthropicApiKey } from '../config/anthropic';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/schema';
import { ANTHROPIC_FAST_MODEL } from '../config/models';
import { safeJsonParse } from '../utils/safeJson';
import { sendSms } from '../services/sms';
import { createLead } from '../services/leadIntake';
import { CALL_CATEGORIES, CLASSIFY_RULES, CallCategory } from '../services/crmCleanup';
import { upsertVapiCall, requestVapiSyncSoon, VapiCall } from '../services/vapiSync';

const router = Router();

// Parse raw body manually — Vapi sends non-JSON ping events
router.use(express.text({ type: '*/*', limit: '2mb' }));

const EXTRACTION_SYSTEM_PROMPT =
  'Extract from this call transcript: caller name, phone number, city, property address (street address if the caller gives one, else empty), what they are interested in, and notes: ONE short line quoting what the caller actually said, in their own words. ' +
  'Also classify the call:\n' + CLASSIFY_RULES + '\n' +
  'Return JSON only: {callerName, callerPhone, city, address, interest, notes, category}';

interface VapiEndOfCallMessage {
  type?: string;
  customer?: { number?: string; name?: string };
  transcript?: string;
  summary?: string;
  // Real-time call mirroring: most webhook events carry the call object plus
  // (on end-of-call-report) top-level artifacts alongside it.
  call?: VapiCall;
  cost?: number;
  costBreakdown?: VapiCall['costBreakdown'];
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  recordingUrl?: VapiCall['recordingUrl'];
  analysis?: VapiCall['analysis'];
  artifact?: VapiCall['artifact'];
}

// Mirror the call into vapi_calls the moment Vapi tells us about it — the
// dashboard updates in real time instead of waiting for the sync interval.
// The message's top-level fields (cost, transcript, analysis…) are fresher
// than the embedded call object, so they win. A debounced full sync follows
// ~45s later to pick up Vapi's late-finalized numbers.
function mirrorCallSnapshot(m: VapiEndOfCallMessage): void {
  const call = m.call;
  if (!call?.id) return;
  try {
    upsertVapiCall({
      ...call,
      cost: typeof m.cost === 'number' ? m.cost : call.cost,
      costBreakdown: m.costBreakdown ?? call.costBreakdown,
      startedAt: m.startedAt ?? call.startedAt,
      endedAt: m.endedAt ?? call.endedAt,
      endedReason: m.endedReason ?? call.endedReason,
      transcript: m.transcript ?? call.transcript,
      summary: m.summary ?? call.summary,
      analysis: m.analysis ?? call.analysis,
      artifact: m.artifact ?? call.artifact,
      recordingUrl: m.recordingUrl ?? call.recordingUrl,
      customer: m.customer ?? call.customer,
    });
    requestVapiSyncSoon();
  } catch (err) {
    console.warn('[Phone] call mirror failed (sync will catch it):', err instanceof Error ? err.message : err);
  }
}

interface VapiWebhookBody {
  message?: VapiEndOfCallMessage;
}

interface ExtractedCallLead {
  callerName: string;
  callerPhone: string;
  city: string;
  address: string;
  interest: string;
  notes: string;
  category: CallCategory;
}

interface ParsedLeadRaw {
  callerName?: unknown;
  callerPhone?: unknown;
  city?: unknown;
  address?: unknown;
  interest?: unknown;
  notes?: unknown;
  category?: unknown;
}

function normalizeExtractedFields(parsed: ParsedLeadRaw, fallbackPhone: string): ExtractedCallLead {
  const callerName = String(parsed.callerName || 'Unknown').trim();
  let callerPhone = String(parsed.callerPhone || '').trim();
  if (!callerPhone) callerPhone = fallbackPhone || 'Unknown';
  const city = String(parsed.city || 'Unknown').trim();
  const address = String(parsed.address || '').trim();
  let interest = String(parsed.interest || '').trim();
  if (!interest) interest = 'Unknown';
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.join(', ')
    : String(parsed.notes || '').trim();
  // Unknown/failed classification defaults to prospect — never silently drop
  // a possible customer into the junk pile.
  const category = (CALL_CATEGORIES as readonly string[]).includes(String(parsed.category))
    ? String(parsed.category) as CallCategory
    : 'prospect';

  return { callerName, callerPhone, city, address, interest, notes, category };
}

function parseWebhookBody(req: Request): VapiWebhookBody | null {
  try {
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!raw.trim()) return null;
    return JSON.parse(raw) as VapiWebhookBody;
  } catch {
    return null;
  }
}

async function extractCallLead(
  text: string,
  fallbackPhone: string,
): Promise<ExtractedCallLead> {
  const defaults: ExtractedCallLead = {
    callerName: 'Unknown',
    callerPhone: fallbackPhone || 'Unknown',
    city: 'Unknown',
    address: '',
    interest: 'Unknown',
    notes: '',
    category: 'prospect',
  };

  const apiKey = anthropicApiKey();
  if (!apiKey || !text.trim()) return defaults;

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: ANTHROPIC_FAST_MODEL,
      max_tokens: 512,
      system: EXTRACTION_SYSTEM_PROMPT + '\nReturn JSON only — no prose, no code fences.',
      messages: [{ role: 'user', content: text }],
    });

    const block = response.content.find((b) => b.type === 'text');
    const raw = block && block.type === 'text' ? block.text : '';
    const parsed = safeJsonParse<ParsedLeadRaw>(raw);
    if (!parsed) return defaults;

    return normalizeExtractedFields(parsed, fallbackPhone);
  } catch (err) {
    console.error('[Phone] lead extraction failed:', err);
    return defaults;
  }
}

function notifyLeadSms(message: string, leadId: number): void {
  console.log('[Phone] SMS notify firing', { leadId });
  sendSms(message, 'Phone');
}

router.post('/vapi', async (req: Request, res: Response) => {
  let body: VapiWebhookBody | null;
  try {
    body = parseWebhookBody(req);
  } catch {
    res.sendStatus(200);
    return;
  }

  if (!body?.message?.type) {
    res.sendStatus(200);
    return;
  }

  const message = body.message;

  // Every event that carries the call (status updates, end-of-call reports)
  // refreshes the dashboard row immediately.
  mirrorCallSnapshot(message);

  if (message.type !== 'end-of-call-report') {
    res.sendStatus(200);
    return;
  }

  const fallbackPhone = message.customer?.number?.trim() ?? '';
  const transcriptText = (message.transcript ?? message.summary ?? '').trim();

  if (!transcriptText) {
    console.warn('[Phone] end-of-call-report missing transcript and summary');
    res.sendStatus(200);
    return;
  }

  try {
    const extracted = await extractCallLead(transcriptText, fallbackPhone);
    const leadMessage =
      `${extracted.interest} | ${extracted.notes} | City: ${extracted.city}`;

    // Junk filter: only genuine prospects become CRM leads. Everything else
    // (vendors, existing clients, telemarketers, misdials, no-info calls) is
    // filed in other_calls — visible and promotable from the CRM, never
    // inflating the lead stats.
    if (extracted.category !== 'prospect') {
      getDb().prepare('INSERT INTO other_calls (name, phone, category, message) VALUES (?, ?, ?, ?)')
        .run(extracted.callerName, extracted.callerPhone, extracted.category, leadMessage);
      // Joe still gets pinged for calls that matter (clients, vendors) —
      // but not for every robocall.
      if (extracted.category === 'client' || extracted.category === 'vendor') {
        sendSms(
          `📞 ${extracted.category === 'client' ? 'Client' : 'Vendor'} call: ${extracted.callerName}, ${extracted.callerPhone}.` +
          `\nAbout: ${extracted.interest}` +
          (extracted.notes ? `\nThey said: "${extracted.notes}"` : ''),
          'Phone'
        );
      }
      console.log('[Phone] Non-prospect call filed:', { category: extracted.category, callerName: extracted.callerName });
      res.sendStatus(200);
      return;
    }

    // Shared intake: dedupes by phone against every other source and fires the
    // same automated confirmation a website/manual lead gets — this webhook used
    // to insert directly and skip both, so a caller who'd already been entered
    // elsewhere got a silent duplicate row and never heard back automatically.
    const { leadId, merged } = await createLead({
      name: extracted.callerName,
      phone: extracted.callerPhone,
      address: extracted.address || undefined,
      message: leadMessage,
      source: 'sofia',
    });

    // Everything Joe needs to call back without opening anything: who, their
    // number, the town, what they want, and their own words.
    const smsMessage =
      `📞 New lead from the phone line: ${extracted.callerName}, ${extracted.callerPhone}, ${extracted.city}.` +
      `\nWants: ${extracted.interest}` +
      (extracted.notes ? `\nThey said: "${extracted.notes}"` : '');

    notifyLeadSms(smsMessage, leadId);
    console.log('[Phone] Call lead saved:', { leadId, callerName: extracted.callerName, merged });

    res.sendStatus(200);
  } catch (err) {
    console.error('[Phone] Vapi webhook processing error:', err);
    res.sendStatus(200);
  }
});

export default router;
