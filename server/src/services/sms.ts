/**
 * Direct SMS notifications via sms-gate.app (SMS Gateway for Android, cloud mode).
 * Replaces the deleted aethon-claw hook. Uses HTTP Basic auth to POST a message
 * to Arthur's phone. All values are env-overridable — set them as Fly secrets and
 * ROTATE the password (it also has a default baked in below so it works today).
 */

import { stripDashes } from './textStyle';

const SMS_GATE_URL = process.env.SMS_GATE_URL || 'https://api.sms-gate.app/3rdparty/v1/message';
const SMS_GATE_USERNAME = process.env.SMS_GATE_USERNAME || 'JHQK2W';
const SMS_GATE_PASSWORD = process.env.SMS_GATE_PASSWORD || '_6_qfwxnioqhb9';
const SMS_NOTIFY_TO = process.env.SMS_NOTIFY_TO || '+16027843600';

/**
 * Send an SMS to a specific number (CRM → lead outreach). Awaitable so the CRM
 * can report success/failure to the UI. Throws on config/HTTP errors.
 */
export async function sendSmsTo(phone: string, message: string, context = 'CRM'): Promise<void> {
  message = stripDashes(message);
  if (!SMS_GATE_USERNAME || !SMS_GATE_PASSWORD) {
    throw new Error('sms-gate credentials not configured');
  }
  const to = phone.trim();
  if (!/^\+?[\d\s\-().]{7,}$/.test(to)) throw new Error(`"${phone}" doesn't look like a phone number`);
  const auth = Buffer.from(`${SMS_GATE_USERNAME}:${SMS_GATE_PASSWORD}`).toString('base64');
  const res = await fetch(SMS_GATE_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, phoneNumbers: [to] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[${context}] SMS to ${to} failed:`, res.status, body.slice(0, 200));
    throw new Error(`SMS gateway returned ${res.status}`);
  }
  console.log(`[${context}] SMS sent to ${to}`);
}

/** Fire-and-forget SMS to Arthur's number. Never throws. */
export function sendSms(message: string, context = 'SMS'): void {
  message = stripDashes(message);
  if (!SMS_GATE_USERNAME || !SMS_GATE_PASSWORD) {
    console.warn(`[${context}] sms-gate credentials not configured — skipping SMS`);
    return;
  }
  const auth = Buffer.from(`${SMS_GATE_USERNAME}:${SMS_GATE_PASSWORD}`).toString('base64');

  fetch(SMS_GATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, phoneNumbers: [SMS_NOTIFY_TO] }),
  })
    .then(async (res) => {
      if (res.ok) {
        console.log(`[${context}] SMS sent via sms-gate.app`, res.status);
      } else {
        const body = await res.text().catch(() => '');
        console.error(`[${context}] SMS failed:`, res.status, res.statusText, body.slice(0, 200));
      }
    })
    .catch((err) => console.error(`[${context}] SMS error:`, err instanceof Error ? err.message : err));
}
