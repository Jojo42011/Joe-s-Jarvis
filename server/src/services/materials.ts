/**
 * Supply chain — material procurement for Totally Outdoors.
 *
 * Holmes County suppliers (wholesale nurseries, rock yards, aggregate pits)
 * are phone-and-email businesses — there is no supplier API to integrate.
 * What automation honestly buys Joe here:
 *   1. Purchase orders seeded straight from a project's estimate line items
 *      (the blueprint) the moment a design is approved.
 *   2. A deterministic PO email drafted per supplier, sent on Joe's approval.
 *   3. Delivery tracking tied to the build schedule — entering a stage with
 *      materials not yet ordered/delivered flags Joe before the crew shows up
 *      to an empty site.
 *   4. A quoted-price ledger per material per supplier, so price-fluctuation
 *      questions get answered from Joe's own history, never invented.
 */

import { getDb } from '../db/schema';
import { logActivity, BUILD_STAGES, buildStageIndex } from './leadShared';
import { sendNewEmail } from './google/gmail';
import { GOOGLE_ACCOUNTS } from '../config/google';
import { anyGoogleAccountConnected } from '../db/google';
import { sendSms } from './sms';
import { getSystemState, setSystemState } from '../db/queries';

export const SUPPLIER_CATEGORIES = ['nursery', 'stone', 'aggregate', 'mulch', 'hardscape', 'equipment', 'other'] as const;
export const ORDER_STATUSES = ['draft', 'ready', 'ordered', 'delivered', 'cancelled'] as const;

const COMPANY = {
  name: 'Totally Outdoors LLC',
  phone: '330-231-4080',
  address: '2855 State Route 83, Millersburg, OH 44654',
};

export interface SupplierRow {
  id: number; name: string; category: string | null; contact_name: string | null;
  phone: string | null; email: string | null; notes: string | null;
}

export interface OrderItem { label: string; qty: number; unit: string | null; unit_price_cents: number }

export interface OrderRow {
  id: number; lead_id: number | null; supplier_id: number | null; po_number: string | null;
  status: string; needed_by: string | null; needed_by_stage: string | null;
  email_draft: string | null; sent_at: string | null; notes: string | null;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Suppliers ─────────────────────────────────────────────────────────────

export function addSupplier(s: { name: string; category?: string; contact_name?: string; phone?: string; email?: string; notes?: string }): number {
  const category = (SUPPLIER_CATEGORIES as readonly string[]).includes(s.category || '') ? s.category : 'other';
  const info = getDb().prepare(`
    INSERT INTO suppliers (name, category, contact_name, phone, email, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(s.name.trim(), category, s.contact_name?.trim() || null, s.phone?.trim() || null, s.email?.trim() || null, s.notes?.trim() || null);
  return Number(info.lastInsertRowid);
}

export function listSuppliers(category?: string): SupplierRow[] {
  const db = getDb();
  return (category
    ? db.prepare('SELECT * FROM suppliers WHERE category = ? ORDER BY name').all(category)
    : db.prepare('SELECT * FROM suppliers ORDER BY name').all()) as SupplierRow[];
}

export function findSupplier(query: string): SupplierRow | undefined {
  return getDb().prepare('SELECT * FROM suppliers WHERE name LIKE ? ORDER BY id LIMIT 1')
    .get(`%${query.trim()}%`) as SupplierRow | undefined;
}

// ── Purchase orders ───────────────────────────────────────────────────────

/** Sequential PO numbers: TO-PO-<year>-<seq>, counter kept in system_state. */
export function nextPoNumber(): string {
  const year = new Date().getFullYear();
  const key = `po_seq_${year}`;
  const current = parseInt(getSystemState(key) || '0', 10) + 1;
  setSystemState(key, String(current));
  return `TO-PO-${year}-${String(current).padStart(3, '0')}`;
}

export function createOrder(opts: {
  leadId?: number | null;
  supplierId?: number | null;
  items: OrderItem[];
  neededBy?: string | null;
  neededByStage?: string | null;
  notes?: string | null;
  fromEstimate?: boolean;
}): { orderId: number; po_number: string; items: number } {
  const db = getDb();

  let items = opts.items;
  // "Pull from the blueprint": seed the PO from the project's estimate rows.
  if (opts.fromEstimate && opts.leadId) {
    const est = db.prepare('SELECT label, qty, unit, unit_cost_cents FROM lead_estimate_items WHERE lead_id = ?')
      .all(opts.leadId) as { label: string; qty: number; unit: string | null; unit_cost_cents: number }[];
    if (est.length) {
      items = est.map((e) => ({ label: e.label, qty: e.qty || 1, unit: e.unit, unit_price_cents: e.unit_cost_cents || 0 }));
    }
  }
  if (!items?.length) throw new Error('No items — give me the materials list or add estimate line items to the project first');

  const stage = opts.neededByStage && BUILD_STAGES.some((s) => s.key === opts.neededByStage) ? opts.neededByStage : null;
  const po = nextPoNumber();
  const info = db.prepare(`
    INSERT INTO material_orders (lead_id, supplier_id, po_number, status, needed_by, needed_by_stage, notes)
    VALUES (?, ?, ?, 'draft', ?, ?, ?)
  `).run(opts.leadId ?? null, opts.supplierId ?? null, po, opts.neededBy ?? null, stage, opts.notes ?? null);
  const orderId = Number(info.lastInsertRowid);

  const ins = db.prepare('INSERT INTO material_order_items (order_id, label, qty, unit, unit_price_cents) VALUES (?, ?, ?, ?, ?)');
  for (const it of items) {
    ins.run(orderId, it.label.trim(), it.qty || 1, it.unit?.trim() || null, Math.max(0, Math.round(it.unit_price_cents || 0)));
    // Every priced line feeds the price ledger — history accrues for free.
    if (it.unit_price_cents > 0) {
      recordSupplierPrice(it.label, opts.supplierId ?? null, it.unit ?? null, it.unit_price_cents);
    }
  }

  // Draft the PO email up front so it's ready the moment Joe says send.
  const draft = buildPoEmail(orderId);
  db.prepare('UPDATE material_orders SET email_draft = ? WHERE id = ?').run(draft ? `Subject: ${draft.subject}\n\n${draft.body}` : null, orderId);

  if (opts.leadId) {
    logActivity(opts.leadId, 'note', { direction: 'system', body: `Purchase order ${po} drafted (${items.length} item(s))${stage ? ` — needed before ${BUILD_STAGES.find((s) => s.key === stage)?.label}` : ''}` });
  }
  return { orderId, po_number: po, items: items.length };
}

export type OrderDetail = OrderRow & { items: (OrderItem & { id: number })[]; supplier?: SupplierRow; lead_name?: string };

export function getOrder(orderId: number): OrderDetail | undefined {
  const db = getDb();
  const order = db.prepare('SELECT * FROM material_orders WHERE id = ?').get(orderId) as OrderRow | undefined;
  if (!order) return undefined;
  const items = db.prepare('SELECT id, label, qty, unit, unit_price_cents FROM material_order_items WHERE order_id = ?').all(orderId) as (OrderItem & { id: number })[];
  const supplier = order.supplier_id
    ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(order.supplier_id) as SupplierRow | undefined
    : undefined;
  const lead = order.lead_id
    ? db.prepare('SELECT name FROM leads WHERE id = ?').get(order.lead_id) as { name: string } | undefined
    : undefined;
  return { ...order, items, supplier, lead_name: lead?.name };
}

export function listOrders(filter: { leadId?: number; status?: string; openOnly?: boolean } = {}): OrderDetail[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.leadId) { where.push('lead_id = ?'); params.push(filter.leadId); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  if (filter.openOnly) { where.push("status IN ('draft','ready','ordered')"); }
  const rows = db.prepare(`SELECT id FROM material_orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`).all(...params) as { id: number }[];
  return rows.map((r) => getOrder(r.id)).filter((o): o is OrderDetail => !!o);
}

export function updateOrderStatus(orderId: number, status: string): { ok: boolean; error?: string } {
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) return { ok: false, error: `Status must be one of ${ORDER_STATUSES.join(', ')}` };
  const db = getDb();
  const order = db.prepare('SELECT id, lead_id, po_number FROM material_orders WHERE id = ?').get(orderId) as { id: number; lead_id: number | null; po_number: string | null } | undefined;
  if (!order) return { ok: false, error: `No order #${orderId}` };
  db.prepare('UPDATE material_orders SET status = ? WHERE id = ?').run(status, orderId);
  if (order.lead_id) logActivity(order.lead_id, 'note', { direction: 'system', body: `PO ${order.po_number}: ${status}` });
  return { ok: true };
}

/** The deterministic PO email to the supplier. */
export function buildPoEmail(orderId: number): { subject: string; body: string; toEmail: string | null } | null {
  const order = getOrder(orderId);
  if (!order) return null;
  const contact = order.supplier?.contact_name?.trim().split(/\s+/)[0];
  const total = order.items.reduce((sum, it) => sum + (it.unit_price_cents || 0) * (it.qty || 1), 0);
  const anyPriced = order.items.some((it) => it.unit_price_cents > 0);

  const lines = [
    `${contact ? `Hi ${contact},` : 'Hello,'}`,
    '',
    `We'd like to place the following order${order.lead_name ? ` for an upcoming project` : ''}:`,
    '',
    `Purchase order: ${order.po_number}`,
    ...(order.needed_by ? [`Needed on site by: ${order.needed_by}`] : []),
    '',
    ...order.items.map((it) => {
      const price = it.unit_price_cents > 0 ? ` @ ${money(it.unit_price_cents)}${it.unit ? `/${it.unit}` : ''}` : '';
      return `• ${it.qty} ${it.unit || 'x'} — ${it.label}${price}`;
    }),
    ...(anyPriced ? ['', `Estimated total: ${money(total)} (please confirm current pricing)`] : ['', 'Please reply with current pricing and availability.']),
    '',
    `Delivery address will be confirmed on the order call — or reach us at ${COMPANY.phone}.`,
    '',
    'Thank you,',
    COMPANY.name,
    COMPANY.address,
    COMPANY.phone,
  ];
  return {
    subject: `Purchase Order ${order.po_number} — ${COMPANY.name}`,
    body: lines.join('\n'),
    toEmail: order.supplier?.email || null,
  };
}

/** Email the PO to the supplier (Joe-approved action) and mark it ordered. */
export async function sendPurchaseOrder(orderId: number): Promise<{ ok: boolean; error?: string; to?: string; po_number?: string }> {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: `No order #${orderId}` };
  if (order.status === 'ordered' || order.status === 'delivered') return { ok: false, error: `PO ${order.po_number} was already sent (${order.status})` };
  const email = buildPoEmail(orderId);
  if (!email) return { ok: false, error: 'Could not build the PO email' };
  if (!email.toEmail) return { ok: false, error: `${order.supplier?.name || 'The supplier'} has no email on file — add one, or Joe can call it in at ${order.supplier?.phone || 'their number'}` };
  if (!anyGoogleAccountConnected()) return { ok: false, error: 'Gmail is not connected — connect it in Integrations first' };
  const from = GOOGLE_ACCOUNTS[0]?.email;
  if (!from) return { ok: false, error: 'No sending mailbox configured' };

  await sendNewEmail(from, { to: email.toEmail, subject: email.subject, body: email.body });
  const db = getDb();
  db.prepare("UPDATE material_orders SET status = 'ordered', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
  if (order.lead_id) {
    logActivity(order.lead_id, 'email', {
      direction: 'out', subject: email.subject, body: email.body,
      meta: { po_number: order.po_number, order_id: orderId, automated: true },
    });
  }
  return { ok: true, to: email.toEmail, po_number: order.po_number || undefined };
}

// ── Price ledger ──────────────────────────────────────────────────────────

export function recordSupplierPrice(material: string, supplierId: number | null, unit: string | null, priceCents: number): void {
  try {
    getDb().prepare('INSERT INTO material_prices (material, supplier_id, unit, price_cents) VALUES (?, ?, ?, ?)')
      .run(material.trim().toLowerCase(), supplierId, unit?.trim() || null, Math.round(priceCents));
  } catch (err) {
    console.error('[Materials] price record failed:', err);
  }
}

export interface PriceQuote {
  material: string; supplier: string | null; unit: string | null; price_cents: number; quoted_at: string;
}

export function priceHistory(material: string, limit = 12): PriceQuote[] {
  return getDb().prepare(`
    SELECT p.material, s.name AS supplier, p.unit, p.price_cents, p.quoted_at
    FROM material_prices p LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.material LIKE ?
    ORDER BY p.quoted_at DESC LIMIT ?
  `).all(`%${material.trim().toLowerCase()}%`, limit) as PriceQuote[];
}

// ── Stage-gate readiness check ────────────────────────────────────────────

/**
 * Called on build-stage moves: if the project is entering (or past) a stage
 * that an order was supposed to precede and the materials still aren't
 * ordered/delivered, flag Joe before the crew hits an empty site.
 */
export function checkMaterialReadiness(leadId: number, newStageKey: string): void {
  try {
    const stageIdx = buildStageIndex(newStageKey);
    if (stageIdx < 0) return;
    const orders = listOrders({ leadId, openOnly: true });
    const late = orders.filter((o) => {
      if (!o || !o.needed_by_stage) return false;
      if (o.status === 'ordered') return false; // on its way — delivery is tracked separately
      return buildStageIndex(o.needed_by_stage) <= stageIdx;
    });
    if (!late.length) return;
    const lead = getDb().prepare('SELECT name FROM leads WHERE id = ?').get(leadId) as { name: string } | undefined;
    const stageLabel = BUILD_STAGES.find((s) => s.key === newStageKey)?.label || newStageKey;
    const poList = late.map((o) => `${o!.po_number} (${o!.status})`).join(', ');
    const msg = `⚠️ ${lead?.name || 'Project'} moved to ${stageLabel} but materials aren't ordered yet: ${poList}.`;
    sendSms(msg, 'Materials');
    logActivity(leadId, 'note', { direction: 'system', body: msg });
  } catch (err) {
    console.error('[Materials] readiness check error:', err);
  }
}
