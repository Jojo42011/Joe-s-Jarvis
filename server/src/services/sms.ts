/**
 * Outbound SMS — carrier-registered A2P 10DLC via Twilio.
 *
 * Twilio is the default transport; the old sms-gate.app Android gateway stays
 * available as a break-glass fallback behind SMS_PROVIDER=sms-gate. Every
 * secret is read from env at call time with NO baked-in fallback — a missing
 * secret means the send is skipped (or the error surfaced to the caller),
 * never rerouted to a default.
 *
 * Every outbound text is wrapped in the carrier-approved template here, in the
 * provider layer, so no caller has to know about it:
 *   "Totally Outdoors: " + body + " Reply STOP to cancel, HELP for help."
 *
 * TWILIO_SMS_FROM_NUMBER exists as a secret but is deliberately never read:
 * sends go out with MessagingServiceSid only, so Twilio picks the sender from
 * the carrier-registered pool. Passing From would bypass the registration.
 */

import twilio from 'twilio';
import { stripDashes } from './textStyle';

const TEMPLATE_PREFIX = 'Totally Outdoors: ';
const TEMPLATE_SUFFIX = 'Reply STOP to cancel, HELP for help.';

/**
 * Wrap a message body in the carrier-approved template. Idempotent: a body
 * already carrying the prefix/suffix is unwrapped first, so a retry can never
 * double-wrap. The exact wording is what the carriers approved — do not edit.
 */
export function applyCarrierTemplate(body: string): string {
  let b = body.trim();
  if (b.startsWith(TEMPLATE_PREFIX)) b = b.slice(TEMPLATE_PREFIX.length).trimStart();
  if (b.endsWith(TEMPLATE_SUFFIX)) b = b.slice(0, b.length - TEMPLATE_SUFFIX.length).trimEnd();
  return `${TEMPLATE_PREFIX}${b} ${TEMPLATE_SUFFIX}`;
}

/**
 * The exact params handed to Twilio's messages.create: MessagingServiceSid
 * only, never From. Exported so the compliance test can pin the wire shape.
 */
export function twilioCreateParams(
  to: string,
  body: string
): { to: string; body: string; messagingServiceSid: string } {
  return { to, body, messagingServiceSid: (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim() };
}

function provider(): 'twilio' | 'sms-gate' {
  return (process.env.SMS_PROVIDER || '').trim().toLowerCase() === 'sms-gate' ? 'sms-gate' : 'twilio';
}

async function deliverViaTwilio(to: string, body: string, context: string): Promise<{ sid: string; status: string }> {
  const accountSid = (process.env.TWILIO_SMS_ACCOUNT_SID || '').trim();
  const authToken = (process.env.TWILIO_SMS_AUTH_TOKEN || '').trim();
  const params = twilioCreateParams(to, body);
  if (!accountSid || !authToken || !params.messagingServiceSid) {
    throw new Error('Twilio SMS not configured (need TWILIO_SMS_ACCOUNT_SID, TWILIO_SMS_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID)');
  }
  const client = twilio(accountSid, authToken);
  const msg = await client.messages.create(params);
  console.log(`[${context}] SMS to ${to} via Twilio — sid ${msg.sid}, status ${msg.status}`);
  return { sid: msg.sid, status: String(msg.status) };
}

async function deliverViaSmsGate(to: string, body: string, context: string): Promise<{ sid: string; status: string }> {
  const url = (process.env.SMS_GATE_URL || '').trim();
  const username = (process.env.SMS_GATE_USERNAME || '').trim();
  const password = (process.env.SMS_GATE_PASSWORD || '').trim();
  if (!url || !username || !password) {
    throw new Error('sms-gate not configured (need SMS_GATE_URL, SMS_GATE_USERNAME, SMS_GATE_PASSWORD)');
  }
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: body, phoneNumbers: [to] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sms-gate returned ${res.status}: ${text.slice(0, 200)}`);
  }
  console.log(`[${context}] SMS to ${to} via sms-gate — status ${res.status}`);
  return { sid: 'sms-gate', status: String(res.status) };
}

/** Template + provider dispatch. Throws on config or transport failure. */
async function deliver(to: string, message: string, context: string): Promise<{ sid: string; status: string }> {
  const body = applyCarrierTemplate(stripDashes(message));
  return provider() === 'sms-gate'
    ? deliverViaSmsGate(to, body, context)
    : deliverViaTwilio(to, body, context);
}

/**
 * Send an SMS to a specific number (CRM → lead outreach). Awaitable so the CRM
 * can report success/failure to the UI. Throws on config/transport errors.
 */
export async function sendSmsTo(phone: string, message: string, context = 'CRM'): Promise<void> {
  const to = phone.trim();
  if (!/^\+?[\d\s\-().]{7,}$/.test(to)) throw new Error(`"${phone}" doesn't look like a phone number`);
  await deliver(to, message, context);
}

/** Fire-and-forget SMS to Joe's number. Never throws. */
export function sendSms(message: string, context = 'SMS'): void {
  const to = (process.env.SMS_NOTIFY_TO || '').trim();
  if (!to) {
    console.error(`[${context}] SMS_NOTIFY_TO not set — skipping SMS`);
    return;
  }
  deliver(to, message, context).catch((err) =>
    console.error(`[${context}] SMS failed:`, err instanceof Error ? err.message : err));
}

/**
 * Live end-to-end delivery check: texts Joe's number over the active provider
 * and returns the transport receipt. Backs POST /api/sms/test.
 */
export async function sendTestSms(): Promise<{ to: string; sid: string; status: string }> {
  const to = (process.env.SMS_NOTIFY_TO || '').trim();
  if (!to) throw new Error('SMS_NOTIFY_TO not set');
  const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const receipt = await deliver(to, `Test message from your system (${stamp}). If you got this, texting is live.`, 'SMS test');
  return { to, ...receipt };
}
