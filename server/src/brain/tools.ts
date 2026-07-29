import { getDb } from '../db/schema';
import { ralphStats, createRalphContent, RALPH_CHANNELS } from '../db/ralph';
import { generateBatch } from '../services/ralphContent';
import {
  emailCountsByAccount, listGoogleAccounts, listUpcomingEvents, searchEmailItems,
  listEmailItems, getEmailItem, anyGoogleAccountConnected,
} from '../db/google';
import { searchFacts, searchFactsSemantic } from '../db/memory';
import { embedText, embeddingProvider } from '../services/embeddings';
import { gscSummary, syncSearchConsole } from '../services/google/searchConsole';
import { createEvent } from '../services/google/calendar';
import { GOOGLE_ACCOUNTS } from '../config/google';
import { PIPELINE, logActivity } from '../routes/leads';
import { BUILD_STAGES, STAGE_WEIGHT } from '../services/leadShared';
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

  // ── Full-system reads ────────────────────────────────────────────────────
  // Everything Joe can see on a screen, Jarvis can now answer out loud. Each of
  // these reads the same tables the corresponding screen renders, so a spoken
  // answer and the UI can never disagree.
  {
    type: 'function' as const,
    name: 'whats_on_today',
    description: "Everything that needs Joe today, in one call: what is waiting on him (drafted email replies, invoices ready to send, purchase orders a job has already passed the stage for), today's appointments, open lead count and weighted pipeline value. Use for 'what's on today', 'what do I need to do', 'brief me', 'where do things stand', 'how are we doing'.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function' as const,
    name: 'what_did_i_miss',
    description: "What came in over the last N days and — first — what nobody acted on: leads still sitting at 'new' with no activity, and emails flagged as needing a reply that never got one. Use for 'what did I miss', 'anything slip', 'did anyone fall through the cracks', 'catch me up'.",
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Window in days. Default 7.' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'list_calls',
    description: "Sofia's call log — who rang, when, how long, whether it booked, and her summary of what they wanted. Optionally filter to a phone number or name. Use for 'who called', 'what did that caller want', 'how many calls today', 'did anyone call about the patio'.",
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional name or phone fragment to filter by.' },
        days: { type: 'number', description: 'Only calls in the last N days.' },
        limit: { type: 'number', description: 'Max calls to return. Default 15.' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'read_email',
    description: "Open one specific email in full — the whole body, who sent it, when, whether Jarvis drafted a reply and what that draft says. Use after search_email when Joe asks 'what does it actually say', 'read me that email', 'what did she want'. Pass the email_id from search_email, or a search phrase to take the best match.",
    parameters: {
      type: 'object',
      properties: {
        email_id: { type: 'number', description: 'id from search_email.' },
        query: { type: 'string', description: 'Search phrase, if no id — the best match is read.' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'inbox_overview',
    description: "The state of the mailbox as a whole: how many emails need a reply, how many replies Jarvis has drafted and is waiting on approval for, unread count, and the most recent messages. Use for 'how's my inbox', 'anything need answering', 'what's come in'.",
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Recent emails to include. Default 10.' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'pipeline_forecast',
    description: "The sales pipeline stage by stage: how many leads sit at each stage, their total value, and the probability-weighted forecast. Use for 'what's the pipeline worth', 'how much is in play', 'how many quotes are out', forecasting questions. Leads with no project value recorded are reported as such, never counted as zero.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function' as const,
    name: 'money_summary',
    description: "The money picture: what has actually been collected, what is still owed and by whom, and which invoices are prepared but not yet sent. Use for 'how much have we brought in', 'what are we owed', 'did the Reynolds payment land', cash questions.",
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Restrict collected figures to the last N days.' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'list_spend',
    description: "What the business pays for — recurring subscriptions and costs, what each returns, and the monthly total. Use for 'what are we spending', 'what's this costing', 'anything we should cancel'.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function' as const,
    name: 'search_memory',
    description: "Search everything Jarvis has ever been told or has learned — decisions, preferences, facts about customers and jobs. Use when Joe refers to something from the past: 'what did we decide about', 'what do you know about', 'remind me what I said about'. This searches by meaning, so his words need not match what was stored.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall.' },
        limit: { type: 'number', description: 'Max facts. Default 8.' },
      },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'system_health',
    description: "Which parts of Joe's system are actually working right now — brain, voice, phone (Sofia/Vapi), mailbox and calendar, web search, memory recall — and for anything down, the specific reason. Use for 'is everything working', 'why isn't Sofia picking up', 'are you connected to my email', 'what's broken'.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
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
      case 'whats_on_today':
        return { result: whatsOnToday() };

      case 'what_did_i_miss':
        return { result: whatDidIMiss(Math.max(1, Math.min(Number(args.days) || 7, 90))) };

      case 'list_calls':
        return {
          result: listCalls(
            args.search ? String(args.search) : undefined,
            args.days ? Number(args.days) : undefined,
            Math.max(1, Math.min(Number(args.limit) || 15, 50)),
          ),
        };

      case 'read_email':
        return { result: readEmail(args.email_id ? Number(args.email_id) : undefined, args.query ? String(args.query) : undefined) };

      case 'inbox_overview':
        return { result: inboxOverview(Math.max(1, Math.min(Number(args.limit) || 10, 30))) };

      case 'pipeline_forecast':
        return { result: pipelineForecast() };

      case 'money_summary':
        return { result: moneySummary(args.days ? Number(args.days) : undefined) };

      case 'list_spend':
        return { result: listSpendItems() };

      case 'search_memory':
        return { result: await searchMemoryTool(String(args.query || ''), Math.max(1, Math.min(Number(args.limit) || 8, 20))) };

      case 'system_health':
        return { result: systemHealth() };

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

/* ══════════════════════════════════════════════════════════════════════════
   Full-system reads.

   These back the tools that let Jarvis answer about anything in Joe's system
   out loud. Two rules run through all of them:

   1. Every figure is read from the same tables the corresponding screen
      renders, so a spoken answer and the UI cannot disagree.
   2. Unknown is never reported as zero. When a mailbox is not connected or no
      lead carries a value, the payload says so in words and the model is left
      no room to round it down to "nothing".
   ═════════════════════════════════════════════════════════════════════════ */

function centsToUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function ohioToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function openLeadRows(): { id: number; name: string; pipeline: string | null; project_value_cents: number | null; build_stage: string | null }[] {
  return getDb().prepare(
    `SELECT id, name, pipeline, project_value_cents, build_stage FROM leads
     WHERE COALESCE(pipeline,'new') NOT IN ('completed','lost')`,
  ).all() as never;
}

function whatsOnToday(): unknown {
  const db = getDb();
  const mailboxConnected = anyGoogleAccountConnected();

  const drafts = mailboxConnected
    ? listEmailItems({ pendingDraftsOnly: true, limit: 50 })
    : [];

  const invoices = listOutstandingInvoices();
  const unsent = invoices.filter((i) => !i.invoice_sent_at);

  const leads = openLeadRows();
  const openOrders = listOrders({ openOnly: true });
  const lateOrders = openOrders.filter((o) => {
    if (!o.needed_by_stage || o.status === 'ordered') return false;
    const at = leads.find((l) => l.id === o.lead_id)?.build_stage;
    if (!at) return false;
    const need = BUILD_STAGES.findIndex((s) => s.key === o.needed_by_stage);
    const cur = BUILD_STAGES.findIndex((s) => s.key === at);
    return need >= 0 && cur >= 0 && need <= cur;
  });

  const today = ohioToday();
  const todaysEvents = mailboxConnected
    ? listUpcomingEvents(undefined, 60).filter((e) => String(e.start_time || '').slice(0, 10) === today)
    : [];

  const valued = leads.filter((l) => (l.project_value_cents || 0) > 0);
  const weighted = leads.reduce(
    (sum, l) => sum + (l.project_value_cents || 0) * (STAGE_WEIGHT[l.pipeline || 'new'] ?? 0.05), 0,
  );

  return {
    waitingOnJoe: {
      total: drafts.length + unsent.length + lateOrders.length,
      draftedEmailReplies: drafts.map((d) => ({ id: d.id, subject: d.subject, from: d.from_addr })),
      invoicesReadyToSend: unsent.map((i) => ({ invoice: i.invoice_no, project: i.lead_name, amount: centsToUsd(i.amount_cents), milestone: i.label })),
      lateMaterials: lateOrders.map((o) => ({ po: o.po_number, project: o.lead_name, status: o.status, neededBeforeStage: o.needed_by_stage })),
    },
    appointmentsToday: mailboxConnected
      ? todaysEvents.map((e) => ({ at: e.start_time, what: e.summary, where: e.location || null }))
      : 'unknown — no calendar is connected, so today\'s appointments cannot be read. This is not the same as having none.',
    pipeline: {
      openLeads: leads.length,
      weightedForecast: valued.length
        ? centsToUsd(Math.round(weighted))
        : 'unconfirmed — no open lead has a project value recorded, so a forecast cannot be computed. Do not say $0.',
      leadsWithAValue: valued.length,
    },
  };
}

function whatDidIMiss(days: number): unknown {
  const db = getDb();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const mailboxConnected = anyGoogleAccountConnected();

  const newLeads = db.prepare(
    'SELECT id, name, phone, source, message, pipeline, created_at FROM leads WHERE created_at >= ? ORDER BY created_at DESC',
  ).all(since) as { id: number; name: string; phone: string; source: string; message: string; pipeline: string; created_at: string }[];

  // Nobody acted on it: still at 'new' and nothing logged against it since.
  const untouched = newLeads.filter((l) => (l.pipeline || 'new') === 'new');

  let calls: unknown[] = [];
  try {
    calls = db.prepare(
      'SELECT customer_name, number, direction, duration_sec, booked, summary, started_at FROM vapi_calls WHERE COALESCE(started_at, created_at) >= ? ORDER BY COALESCE(started_at, created_at) DESC LIMIT 40',
    ).all(since) as unknown[];
  } catch { /* table shape older than this build — fall through with none */ }

  const unanswered = mailboxConnected
    ? (db.prepare(
        'SELECT id, subject, from_addr, received_at FROM email_items WHERE needs_reply = 1 AND received_at >= ? ORDER BY received_at DESC LIMIT 40',
      ).all(since) as unknown[])
    : [];

  return {
    windowDays: days,
    since,
    nobodyActedOn: {
      leadsStillUntouched: untouched.map((l) => ({ name: l.name, phone: l.phone, source: l.source, wanted: l.message, came_in: l.created_at })),
      emailsNeedingAReply: mailboxConnected
        ? unanswered
        : 'unknown — no mailbox is connected, so unanswered email cannot be checked. Not zero.',
    },
    newLeads: newLeads.length,
    calls,
    callsNote: (calls as unknown[]).length === 0
      ? 'No calls are recorded in this window. If Sofia\'s phone sync is failing, this reads as zero when it may not be — check system_health before telling Joe nobody called.'
      : undefined,
  };
}

function listCalls(search: string | undefined, days: number | undefined, limit: number): unknown {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (search) {
    where.push('(customer_name LIKE ? OR number LIKE ? OR summary LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (days) {
    where.push('COALESCE(started_at, created_at) >= ?');
    params.push(new Date(Date.now() - days * 86400_000).toISOString());
  }
  const sql = `SELECT customer_name, number, direction, duration_sec, connected, booked, summary, started_at
               FROM vapi_calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY COALESCE(started_at, created_at) DESC LIMIT ?`;
  try {
    const calls = db.prepare(sql).all(...params, limit) as unknown[];
    const total = (db.prepare('SELECT COUNT(*) c FROM vapi_calls').get() as { c: number }).c;
    return {
      calls,
      totalCallsOnRecord: total,
      note: total === 0
        ? 'There are no calls on record at all. Check system_health — if the phone connection is failing, "no calls" means "not syncing", not "nobody rang".'
        : undefined,
    };
  } catch (err) {
    return { error: 'Call log unavailable', detail: err instanceof Error ? err.message : String(err) };
  }
}

function readEmail(id: number | undefined, query: string | undefined): unknown {
  if (!anyGoogleAccountConnected()) {
    return { error: 'No mailbox is connected, so no email can be read. Tell Joe to connect Gmail in Integrations.' };
  }
  let row = id ? getEmailItem(id) : undefined;
  if (!row && query) {
    const hits = searchEmailItems(query, 1);
    if (hits.length) row = getEmailItem(hits[0].id);
  }
  if (!row) return { error: 'No matching email found.' };
  return {
    email: {
      id: row.id,
      from: row.from_addr,
      to: row.to_addr,
      subject: row.subject,
      received: row.received_at,
      unread: !!row.is_unread,
      priority: row.priority,
      category: row.category,
      needsReply: !!row.needs_reply,
      summary: row.summary,
      body: row.snippet,
      bodyNote: 'This is the synced snippet — the beginning of the message, not always the whole thing. Say so if Joe needs the full text.',
      draftedReply: row.draft_reply || null,
      draftStatus: row.draft_status || null,
    },
  };
}

function inboxOverview(limit: number): unknown {
  if (!anyGoogleAccountConnected()) {
    return { error: 'No mailbox is connected. Inbox figures are unknown, not zero.' };
  }
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    needingReply: one('SELECT COUNT(*) c FROM email_items WHERE needs_reply = 1'),
    repliesDraftedAwaitingApproval: one("SELECT COUNT(*) c FROM email_items WHERE draft_reply IS NOT NULL AND draft_status = 'pending'"),
    unread: one('SELECT COUNT(*) c FROM email_items WHERE is_unread = 1'),
    totalSynced: one('SELECT COUNT(*) c FROM email_items'),
    byMailbox: emailCountsByAccount(),
    recent: db.prepare(
      'SELECT id, from_addr, subject, received_at, needs_reply, priority FROM email_items ORDER BY received_at DESC LIMIT ?',
    ).all(limit),
  };
}

function pipelineForecast(): unknown {
  const leads = openLeadRows();
  const byStage = PIPELINE.filter((s) => s !== 'completed' && s !== 'lost').map((stage) => {
    const inStage = leads.filter((l) => (l.pipeline || 'new') === stage);
    const valued = inStage.filter((l) => (l.project_value_cents || 0) > 0);
    const total = inStage.reduce((s, l) => s + (l.project_value_cents || 0), 0);
    return {
      stage,
      leads: inStage.length,
      leadsWithAValue: valued.length,
      value: valued.length ? centsToUsd(total) : 'no values recorded at this stage',
      weight: STAGE_WEIGHT[stage],
      weightedValue: valued.length ? centsToUsd(Math.round(total * (STAGE_WEIGHT[stage] ?? 0.05))) : null,
    };
  });
  const valuedAll = leads.filter((l) => (l.project_value_cents || 0) > 0);
  const weighted = leads.reduce(
    (s, l) => s + (l.project_value_cents || 0) * (STAGE_WEIGHT[l.pipeline || 'new'] ?? 0.05), 0,
  );
  return {
    byStage,
    openLeads: leads.length,
    leadsWithAValue: valuedAll.length,
    leadsWithNoValueRecorded: leads.length - valuedAll.length,
    weightedForecast: valuedAll.length
      ? centsToUsd(Math.round(weighted))
      : 'unconfirmed — nothing open carries a project value, so there is no forecast to give. Do not say zero.',
  };
}

function moneySummary(days: number | undefined): unknown {
  const db = getDb();
  const outstanding = listOutstandingInvoices();
  const owed = outstanding.reduce((s, i) => s + i.amount_cents, 0);

  let collectedSql = "SELECT COALESCE(SUM(amount_cents),0) c FROM lead_payments WHERE status = 'paid'";
  const params: unknown[] = [];
  if (days) {
    collectedSql += ' AND paid_at >= ?';
    params.push(new Date(Date.now() - days * 86400_000).toISOString());
  }
  const collected = (db.prepare(collectedSql).get(...params) as { c: number }).c;

  return {
    collected: centsToUsd(collected),
    collectedWindow: days ? `last ${days} day(s)` : 'all time',
    owed: centsToUsd(owed),
    outstandingInvoices: outstanding.map((i) => ({
      invoice: i.invoice_no, project: i.lead_name, milestone: i.label,
      amount: centsToUsd(i.amount_cents),
      emailSent: !!i.invoice_sent_at,
      payLink: i.payment_url || null,
    })),
    preparedButNotSent: outstanding.filter((i) => !i.invoice_sent_at).length,
  };
}

function listSpendItems(): unknown {
  const db = getDb();
  try {
    const rows = db.prepare(
      'SELECT id, name, category, monthly_cents, returns, status, notes FROM spend_items ORDER BY monthly_cents DESC',
    ).all() as { monthly_cents: number; status: string }[];
    const active = rows.filter((r) => r.status !== 'cancelled');
    return {
      items: rows,
      monthlyTotal: centsToUsd(active.reduce((s, r) => s + (r.monthly_cents || 0), 0)),
      note: rows.length === 0 ? 'Nothing has been logged on the spend screen yet.' : undefined,
    };
  } catch {
    return { items: [], note: 'The spend list has not been set up yet.' };
  }
}

async function searchMemoryTool(query: string, limit: number): Promise<unknown> {
  if (!query.trim()) return { error: 'query required' };
  try {
    const vec = await embedText(query);
    const facts = vec ? searchFactsSemantic(query, vec, limit) : searchFacts(query, limit);
    return {
      facts: facts.map((f) => ({ fact: f.content, category: f.category, relevance: Number(f.score.toFixed(3)) })),
      matchedBy: vec ? 'meaning' : 'keywords only (semantic recall unavailable)',
      note: facts.length === 0 ? 'Nothing recorded on that. Say so rather than guessing.' : undefined,
    };
  } catch (err) {
    return { error: 'Memory search failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

function systemHealth(): unknown {
  const set = (k: string) => !!(process.env[k] && process.env[k]!.trim());
  const mailbox = anyGoogleAccountConnected();
  let callsSynced = 0;
  try { callsSynced = (getDb().prepare('SELECT COUNT(*) c FROM vapi_calls').get() as { c: number }).c; } catch { /* ignore */ }

  return {
    brain: set('ANTHROPIC_API_KEY') ? 'working' : 'DOWN — ANTHROPIC_API_KEY is not set, so I cannot think',
    voice: set('ELEVENLABS_API_KEY') ? 'working' : (set('DEEPGRAM_API_KEY') ? 'ElevenLabs missing — running on the Deepgram fallback' : 'DOWN — no speech provider configured'),
    phone: set('VAPI_API_KEY')
      ? (callsSynced > 0 ? 'working' : 'key present but no calls have ever synced — likely the wrong Vapi key type (public vs private). Do NOT tell Joe nobody called; tell him the phone sync is failing.')
      : 'DOWN — VAPI_API_KEY is not set, so Sofia logs nothing',
    mailboxAndCalendar: mailbox ? 'connected' : 'NOT CONNECTED — no Gmail account has authorised, so email and calendar are unknown',
    webSearch: set('BRAVE_API_KEY') ? 'working' : 'unavailable',
    memoryRecall: embeddingProvider() ? `working (${embeddingProvider()})` : 'keyword only — no embedding provider configured',
    payments: set('STRIPE_SECRET_KEY') ? 'working' : 'no Stripe key — invoices can be emailed but carry no pay link',
  };
}
