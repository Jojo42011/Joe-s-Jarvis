import { Router, Request, Response } from 'express';
import express from 'express';
import { getDb } from '../db/schema';
import { verifyStripeSignature } from '../services/stripe';
import { logActivity } from '../services/leadShared';
import { sendSms } from '../services/sms';

const router = Router();

// Needs the raw body to verify the signature — mounted before express.json()
// in app.ts, same pattern as the Vapi webhook.
router.post('/stripe', express.raw({ type: 'application/json' }), (req: Request, res: Response) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = req.body as Buffer;
  const rawStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : '';

  if (secret) {
    const ok = verifyStripeSignature(rawStr, req.headers['stripe-signature'] as string | undefined, secret);
    if (!ok) {
      console.warn('[Stripe] webhook signature verification failed');
      res.status(400).send('invalid signature');
      return;
    }
  } else {
    console.warn('[Stripe] STRIPE_WEBHOOK_SECRET not set — accepting webhook unverified');
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawStr || '{}');
  } catch {
    res.status(400).send('bad json');
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object as { id?: string; metadata?: Record<string, string> } | undefined;
    const paymentId = Number(session?.metadata?.payment_id);
    const leadId = Number(session?.metadata?.lead_id);
    if (Number.isFinite(paymentId) && Number.isFinite(leadId)) {
      const db = getDb();
      db.prepare("UPDATE lead_payments SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ? AND lead_id = ?").run(paymentId, leadId);
      const payment = db.prepare('SELECT label, amount_cents FROM lead_payments WHERE id = ?').get(paymentId) as { label?: string; amount_cents?: number } | undefined;
      logActivity(leadId, 'payment', {
        direction: 'in',
        body: `Paid online via Stripe: ${payment?.label || 'Payment'} — $${((payment?.amount_cents || 0) / 100).toLocaleString()}`,
        meta: { stripeSessionId: session?.id },
      });
      // Money hit the account — Joe hears about it immediately.
      const leadName = (db.prepare('SELECT name FROM leads WHERE id = ?').get(leadId) as { name?: string } | undefined)?.name || `lead #${leadId}`;
      sendSms(`✅ PAID: ${leadName} — ${payment?.label || 'payment'} $${((payment?.amount_cents || 0) / 100).toLocaleString()} came through Stripe.`, 'Billing');
      console.log('[Stripe] payment confirmed', { leadId, paymentId });
    }
  }

  res.sendStatus(200);
});

export default router;
