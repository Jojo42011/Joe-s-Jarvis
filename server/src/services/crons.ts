import { getDb } from '../db/schema';
import { getSystemState, setSystemState } from '../db/queries';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_FAST_MODEL } from '../config/models';
import { getMemoryPacket } from '../brain/memoryPacket';
import { ARLO_SYSTEM_PROMPT } from '../config/constants';
import { runSeoAgent } from './seoAgent';
import { publishDueContent, checkAllLiveStatuses } from './seoPublish';
import { runReflection } from './reflection';
import { syncAllAccounts } from './google/monitor';
import { syncSearchConsole } from './google/searchConsole';
import { generateBatch, pendingDraftCount, publishRalphPost } from './ralphContent';
import { isZernioChannel, hasZernio } from './zernio';

const LAST_BRIEFED_KEY = 'last_briefed_date';

function getOhioDateString(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function getTimeAwareGreeting(): string {
  const hour = parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }),
    10
  );
  if (hour < 12) return 'Good morning, sir.';
  if (hour < 17) return 'Good afternoon, sir.';
  return 'Good evening, sir.';
}

export async function handleActivation(): Promise<string> {
  const today = getOhioDateString();
  const lastBriefed = getSystemState(LAST_BRIEFED_KEY);

  if (today !== lastBriefed) {
    const brief = await generateMorningBrief();
    setSystemState(LAST_BRIEFED_KEY, today);
    return brief;
  }

  return getTimeAwareGreeting();
}

async function generateMorningBrief(): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return getTimeAwareGreeting();

  const packet = await getMemoryPacket('morning briefing priorities');
  const client = new Anthropic({ apiKey });

  // Surface Lauren's approval queue explicitly — pages can sit generated but
  // unapproved indefinitely (publish is gated on human sign-off), and that
  // backlog is otherwise invisible unless someone opens /atlas.
  let seoQueueNote = '';
  try {
    const db = getDb();
    const pending = db.prepare(
      "SELECT COUNT(*) AS c FROM seo_content WHERE committed = 0 AND status IN ('pending_review','ready')",
    ).get() as { c: number };
    if (pending?.c > 0) {
      seoQueueNote = `\n\nLauren has ${pending.c} page(s) generated and waiting on Joe's approval in the Atlas queue.`;
    }
  } catch {
    // non-critical — brief still works without this note
  }

  try {
    const response = await client.messages.create({
      model: ANTHROPIC_FAST_MODEL,
      max_tokens: 256,
      system: `${ARLO_SYSTEM_PROMPT}\n\n## MEMORY\n${packet.text}${seoQueueNote}\n\nGenerate a morning brief for Joe. Max 4 sentences. Most urgent first. Open with a time-aware greeting. Mention the SEO approval queue if noted above. If nothing new, say all clear and ask what he needs.`,
      messages: [{ role: 'user', content: 'Morning brief.' }],
    });
    const block = response.content.find((b) => b.type === 'text');
    return block && block.type === 'text' ? block.text : getTimeAwareGreeting();
  } catch {
    return getTimeAwareGreeting();
  }
}

export function scheduleDailyDecay(): void {
  setInterval(() => {
    try {
      const db = getDb();
      db.exec(`
        UPDATE facts SET strength = strength * 0.995
        WHERE last_accessed < datetime('now', '-1 day');
        UPDATE rules SET confidence = confidence * 0.999
        WHERE last_reinforced < datetime('now', '-7 days');
      `);
      console.log('[Arlo] Daily memory decay applied');
    } catch (err) {
      console.error('[Arlo] Decay error:', err);
    }
  }, 24 * 60 * 60 * 1000);
}

export function scheduleWeeklySynthesis(): void {
  const run = async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const db = getDb();
    const episodes = db.prepare(`
      SELECT summary FROM episodes
      WHERE created_at >= datetime('now', '-7 days')
      ORDER BY created_at DESC
    `).all() as { summary: string }[];

    const facts = db.prepare(`
      SELECT content FROM facts ORDER BY strength DESC LIMIT 20
    `).all() as { content: string }[];

    const rules = db.prepare(`
      SELECT rule FROM rules WHERE confidence > 0.6
    `).all() as { rule: string }[];

    if (episodes.length === 0 && facts.length === 0) return;

    const client = new Anthropic({ apiKey });
    const context = [
      'EPISODES:\n' + episodes.map((e) => `- ${e.summary}`).join('\n'),
      'TOP FACTS:\n' + facts.map((f) => `- ${f.content}`).join('\n'),
      'RULES:\n' + rules.map((r) => `- ${r.rule}`).join('\n'),
    ].join('\n\n');

    try {
      const response = await client.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 1024,
        system: 'Synthesize weekly patterns, risks, and recommendations for Joe. Be concise.',
        messages: [{ role: 'user', content: context }],
      });
      const block = response.content.find((b) => b.type === 'text');
      if (block && block.type === 'text') {
        db.prepare(`
          INSERT INTO syntheses (content, period_start, period_end)
          VALUES (?, datetime('now', '-7 days'), datetime('now'))
        `).run(block.text);
        console.log('[Arlo] Weekly synthesis complete');
      }
    } catch (err) {
      console.error('[Arlo] Synthesis error:', err);
    }

    scheduleNextSunday();
  };

  const scheduleNextSunday = () => {
    const now = new Date();
    const next = new Date(now);
    next.setDate(now.getDate() + ((7 - now.getDay()) % 7 || 7));
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 7);
    const ms = next.getTime() - now.getTime();
    setTimeout(() => { run(); }, ms);
  };

  scheduleNextSunday();
}

// Lauren generates exactly ONE page per run (for reliability). Cadence is daily
// (was every 3 days) — one page/day accumulates faster while still avoiding
// image-gen rate-limit pileups from generating multiple pages in one run.
const SEO_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Fly.io processes restart on deploys/scale-events, which resets any in-memory
// setInterval. That silently starves this cron — the old "no previous runs"
// check only guarded total silence, not a gap after a restart. So on every
// boot we check whether a run is actually OVERDUE (last run + interval < now)
// and catch up immediately if so, instead of only checking "has a run ever
// happened." The recurring check re-reads the DB each tick (rather than
// trusting a long-lived timer) so a mid-interval restart can't push the next
// run later than intended.
export function scheduleSeoAgent(): void {
  const db = getDb();
  const lastRun = db.prepare('SELECT started_at FROM seo_runs ORDER BY started_at DESC LIMIT 1').get() as { started_at: string } | undefined;

  const isOverdue = (startedAt: string | undefined): boolean => {
    if (!startedAt) return true;
    const last = new Date(startedAt.replace(' ', 'T') + 'Z').getTime();
    return Date.now() - last >= SEO_RUN_INTERVAL_MS;
  };

  if (isOverdue(lastRun?.started_at)) {
    const reason = lastRun ? `last run was ${lastRun.started_at}, overdue` : 'no previous runs';
    console.log(`[SEO Agent] Catch-up run triggering on boot — ${reason}`);
    runSeoAgent().catch((err) => console.error('[SEO Agent] Catch-up run error:', err));
  }

  setInterval(() => {
    const row = getDb().prepare('SELECT started_at FROM seo_runs ORDER BY started_at DESC LIMIT 1').get() as { started_at: string } | undefined;
    if (isOverdue(row?.started_at)) {
      console.log('[SEO Agent] Daily trigger firing');
      runSeoAgent().catch((err) => console.error('[SEO Agent] Scheduled run error:', err));
    }
  }, 60 * 60 * 1000);

  console.log('[SEO Agent] Scheduled — checks hourly, runs when 24h have elapsed since the last run (one page per run)');
}

export function scheduleSeoPublish(): void {
  const run = () => {
    publishDueContent().catch((err) => console.error('[SEO Agent] Scheduled publish error:', err));
  };
  run();
  setInterval(run, 60 * 60 * 1000);
  console.log('[SEO Agent] Publish scheduler — checks hourly for approved content due');
}

// Reflection: Arlo synthesizes higher-level insights from recent memories.
// First pass 10 min after boot (once seed/conversation exists), then every 12h.
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

// Inbox + calendar monitor: pulls the connected mailboxes, triages with Joe's
// judgment, drafts replies, and refreshes the calendar cache — on a timely loop.
const INBOX_SYNC_MS = parseInt(process.env.GOOGLE_SYNC_MS || String(15 * 60 * 1000), 10);

export function scheduleInboxSync(): void {
  const run = () => {
    syncAllAccounts().catch((err) => console.error('[Inbox] scheduled sync error:', err));
  };
  // First sweep 90s after boot (gives OAuth/secrets time), then on interval.
  setTimeout(run, 90 * 1000);
  setInterval(run, INBOX_SYNC_MS);
  console.log(`[Inbox] Monitor scheduled — every ${Math.round(INBOX_SYNC_MS / 60000)} min across the connected mailboxes`);
}

export function scheduleReflection(): void {
  const run = () => {
    runReflection().catch((err) => console.error('[Reflection] scheduled error:', err));
  };
  setTimeout(run, 10 * 60 * 1000);
  setInterval(run, TWELVE_HOURS_MS);
  console.log('[Reflection] Scheduled — synthesizes insights 10 min after boot, then every 12h');
}

// Real SEO rankings from Google Search Console — daily, plus 3 min after boot.
export function scheduleSearchConsole(): void {
  const run = () => {
    syncSearchConsole()
      .then((r) => { if (r.connected) console.log(`[GSC] daily sync — ${r.rows} queries, ${r.updatedKeywords} keywords updated`); })
      .catch((err) => console.error('[GSC] scheduled error:', err));
  };
  setTimeout(run, 3 * 60 * 1000);
  setInterval(run, 24 * 60 * 60 * 1000);
  console.log('[GSC] Search Console ranking sync scheduled — daily');
}

// Paulie auto-generation — keeps a queue of fresh on-brand posts stocked so there's
// always something ready to publish. Autonomous by default; set
// RALPH_AUTOGEN_ENABLED=0 to fall back to manual-only generation (e.g. to control
// image-gen API costs). Tops the queue up to a target so it never over-produces.
// Daily, plus a first fill 4 min after boot.
export function scheduleRalphContent(): void {
  if (process.env.RALPH_AUTOGEN_ENABLED === '0') {
    console.log('[Paulie] Auto-generation disabled via RALPH_AUTOGEN_ENABLED=0. Manual generation still available.');
    return;
  }
  const target = Math.max(1, parseInt(process.env.RALPH_AUTOGEN_TARGET || '5', 10));
  const perRun = Math.max(1, parseInt(process.env.RALPH_AUTOGEN_PER_RUN || '3', 10));
  const run = () => {
    const pending = pendingDraftCount();
    if (pending >= target) { console.log(`[Paulie] Auto-gen skipped — ${pending} draft(s) already queued`); return; }
    const need = Math.min(perRun, target - pending);
    generateBatch(need)
      .then((posts) => console.log(`[Paulie] Auto-gen produced ${posts.length} draft(s) — ${pendingDraftCount()} now queued`))
      .catch((err) => console.error('[Paulie] Auto-gen error:', err));
  };
  setTimeout(run, 4 * 60 * 1000);
  setInterval(run, 24 * 60 * 60 * 1000);
  console.log('[Paulie] Auto-generation scheduled — daily top-up of the content queue');
}

interface DuePost { id: number; scheduled_for: string | null; channel: string; format: string | null }

/** One autonomous-publish sweep — pulls due drafts/scheduled posts and publishes
 *  them to their real platform via Zernio. Exported standalone so it's directly
 *  testable without waiting on the interval. */
export async function runRalphAutoPublish(perTick = 1): Promise<{ published: number; failed: number }> {
  if (!hasZernio()) return { published: 0, failed: 0 }; // no Zernio key — nothing to publish to, stay quiet

  // Reels are now included — they publish as the rendered Ken-Burns video.
  const today = new Date().toISOString().split('T')[0];
  const due = getDb().prepare(`
    SELECT id, scheduled_for, channel, format FROM ralph_content
    WHERE status IN ('draft', 'scheduled')
      AND (scheduled_for IS NULL OR scheduled_for <= ?)
    ORDER BY (scheduled_for IS NULL), scheduled_for ASC, id ASC
  `).all(today) as DuePost[];
  const eligible = due.filter((p) => isZernioChannel(p.channel)).slice(0, Math.max(1, perTick));

  let published = 0, failed = 0;
  for (const post of eligible) {
    try {
      const r = await publishRalphPost(post.id);
      if (r.ok) {
        published++;
        console.log(`[Paulie] auto-published #${post.id} to ${post.channel}${r.url ? ' — ' + r.url : ''}`);
      } else {
        failed++;
        console.warn(`[Paulie] auto-publish #${post.id} failed: ${r.error}`);
      }
    } catch (err) {
      failed++;
      console.error(`[Paulie] auto-publish #${post.id} error:`, err);
    }
  }
  return { published, failed };
}

// Paulie auto-publish — posts drafted/scheduled content to its real Instagram/Facebook
// account with no human click. Same opt-out as generation (RALPH_AUTOGEN_ENABLED=0).
// Paced to one post per tick so the feed never gets flooded. Reels publish as the
// rendered Ken-Burns video (rendered on demand at publish if needed).
export function scheduleRalphPublish(): void {
  if (process.env.RALPH_AUTOGEN_ENABLED === '0') {
    console.log('[Paulie] Auto-publish disabled via RALPH_AUTOGEN_ENABLED=0. Manual publish still available.');
    return;
  }
  const perTick = Math.max(1, parseInt(process.env.RALPH_AUTOPUBLISH_PER_RUN || '1', 10));
  const run = () => {
    runRalphAutoPublish(perTick).catch((err) => console.error('[Paulie] auto-publish sweep error:', err));
  };
  setTimeout(run, 6 * 60 * 1000);
  setInterval(run, 4 * 60 * 60 * 1000);
  console.log('[Paulie] Auto-publish scheduled — every 4h, one post at a time, straight to Instagram/Facebook');
}

export function scheduleSeoLiveCheck(): void {
  const run = () => {
    checkAllLiveStatuses()
      .then((r) => { if (r.checked) console.log(`[SEO Agent] Live check — ${r.ok} ok, ${r.broken} broken of ${r.checked}`); })
      .catch((err) => console.error('[SEO Agent] Live check error:', err));
  };
  // First sweep 2 min after boot, then daily.
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, 24 * 60 * 60 * 1000);
  console.log('[SEO Agent] Live-URL checker — daily sweep of published pages');
}
