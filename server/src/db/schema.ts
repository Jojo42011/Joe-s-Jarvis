import Database from 'better-sqlite3';
import path from 'path';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): Database.Database {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'arlo.db');
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- === Aethon hull memory tables (wired in phase 2) ===

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      keywords TEXT,
      strength REAL DEFAULT 1.0,
      last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
      superseded_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary TEXT NOT NULL,
      key_decisions TEXT,
      emotional_tone TEXT,
      entities TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      properties TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relationship TEXT NOT NULL,
      strength REAL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_id) REFERENCES nodes(id),
      FOREIGN KEY (target_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      last_reinforced DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS syntheses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      period_start DATETIME,
      period_end DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS identity_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dimension TEXT NOT NULL,
      question TEXT NOT NULL,
      asked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      answer TEXT,
      answered_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_facts_strength ON facts(strength);
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_rules_confidence ON rules(confidence);
    CREATE INDEX IF NOT EXISTS idx_identity_dimension ON identity_questions(dimension);

    -- === SEO Agent tables ===

    CREATE TABLE IF NOT EXISTS seo_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      our_ranking TEXT DEFAULT 'unknown',
      competitor TEXT,
      competitor_ranking TEXT,
      monthly_volume TEXT,
      opportunity_score REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seo_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      target_keyword TEXT,
      file_path TEXT,
      status TEXT DEFAULT 'draft',
      committed INTEGER DEFAULT 0,
      committed_at DATETIME,
      scheduled_for TEXT,
      plan_task_id INTEGER,
      approved_at DATETIME,
      denied_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seo_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      phase TEXT,
      keywords_found INTEGER DEFAULT 0,
      content_generated INTEGER DEFAULT 0,
      commits_made INTEGER DEFAULT 0,
      summary TEXT,
      weekly_plan TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS seo_weekly_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start DATE NOT NULL,
      day TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_seo_keywords_score ON seo_keywords(opportunity_score);
    CREATE INDEX IF NOT EXISTS idx_seo_content_status ON seo_content(status);
    CREATE INDEX IF NOT EXISTS idx_seo_runs_started ON seo_runs(started_at);

    CREATE TABLE IF NOT EXISTS seo_competitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seo_keyword_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start DATE NOT NULL,
      keyword TEXT NOT NULL,
      our_ranking TEXT,
      competitor TEXT,
      competitor_ranking TEXT,
      monthly_volume TEXT,
      opportunity_score REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_seo_kw_hist_week ON seo_keyword_history(week_start);
    CREATE INDEX IF NOT EXISTS idx_seo_kw_hist_keyword ON seo_keyword_history(keyword);

    -- AI-generated page images: held on the server for preview, committed to the
    -- website repo on publish. data column is base64 PNG (cleared once committed).
    CREATE TABLE IF NOT EXISTS seo_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER,
      idx INTEGER,
      repo_path TEXT NOT NULL,
      prompt TEXT,
      data TEXT,
      committed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_seo_images_content ON seo_images(content_id);

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      address TEXT,
      project_type TEXT,
      budget TEXT,
      timeline TEXT,
      called INTEGER DEFAULT 0,
      booked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- === Google (Gmail + Calendar) hands ===

    -- One row per authorized mailbox. Tokens stored here (refresh_token is the
    -- durable one; access_token/expiry are refreshed automatically).
    CREATE TABLE IF NOT EXISTS google_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      label TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry INTEGER,
      scopes TEXT,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Triaged inbox items: Arlo's read of each message + any drafted reply.
    CREATE TABLE IF NOT EXISTS email_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_email TEXT NOT NULL,
      gmail_id TEXT NOT NULL,
      thread_id TEXT,
      from_addr TEXT,
      to_addr TEXT,
      subject TEXT,
      snippet TEXT,
      received_at DATETIME,
      is_unread INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 3,          -- 1 = urgent … 5 = noise
      category TEXT,                       -- lead | client | vendor | permit | admin | spam | other
      needs_reply INTEGER DEFAULT 0,
      flagged INTEGER DEFAULT 0,
      summary TEXT,
      draft_reply TEXT,
      draft_status TEXT DEFAULT 'none',    -- none | pending | approved | sent | dismissed
      triaged INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_email, gmail_id)
    );

    -- Lightweight cache of upcoming calendar events across accounts.
    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_email TEXT NOT NULL,
      event_id TEXT NOT NULL,
      summary TEXT,
      description TEXT,
      location TEXT,
      start_time TEXT,
      end_time TEXT,
      attendees TEXT,
      status TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_email, event_id)
    );

    -- === Paulie (content manager) ===
    CREATE TABLE IF NOT EXISTS ralph_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      channel TEXT DEFAULT 'blog',      -- blog | instagram | facebook | linkedin | gbp | email
      body TEXT,
      status TEXT DEFAULT 'idea',       -- idea | draft | scheduled | published | archived
      tags TEXT,
      scheduled_for TEXT,
      published_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ralph_status ON ralph_content(status);
    CREATE INDEX IF NOT EXISTS idx_ralph_channel ON ralph_content(channel);

    -- Rendered reel videos (one per reel content row). data is base64 MP4,
    -- encoded from the reel's frames so a reel actually plays as video.
    CREATE TABLE IF NOT EXISTS ralph_videos (
      content_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- === Google Search Console cache (REAL ranking data for Lauren) ===
    CREATE TABLE IF NOT EXISTS gsc_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      page TEXT,
      clicks REAL DEFAULT 0,
      impressions REAL DEFAULT 0,
      ctr REAL DEFAULT 0,
      position REAL,
      fetched_for DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(query, fetched_for)
    );
    CREATE INDEX IF NOT EXISTS idx_gsc_query ON gsc_metrics(query);
    CREATE INDEX IF NOT EXISTS idx_gsc_fetched ON gsc_metrics(fetched_for);

    CREATE INDEX IF NOT EXISTS idx_email_items_account ON email_items(account_email);
    CREATE INDEX IF NOT EXISTS idx_email_items_flag ON email_items(flagged, priority);
    CREATE INDEX IF NOT EXISTS idx_email_items_draft ON email_items(draft_status);
    CREATE INDEX IF NOT EXISTS idx_cal_events_account ON calendar_events(account_email);
    CREATE INDEX IF NOT EXISTS idx_cal_events_start ON calendar_events(start_time);

    -- === CRM: per-lead activity timeline + payments ===

    -- Every touch on a lead: outbound sms/email, notes, calls, stage changes.
    CREATE TABLE IF NOT EXISTS lead_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      type TEXT NOT NULL,                  -- sms | email | note | call | stage | payment
      direction TEXT DEFAULT 'out',        -- out | in | system
      subject TEXT,
      body TEXT,
      meta TEXT,                           -- JSON blob (message id, from account, etc.)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, created_at);

    -- Money on a lead: deposits, progress payments, final payments.
    CREATE TABLE IF NOT EXISTS lead_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      label TEXT,                          -- "Deposit", "Gunite draw", "Final"
      amount_cents INTEGER NOT NULL DEFAULT 0,
      method TEXT,                         -- cash | check | card | financing | other
      status TEXT DEFAULT 'paid',          -- paid | pending
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_payments_lead ON lead_payments(lead_id);

    -- === CRM v3: Arthur's Blueprint — files vault, subcontractors, estimator ===

    -- Per-project "Digital Project Vault": inspiration photos, permits,
    -- contracts, design renders, field photos. data is base64 (same pattern
    -- as seo_images) so files live on the one durable volume.
    CREATE TABLE IF NOT EXISTS lead_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      kind TEXT DEFAULT 'field',           -- inspiration | design | contract | permit | field
      name TEXT,
      mime TEXT,
      data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_files_lead ON lead_files(lead_id);

    -- Subcontractor address book, categorized by trade.
    CREATE TABLE IF NOT EXISTS subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trade TEXT,                          -- excavation | hardscape | landscaping | irrigation | lighting | masonry | planting | snow_removal | other
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- A sub assigned to a build stage on a project, with schedule-confirmation state.
    CREATE TABLE IF NOT EXISTS lead_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      sub_id INTEGER NOT NULL,
      stage TEXT,
      scheduled_for TEXT,
      status TEXT DEFAULT 'assigned',      -- assigned | notified | confirmed
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      FOREIGN KEY (sub_id) REFERENCES subs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_subs_lead ON lead_subs(lead_id);

    -- JobTread-style line-item estimator rows. Totals roll up to the project
    -- value, which in turn generates the 10/25/30/30/5 milestone schedule.
    CREATE TABLE IF NOT EXISTS lead_estimate_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      qty REAL DEFAULT 1,
      unit TEXT,
      unit_cost_cents INTEGER DEFAULT 0,
      markup_pct REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_estimate_lead ON lead_estimate_items(lead_id);

    -- Full Vapi call history, synced on an interval (every call, every assistant,
    -- costs included) — the dashboard reads THIS, not Vapi directly, so counts
    -- and cost totals cover the whole lifetime instead of a capped live fetch.
    CREATE TABLE IF NOT EXISTS vapi_calls (
      id TEXT PRIMARY KEY,
      assistant_id TEXT,
      direction TEXT,                      -- inbound | outbound | unknown
      number TEXT,
      customer_name TEXT,
      duration_sec INTEGER DEFAULT 0,
      connected INTEGER DEFAULT 0,
      booked INTEGER DEFAULT 0,
      ended_reason TEXT,
      cost REAL DEFAULT 0,
      cost_breakdown TEXT,                 -- JSON {stt, llm, tts, vapi, transport}
      started_at TEXT,
      created_at TEXT,
      recording_url TEXT,
      transcript TEXT,
      messages TEXT,                       -- JSON [{role, text}]
      summary TEXT,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vapi_calls_created ON vapi_calls(created_at);

    -- Non-prospect calls Sofia fields: telemarketers, vendors, existing clients,
    -- misdials. Filed here instead of polluting the leads pipeline — nothing is
    -- deleted, and any row can be promoted to a real lead from the CRM.
    CREATE TABLE IF NOT EXISTS other_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      category TEXT DEFAULT 'other',       -- client | vendor | spam | other
      message TEXT,
      original_lead_id INTEGER,            -- set when moved out of leads by cleanup
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_other_calls_created ON other_calls(created_at);

    -- === Auth: multi-user login with role-based access ===
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'owner',   -- owner | sales | pm
      password_hash TEXT NOT NULL,          -- scrypt: salt:hexhash
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
  `);

  migrateSeoContent(db);
  migrateLeads(db);
  migrateLeadPayments(db);
  migrateFacts(db);
  migrateRalph(db);

  return db;
}

function migrateRalph(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(ralph_content)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const add = (sql: string) => {
    try { database.exec(sql); } catch { /* column may exist */ }
  };
  // Layer 2: real publishing via Zernio — track the external post + its live URL.
  if (!names.has('external_post_id')) add('ALTER TABLE ralph_content ADD COLUMN external_post_id TEXT');
  if (!names.has('external_url')) add('ALTER TABLE ralph_content ADD COLUMN external_url TEXT');
  if (!names.has('publish_error')) add('ALTER TABLE ralph_content ADD COLUMN publish_error TEXT');
  // Layer 3: content format (single | carousel | reel | before_after) so the UI can
  // badge it and the publisher knows how to handle it (reels are shoot-ready scripts).
  if (!names.has('format')) add("ALTER TABLE ralph_content ADD COLUMN format TEXT DEFAULT 'single'");
  // Layer 4: an alternate caption (a second angle) Arthur can swap to at approval.
  if (!names.has('alt_body')) add('ALTER TABLE ralph_content ADD COLUMN alt_body TEXT');
}

function migrateFacts(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(facts)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const add = (sql: string) => {
    try { database.exec(sql); } catch { /* column may exist */ }
  };
  // Aethon memory upgrades: LLM-assigned salience + semantic vector.
  if (!names.has('importance')) add('ALTER TABLE facts ADD COLUMN importance REAL DEFAULT 5.0');
  if (!names.has('embedding')) add('ALTER TABLE facts ADD COLUMN embedding BLOB');
}

function migrateLeads(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(leads)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const add = (sql: string) => {
    try { database.exec(sql); } catch { /* column may exist */ }
  };
  if (!names.has('source')) add('ALTER TABLE leads ADD COLUMN source TEXT');
  if (!names.has('message')) add('ALTER TABLE leads ADD COLUMN message TEXT');
  // CRM layer: pipeline stage + free-form notes. Existing called/booked flags stay
  // (Sofia's flow writes them); pipeline is the richer stage on top.
  if (!names.has('pipeline')) add("ALTER TABLE leads ADD COLUMN pipeline TEXT DEFAULT 'new'");
  if (!names.has('notes')) add('ALTER TABLE leads ADD COLUMN notes TEXT');
  // Automated confirmation + follow-up sequence tracking (GHL-style intake automation).
  if (!names.has('confirmation_sent_at')) add('ALTER TABLE leads ADD COLUMN confirmation_sent_at DATETIME');
  if (!names.has('follow_up_count')) add('ALTER TABLE leads ADD COLUMN follow_up_count INTEGER DEFAULT 0');
  if (!names.has('last_follow_up_at')) add('ALTER TABLE leads ADD COLUMN last_follow_up_at DATETIME');
  // CRM v3 — project blueprint: tier, scope, build stages, permits,
  // inspections, project value, referral attribution, design status.
  if (!names.has('tier')) add('ALTER TABLE leads ADD COLUMN tier TEXT');                    // standard | luxury
  if (!names.has('scope')) add('ALTER TABLE leads ADD COLUMN scope TEXT');                  // JSON: {lawn_care,landscape,hardscape,excavation,water_features,structures,snow} — read defensively; unknown/legacy keys (e.g. old {pool,...}) are ignored
  if (!names.has('jurisdiction')) add('ALTER TABLE leads ADD COLUMN jurisdiction TEXT');    // Millersburg | Holmes County | ...
  if (!names.has('permit_status')) add("ALTER TABLE leads ADD COLUMN permit_status TEXT DEFAULT 'none'"); // none | draft | submitted | approved
  if (!names.has('build_stage')) add('ALTER TABLE leads ADD COLUMN build_stage TEXT');      // construction pipeline (null until contract)
  if (!names.has('project_value_cents')) add('ALTER TABLE leads ADD COLUMN project_value_cents INTEGER');
  if (!names.has('referred_by')) add('ALTER TABLE leads ADD COLUMN referred_by TEXT');      // who sent them (source=referral)
  if (!names.has('inspections')) add('ALTER TABLE leads ADD COLUMN inspections TEXT');      // JSON: [{key,label,done,date}]
  if (!names.has('design_status')) add("ALTER TABLE leads ADD COLUMN design_status TEXT DEFAULT 'none'"); // none | agreement_sent | paid | delivered
  // Map view: geocoded coordinates for the property address (cached; re-geocoded
  // when the address changes — geocoded_addr records what lat/lng was computed from).
  if (!names.has('lat')) add('ALTER TABLE leads ADD COLUMN lat REAL');
  if (!names.has('lng')) add('ALTER TABLE leads ADD COLUMN lng REAL');
  if (!names.has('geocoded_addr')) add('ALTER TABLE leads ADD COLUMN geocoded_addr TEXT');
}

function migrateLeadPayments(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(lead_payments)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const add = (sql: string) => {
    try { database.exec(sql); } catch { /* column may exist */ }
  };
  // Stripe Checkout payment links: track the session so the webhook can mark it paid.
  if (!names.has('stripe_session_id')) add('ALTER TABLE lead_payments ADD COLUMN stripe_session_id TEXT');
  if (!names.has('payment_url')) add('ALTER TABLE lead_payments ADD COLUMN payment_url TEXT');
}

function migrateSeoContent(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(seo_content)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const add = (sql: string) => {
    try { database.exec(sql); } catch { /* column may exist */ }
  };
  if (!names.has('scheduled_for')) add('ALTER TABLE seo_content ADD COLUMN scheduled_for TEXT');
  if (!names.has('plan_task_id')) add('ALTER TABLE seo_content ADD COLUMN plan_task_id INTEGER');
  if (!names.has('approved_at')) add('ALTER TABLE seo_content ADD COLUMN approved_at DATETIME');
  if (!names.has('denied_at')) add('ALTER TABLE seo_content ADD COLUMN denied_at DATETIME');
  if (!names.has('nav_group')) add("ALTER TABLE seo_content ADD COLUMN nav_group TEXT");
  if (!names.has('nav_label')) add('ALTER TABLE seo_content ADD COLUMN nav_label TEXT');
  if (!names.has('nav_linked')) add('ALTER TABLE seo_content ADD COLUMN nav_linked INTEGER DEFAULT 0');
  // ── Atlas SEO intelligence + measurement columns ──
  if (!names.has('seo_score')) add('ALTER TABLE seo_content ADD COLUMN seo_score INTEGER');
  if (!names.has('seo_grade')) add('ALTER TABLE seo_content ADD COLUMN seo_grade TEXT');
  if (!names.has('seo_report')) add('ALTER TABLE seo_content ADD COLUMN seo_report TEXT');
  if (!names.has('meta_title')) add('ALTER TABLE seo_content ADD COLUMN meta_title TEXT');
  if (!names.has('meta_description')) add('ALTER TABLE seo_content ADD COLUMN meta_description TEXT');
  if (!names.has('schema_types')) add('ALTER TABLE seo_content ADD COLUMN schema_types TEXT');
  if (!names.has('word_count')) add('ALTER TABLE seo_content ADD COLUMN word_count INTEGER');
  if (!names.has('internal_links_out')) add('ALTER TABLE seo_content ADD COLUMN internal_links_out INTEGER');
  if (!names.has('eeat_score')) add('ALTER TABLE seo_content ADD COLUMN eeat_score INTEGER');
  if (!names.has('github_sha')) add('ALTER TABLE seo_content ADD COLUMN github_sha TEXT');
  if (!names.has('live_status')) add('ALTER TABLE seo_content ADD COLUMN live_status TEXT');
  if (!names.has('live_checked_at')) add('ALTER TABLE seo_content ADD COLUMN live_checked_at DATETIME');
  // Real Google index status via the Search Console URL Inspection API.
  if (!names.has('index_status')) add('ALTER TABLE seo_content ADD COLUMN index_status TEXT');
  if (!names.has('index_checked_at')) add('ALTER TABLE seo_content ADD COLUMN index_checked_at DATETIME');
  // Location pages move from the old "Service Areas" (which nested under Blog) to a
  // proper top-level "Locations" section. Idempotent — only touches old rows.
  add("UPDATE seo_content SET nav_group = 'Locations' WHERE nav_group = 'Service Areas'");
}
