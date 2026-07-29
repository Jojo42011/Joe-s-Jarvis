import { getDb } from '../db/schema';
import { ralphStats, createRalphContent, RALPH_CHANNELS } from '../db/ralph';
import { generateBatch } from '../services/ralphContent';
import { emailCountsByAccount, listGoogleAccounts, listUpcomingEvents, searchEmailItems } from '../db/google';
import { gscSummary, syncSearchConsole } from '../services/google/searchConsole';
import { createEvent } from '../services/google/calendar';
import { GOOGLE_ACCOUNTS } from '../config/google';
import { PIPELINE, logActivity } from '../routes/leads';
import { BUILD_STAGES } from '../services/leadShared';
import { triggerStageInvoices, sendMilestoneInvoice, listOutstandingInvoices } from '../services/invoicing';
import {
  addSupplier, listSuppliers, findSupplier, createOrder, listOrders,
  updateOrderStatus, sendPurchaseOrder, priceHistory, checkMaterialReadiness,
  SUPPLIER_CATEGORIES, ORDER_STATUSES,
} from '../services/materials';

/** Dashboards Jarvis can pull up in the UI. Keys match the shell's tab keys
 *  exactly (client/shell.html SCREENS) — a key the shell doesn't know lands
 *  on Home instead of the screen Joe asked for. */
export const UI_TABS = [
  'home', 'approve', 'sweep', 'jarvis', 'chat', 'phones', 'crm', 'pipeline',
  'leads', 'inbox', 'money', 'materials', 'spend', 'sync', 'memory', 'team', 'hire',
];

/**
 * Function tools for Jarvis's brain (Responses API — flat shape). Kept to safe,
 * reversible actions + reads + UI navigation. Sending email stays gated to the
 * Inbox panel; these never send mail.
 */
export const FUNCTION_TOOLS = [
  {
    type: 'function' as const,
    name: 'open_dashboard',
    description: "Pull up a tab on Joe's screen (and keep talking over it). Use it whenever he says pull up / show me / let me see / bring up / open / take me to — otherwise you'll describe a page instead of displaying it. tab: home=everything at a glance, approve=email replies waiting on him, sweep=what he missed, jarvis=voice, chat=text, phones=Sofia's call log, crm=leads and the control panel, pipeline=weighted forecast, leads=message someone, inbox=email, money=outstanding invoices, materials=purchase orders and suppliers, spend=what the business pays for, sync=integrations, memory=neural map, team=who can sign in, hire=propose a new agent.",
    parameters: {
      type: 'object',
      properties: { tab: { type: 'string', enum: UI_TABS } },
      required: ['tab'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'get_agent_status',
    description: 'Get live numbers for the inbox so you can report them out loud.',
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string', enum: ['inbox'] } },
      required: ['agent'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'add_calendar_event',
    description: "Add an event to Joe's calendar (reversible, so you may do it directly). Times must be ISO 8601. account is optional (defaults to Joe's primary).",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 start datetime' },
        end: { type: 'string', description: 'ISO 8601 end datetime' },
        account: { type: 'string' },
      },
      required: ['title', 'start', 'end'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'list_calendar_events',
    description: "List Joe's upcoming calendar events (today forward) across one or all connected accounts. Use for 'what's on my calendar', 'am I free Thursday', 'what's next'.",
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Optional — filter to one mailbox/calendar' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'search_email',
    description: "Search across all of Joe's mailboxes for a specific email by keyword (sender, subject, or content) — use when he asks about something older than the recent snapshot you're already given, e.g. 'did that vendor ever reply about the mulch order'.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'list_crm_leads',
    description: 'List leads in the CRM pipeline, optionally filtered by stage or source. Use for "how many leads are in the pipeline", "what came in from ads", "show me what\'s booked".',
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: [...PIPELINE] },
        source: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'get_crm_lead',
    description: "Look up one lead's full detail (contact info, stage, notes, recent activity) by name or phone number.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name or phone number to search for' } },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'update_lead_stage',
    description: 'Move a CRM lead to a new pipeline stage (internal bookkeeping — reversible, so you may do it directly). Does NOT contact the lead.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        stage: { type: 'string', enum: [...PIPELINE] },
      },
      required: ['id', 'stage'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'add_lead_note',
    description: "Add a note to a CRM lead's timeline (internal bookkeeping — reversible, so you may do it directly).",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['id', 'note'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'update_build_stage',
    description: "Mark a project's field progress — move a lead's BUILD stage (not the sales pipeline). This is the field update that drives billing: when a stage move makes a milestone come due, the invoice (number + pay link + email) is prepared automatically, and materials that should precede the stage get checked. Use when Joe says a phase is done ('excavation's wrapped on Reynolds', 'we finished the hardscape').",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'lead/project id (look it up with get_crm_lead first if you only have a name)' },
        stage: { type: 'string', enum: BUILD_STAGES.map((s) => s.key) },
      },
      required: ['id', 'stage'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'list_outstanding_invoices',
    description: "List every unpaid milestone invoice across all projects — who owes what, invoice numbers, whether the invoice email has gone out, pay links. Use for 'who owes us money', 'any invoices outstanding', cash-flow questions.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function' as const,
    name: 'send_invoice',
    description: "Email a prepared milestone invoice (with its payment link) to the customer. OUTBOUND — only on Joe's explicit go-ahead ('send it', 'invoice them'). payment_id comes from list_outstanding_invoices.",
    parameters: {
      type: 'object',
      properties: { payment_id: { type: 'number' } },
      required: ['payment_id'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'add_supplier',
    description: 'Add a material supplier (wholesale nursery, rock yard, aggregate/mulch supplier) to the address book.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', enum: [...SUPPLIER_CATEGORIES] },
        contact_name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['name'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'list_suppliers',
    description: 'List the supplier address book, optionally by category (nursery, stone, aggregate, mulch, hardscape, equipment).',
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', enum: [...SUPPLIER_CATEGORIES] } },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'create_material_order',
    description: "Draft a purchase order for a project. Either pull the materials straight from the project's estimate line items (from_estimate: true — the blueprint) or pass the items Joe dictates. Optionally tie it to a supplier (by name) and the build stage the materials must arrive before. Creates a draft PO with a composed email — nothing is sent until Joe approves.",
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'number' },
        from_estimate: { type: 'boolean' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              qty: { type: 'number' },
              unit: { type: 'string', description: 'pallet | ton | yard | each | flat' },
              unit_price_cents: { type: 'number' },
            },
            required: ['label'],
          },
        },
        supplier: { type: 'string', description: 'supplier name to attach (looked up in the address book)' },
        needed_by: { type: 'string', description: 'ISO date the crew needs it on site' },
        needed_by_stage: { type: 'string', enum: BUILD_STAGES.map((s) => s.key) },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'list_material_orders',
    description: "List purchase orders — all open ones, or a specific project's. Shows PO number, supplier, status (draft/ready/ordered/delivered), items, and what stage they must precede.",
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'number' },
        open_only: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'update_material_order',
    description: "Update a purchase order's status — mark it ordered (called in by phone), delivered (materials on site), or cancelled.",
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'number' },
        status: { type: 'string', enum: [...ORDER_STATUSES] },
      },
      required: ['order_id', 'status'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'send_purchase_order',
    description: "Email a drafted PO to its supplier and mark it ordered. OUTBOUND — only on Joe's explicit go-ahead. If the supplier has no email on file, say so and give their phone number instead.",
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'number' } },
      required: ['order_id'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'material_price_history',
    description: "Joe's own quoted-price history for a material across suppliers and time (e.g. 'mulch', '#57 limestone', 'pavers'). This is how you answer price-trend questions — from his real quotes, never guessed. Empty history = say there's no record yet, offer to log the current quote.",
    parameters: {
      type: 'object',
      properties: { material: { type: 'string' } },
      required: ['material'], additionalProperties: false,
    },
  },
];

export interface ToolOutcome { result: unknown; navigate?: string }

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'open_dashboard': {
        const tab = String(args.tab || 'arlo').toLowerCase();
        return { result: { opened: UI_TABS.includes(tab) ? tab : 'arlo' }, navigate: UI_TABS.includes(tab) ? tab : 'arlo' };
      }
      case 'get_agent_status':
        return { result: agentStatus(String(args.agent || '')) };
      case 'add_calendar_event': {
        const acct = pickAccount(args.account ? String(args.account) : undefined);
        if (!acct) return { result: { ok: false, error: 'No connected Google account' } };
        const ev = await createEvent(acct, { summary: String(args.title), start: String(args.start), end: String(args.end) });
        return { result: { ok: true, ...ev, account: acct } };
      }
      case 'list_calendar_events': {
        const limit = Math.max(1, Math.min(Number(args.limit) || 10, 40));
        const account = args.account ? String(args.account) : undefined;
        const nowIso = new Date().toISOString();
        const events = listUpcomingEvents(account, 200)
          .filter((e) => !e.start_time || e.start_time >= nowIso)
          .slice(0, limit);
        return { result: { events } };
      }
      case 'search_email': {
        const query = String(args.query || '').trim();
        if (!query) return { result: { error: 'query required' } };
        const limit = Math.max(1, Math.min(Number(args.limit) || 10, 25));
        return { result: { emails: searchEmailItems(query, limit) } };
      }
      case 'list_crm_leads': {
        const db = getDb();
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (args.stage) { clauses.push('pipeline = ?'); params.push(String(args.stage)); }
        if (args.source) { clauses.push('source = ?'); params.push(String(args.source)); }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
        params.push(limit);
        const leads = db.prepare(
          `SELECT id, name, phone, project_type, pipeline, source, created_at FROM leads ${where} ORDER BY created_at DESC LIMIT ?`
        ).all(...params);
        return { result: { leads } };
      }
      case 'get_crm_lead': {
        const query = String(args.query || '').trim();
        if (!query) return { result: { error: 'query required' } };
        const db = getDb();
        const like = `%${query}%`;
        const lead = db.prepare(
          `SELECT * FROM leads WHERE name LIKE ? OR phone LIKE ? ORDER BY created_at DESC LIMIT 1`
        ).get(like, like);
        if (!lead) return { result: { found: false } };
        const leadId = (lead as { id: number }).id;
        const activities = db.prepare(
          `SELECT type, direction, subject, body, created_at FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT 8`
        ).all(leadId);
        return { result: { found: true, lead, activities } };
      }
      case 'update_lead_stage': {
        const id = Number(args.id);
        const stage = String(args.stage || '');
        if (!Number.isFinite(id) || !(PIPELINE as readonly string[]).includes(stage)) {
          return { result: { ok: false, error: 'valid id and stage required' } };
        }
        const db = getDb();
        const lead = db.prepare('SELECT pipeline FROM leads WHERE id = ?').get(id) as { pipeline?: string } | undefined;
        if (!lead) return { result: { ok: false, error: 'lead not found' } };
        const called = stage !== 'new' && stage !== 'lost' ? 1 : 0;
        const booked = ['booked', 'in_progress', 'completed'].includes(stage) ? 1 : 0;
        db.prepare('UPDATE leads SET pipeline = ?, called = MAX(called, ?), booked = MAX(booked, ?) WHERE id = ?')
          .run(stage, called, booked, id);
        if (stage !== lead.pipeline) {
          logActivity(id, 'stage', { direction: 'system', body: `Stage: ${lead.pipeline || 'new'} → ${stage}` });
        }
        return { result: { ok: true } };
      }
      case 'add_lead_note': {
        const id = Number(args.id);
        const note = String(args.note || '').trim();
        if (!Number.isFinite(id) || !note) return { result: { ok: false, error: 'valid id and note required' } };
        const lead = getDb().prepare('SELECT id FROM leads WHERE id = ?').get(id);
        if (!lead) return { result: { ok: false, error: 'lead not found' } };
        logActivity(id, 'note', { direction: 'system', body: note });
        return { result: { ok: true } };
      }
      case 'update_build_stage': {
        const id = Number(args.id);
        const stage = String(args.stage || '');
        if (!Number.isFinite(id) || !BUILD_STAGES.some((s) => s.key === stage)) {
          return { result: { ok: false, error: `valid id and stage required (${BUILD_STAGES.map((s) => s.key).join(', ')})` } };
        }
        const db = getDb();
        const lead = db.prepare('SELECT id, name, build_stage FROM leads WHERE id = ?').get(id) as { id: number; name: string; build_stage: string | null } | undefined;
        if (!lead) return { result: { ok: false, error: 'lead not found' } };
        if (lead.build_stage === stage) return { result: { ok: true, note: 'already at that stage' } };
        db.prepare('UPDATE leads SET build_stage = ? WHERE id = ?').run(stage, id);
        const label = BUILD_STAGES.find((s) => s.key === stage)?.label || stage;
        logActivity(id, 'stage', { direction: 'system', body: `Build stage → ${label}` });
        // The stage-gate: billing + material readiness fire in the background.
        setImmediate(() => {
          triggerStageInvoices(id, stage).catch((err) => console.error('[Billing] stage trigger failed:', err));
          checkMaterialReadiness(id, stage);
        });
        return { result: { ok: true, lead: lead.name, stage: label, note: 'Stage updated — any milestone now due gets its invoice prepared automatically (check list_outstanding_invoices in a moment).' } };
      }
      case 'list_outstanding_invoices':
        return { result: { invoices: listOutstandingInvoices() } };
      case 'send_invoice': {
        const pid = Number(args.payment_id);
        if (!Number.isFinite(pid)) return { result: { ok: false, error: 'payment_id required' } };
        return { result: await sendMilestoneInvoice(pid) };
      }
      case 'add_supplier': {
        const nm = String(args.name || '').trim();
        if (!nm) return { result: { ok: false, error: 'name required' } };
        const sid = addSupplier({
          name: nm,
          category: args.category ? String(args.category) : undefined,
          contact_name: args.contact_name ? String(args.contact_name) : undefined,
          phone: args.phone ? String(args.phone) : undefined,
          email: args.email ? String(args.email) : undefined,
          notes: args.notes ? String(args.notes) : undefined,
        });
        return { result: { ok: true, id: sid } };
      }
      case 'list_suppliers':
        return { result: { suppliers: listSuppliers(args.category ? String(args.category) : undefined) } };
      case 'create_material_order': {
        const leadId = args.lead_id !== undefined ? Number(args.lead_id) : null;
        let supplierId: number | null = null;
        let supplierNote: string | undefined;
        if (args.supplier) {
          const s = findSupplier(String(args.supplier));
          if (s) supplierId = s.id;
          else supplierNote = `No supplier matching "${args.supplier}" in the address book — PO created without one; add the supplier and attach it.`;
        }
        const rawItems = Array.isArray(args.items) ? (args.items as { label?: string; qty?: number; unit?: string; unit_price_cents?: number }[]) : [];
        const order = createOrder({
          leadId,
          supplierId,
          items: rawItems.filter((it) => it.label?.trim()).map((it) => ({
            label: String(it.label), qty: Number(it.qty) || 1,
            unit: it.unit ? String(it.unit) : null,
            unit_price_cents: Number(it.unit_price_cents) || 0,
          })),
          fromEstimate: args.from_estimate === true,
          neededBy: args.needed_by ? String(args.needed_by) : null,
          neededByStage: args.needed_by_stage ? String(args.needed_by_stage) : null,
        });
        return { result: { ok: true, ...order, note: supplierNote ?? 'PO drafted with its email ready — send_purchase_order when Joe approves.' } };
      }
      case 'list_material_orders':
        return { result: { orders: listOrders({
          leadId: args.lead_id !== undefined ? Number(args.lead_id) : undefined,
          openOnly: args.open_only !== false,
        }) } };
      case 'update_material_order': {
        const oid = Number(args.order_id);
        if (!Number.isFinite(oid)) return { result: { ok: false, error: 'order_id required' } };
        return { result: updateOrderStatus(oid, String(args.status || '')) };
      }
      case 'send_purchase_order': {
        const oid = Number(args.order_id);
        if (!Number.isFinite(oid)) return { result: { ok: false, error: 'order_id required' } };
        return { result: await sendPurchaseOrder(oid) };
      }
      case 'material_price_history': {
        const material = String(args.material || '').trim();
        if (!material) return { result: { ok: false, error: 'material required' } };
        return { result: { history: priceHistory(material) } };
      }
      default:
        return { result: { error: `unknown tool ${name}` } };
    }
  } catch (err) {
    return { result: { error: err instanceof Error ? err.message : 'tool failed' } };
  }
}

function pickAccount(preferred?: string): string | null {
  const connected = listGoogleAccounts().filter((a) => a.refresh_token);
  if (!connected.length) return null;
  if (preferred) {
    const m = connected.find((a) => a.email.toLowerCase().includes(preferred.toLowerCase()));
    if (m) return m.email;
  }
  const primary = connected.find((a) => a.email === GOOGLE_ACCOUNTS[0].email);
  return (primary || connected[0]).email;
}

function agentStatus(agent: string): unknown {
  const db = getDb();
  if (agent === 'seo') {
    const gsc = gscSummary();
    const kw = (db.prepare('SELECT COUNT(*) c FROM seo_keywords').get() as { c: number }).c;
    const pub = (db.prepare('SELECT COUNT(*) c FROM seo_content WHERE committed = 1').get() as { c: number }).c;
    const queue = (db.prepare("SELECT COUNT(*) c FROM seo_content WHERE committed = 0 AND status != 'denied'").get() as { c: number }).c;
    return { keywordsTracked: kw, pagesPublished: pub, inReviewQueue: queue, gscConnected: gsc.connected, rankings: gsc.connected ? gsc.totals : null };
  }
  if (agent === 'content') return { pipeline: ralphStats() };
  if (agent === 'inbox') return { mailboxes: emailCountsByAccount() };
  return { note: 'unknown agent' };
}
