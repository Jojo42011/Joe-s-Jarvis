import { getDb } from '../db/schema';
import { ralphStats, createRalphContent, RALPH_CHANNELS } from '../db/ralph';
import { generateBatch } from '../services/ralphContent';
import { emailCountsByAccount, listGoogleAccounts, listUpcomingEvents, searchEmailItems } from '../db/google';
import { gscSummary, syncSearchConsole } from '../services/google/searchConsole';
import { createEvent } from '../services/google/calendar';
import { GOOGLE_ACCOUNTS } from '../config/google';
import { PIPELINE, logActivity } from '../routes/leads';

/** Dashboards Arlo can pull up in the UI. Keys match the shell's tab keys. */
export const UI_TABS = ['arlo', 'seo', 'content', 'calls', 'inbox', 'memory', 'integrations'];

/**
 * Function tools for Arlo's brain (Responses API — flat shape). Kept to safe,
 * reversible actions + reads + UI navigation. Sending email stays gated to the
 * Inbox panel; these never send mail.
 */
export const FUNCTION_TOOLS = [
  {
    type: 'function' as const,
    name: 'open_dashboard',
    description: "Pull up an agent's dashboard/tab in the UI for Joe to see (and you speak over it). Use when he asks how an agent is doing or to show him something. tab: seo=Lauren/SEO, content=Paulie, calls=Sofia, inbox=email, memory=neural map, integrations=connected tools, arlo=home.",
    parameters: {
      type: 'object',
      properties: { tab: { type: 'string', enum: UI_TABS } },
      required: ['tab'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'get_agent_status',
    description: 'Get live numbers for an agent so you can report them out loud. agent: seo, content, or inbox.',
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string', enum: ['seo', 'content', 'inbox'] } },
      required: ['agent'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'sync_seo_rankings',
    description: 'Refresh real Google Search Console rankings for the website now.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function' as const,
    name: 'create_content',
    description: "Add a content idea/draft to Paulie's pipeline.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        channel: { type: 'string', enum: RALPH_CHANNELS },
        status: { type: 'string', enum: ['idea', 'draft', 'scheduled'] },
      },
      required: ['title'], additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'generate_content_posts',
    description: "Have Paulie write real on-brand social posts (caption + AI image) into the Approvals queue for Joe to review. Runs in the background. Use when Joe says to make posts/content, fill the queue, or 'have Paulie draft something'. count defaults to 5; optional channel.",
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        channel: { type: 'string', enum: RALPH_CHANNELS },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'list_pending_seo_pages',
    description: "List Lauren's upcoming SEO pages — she writes, scores, and schedules them fully autonomously now, no approval needed. Use when Joe asks what Lauren's working on, what's coming next, or what's live already (title, type, target keyword, SEO score, scheduled date, id).",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function' as const,
    name: 'approve_seo_page',
    description: "Fast-track a specific Lauren page to publish RIGHT NOW instead of waiting for its scheduled date — Lauren already writes and schedules autonomously, so this is only for when Joe explicitly wants something live immediately. Confirm which page he means if ambiguous. id comes from list_pending_seo_pages.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'seo_content id from list_pending_seo_pages' },
        publish_now: { type: 'boolean', description: 'true = commit to the live site immediately instead of waiting for its scheduled date' },
      },
      required: ['id'], additionalProperties: false,
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
    description: "Search across all of Joe's mailboxes for a specific email by keyword (sender, subject, or content) — use when he asks about something older than the recent snapshot you're already given, e.g. 'did that vendor ever reply about the tile order'.",
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
      case 'sync_seo_rankings':
        return { result: await syncSearchConsole() };
      case 'create_content': {
        const id = createRalphContent({
          title: String(args.title || 'Untitled'),
          channel: args.channel ? String(args.channel) : 'blog',
          status: args.status ? String(args.status) : 'idea',
        });
        return { result: { ok: true, id } };
      }
      case 'generate_content_posts': {
        const count = Math.max(1, Math.min(Number(args.count) || 5, 12));
        const channel = args.channel ? String(args.channel) : undefined;
        // Slow (throttled image gen) — fire in the background so voice stays snappy.
        generateBatch(count, channel as never)
          .then((posts) => console.log(`[Paulie] voice-triggered batch done — ${posts.length} drafted`))
          .catch((err) => console.error('[Paulie] voice-triggered batch failed:', err));
        return { result: { ok: true, started: true, count, note: `Paulie is drafting ${count} post(s) into the Approvals queue now.` } };
      }
      case 'list_pending_seo_pages': {
        // Lauren writes straight to 'approved' now (no human gate) — this lists
        // whatever hasn't gone live yet, ordered by when it's scheduled to.
        const rows = getDb().prepare(`
          SELECT id, title, type, target_keyword, seo_score, seo_grade, scheduled_for, status, created_at
          FROM seo_content
          WHERE committed = 0
          ORDER BY scheduled_for ASC, created_at ASC
        `).all();
        return { result: { pending: rows, count: (rows as unknown[]).length } };
      }
      case 'approve_seo_page': {
        // Mirrors POST /api/seo/content/:id/approve — same guards, same effect.
        // Lauren already auto-approves on generation; this just fast-tracks the
        // publish date when Joe explicitly wants something live sooner.
        const db = getDb();
        const id = Number(args.id);
        const row = db.prepare('SELECT id, title, status, committed FROM seo_content WHERE id = ?').get(id) as
          | { id: number; title: string; status: string; committed: number }
          | undefined;
        if (!row) return { result: { ok: false, error: `No page with id ${id}` } };
        if (row.committed) return { result: { ok: false, error: 'Already published' } };
        if (row.status === 'denied') return { result: { ok: false, error: 'That page was denied' } };
        db.prepare(
          "UPDATE seo_content SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).run(id);
        if (args.publish_now === true) {
          const { publishContentToGithub } = await import('../services/seoPublish');
          const pub = await publishContentToGithub(id);
          return { result: { ok: pub.success, title: row.title, published: pub.success, liveUrl: pub.liveUrl ?? null, message: pub.message } };
        }
        return { result: { ok: true, title: row.title, approved: true, note: 'Will upload on the hourly publish cycle (or on its scheduled date).' } };
      }
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
