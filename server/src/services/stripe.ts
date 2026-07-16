/**
 * Stripe Checkout — real hosted payment links for deposits/design fees.
 * Talks to Stripe's REST API directly (no SDK dependency). Off by default:
 * every call is a no-op/clear-error unless STRIPE_SECRET_KEY is set, matching
 * the graceful-degradation pattern the rest of the app follows.
 */

import crypto from 'crypto';

const STRIPE_API = 'https://api.stripe.com/v1';

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString('base64')}`;
}

function toForm(obj: Record<string, string | number>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/**
 * Create a one-off Stripe Checkout Session for a lead payment (deposit,
 * design fee, draw). `successUrl`/`cancelUrl` default to the CRM itself.
 */
export async function createPaymentLink(opts: {
  leadId: number;
  paymentId: number;
  label: string;
  amountCents: number;
  customerName?: string;
  siteUrl?: string;
}): Promise<CheckoutSession> {
  if (!isStripeConfigured()) {
    throw new Error('Stripe not configured — set STRIPE_SECRET_KEY to enable payment links');
  }
  const base = (opts.siteUrl || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const successUrl = base ? `${base}/crm.html?paid=1` : 'https://aquaticpoolaz.com/thank-you';
  const cancelUrl = base ? `${base}/crm.html` : 'https://aquaticpoolaz.com';

  const body = toForm({
    mode: 'payment',
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': `Aquatic Pool & Spa — ${opts.label}`,
    'line_items[0][price_data][unit_amount]': opts.amountCents,
    'line_items[0][quantity]': 1,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'metadata[lead_id]': opts.leadId,
    'metadata[payment_id]': opts.paymentId,
    ...(opts.customerName ? { 'metadata[customer_name]': opts.customerName } : {}),
  });

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json() as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !data.url || !data.id) {
    throw new Error(data.error?.message || `Stripe returned ${res.status}`);
  }
  return { id: data.id, url: data.url };
}

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header) without
 * the SDK — HMAC-SHA256 over `${timestamp}.${rawBody}` compared to the v1 sig.
 */
export function verifyStripeSignature(rawBody: string, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch {
    return false;
  }
}
