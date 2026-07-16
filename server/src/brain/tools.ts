import { getDb } from '../db/schema';
import { ralphStats, createRalphContent, RALPH_CHANNELS } from '../db/ralph';
import { generateBatch } from '../services/ralphContent';
import { emailCountsByAccount, listGoogleAccounts, listUpcomingEvents, searchEmailItems } from '../db/google';
import { gscSummary, syncSearchConsole } from '../services/google/searchConsole';
import { createEvent } from '../services/google/calendar';
import { GOOGLE_ACCOUNTS } from '../config/google';
import { PIPELINE, logActivity } from '../routes/leads';

/** Dashboards Jarvis can pull up in the UI. Keys match the shell's tab keys. */
export const UI_TABS = ['arlo', 'calls', 'inbox', 'memory', 'integrations'];

/**
 * Function tools for Jarvis's brain (Responses API — flat shape). Kept to safe,
 * reversible actions + reads + UI navigation. Sending email stays gated to the
 * Inbox panel; these never send mail.
 */
export const FUNCTION_TOOLS = [
  {
    type: 'function' as const,
    name: 'open_dashboard',
    description: "Pull up a tab in the UI for Joe to see (and you speak over it). Use when he asks to show him something. tab: calls=Sofia/phone log, inbox=email, memory=neural map, integrations=connected tools, arlo=home.",
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
