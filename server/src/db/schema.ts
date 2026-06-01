import Database from "better-sqlite3";

function columnExists(db: Database.Database, table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function tableExists(db: Database.Database, table: string) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

function applyMigrations(db: Database.Database) {
  if (tableExists(db, "conversations") && !columnExists(db, "conversations", "session_id")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'`);
  }

  if (tableExists(db, "conversation_state") && !columnExists(db, "conversation_state", "operator_context")) {
    db.exec(`ALTER TABLE conversation_state ADD COLUMN operator_context TEXT`);
  }

  if (tableExists(db, "conversations") && columnExists(db, "conversations", "session_id")) {
    db.exec(`CREATE INDEX IF NOT EXISTS conversations_session_id ON conversations(session_id, id)`);
  }

  if (tableExists(db, "jarvis_memory") && !columnExists(db, "jarvis_memory", "flagged")) {
    db.exec(`ALTER TABLE jarvis_memory ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`);
  }
  if (tableExists(db, "jarvis_memory") && !columnExists(db, "jarvis_memory", "flag_reason")) {
    db.exec(`ALTER TABLE jarvis_memory ADD COLUMN flag_reason TEXT`);
  }
  if (tableExists(db, "jarvis_memory") && !columnExists(db, "jarvis_memory", "retrieval_count")) {
    db.exec(`ALTER TABLE jarvis_memory ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (tableExists(db, "jarvis_memory") && !columnExists(db, "jarvis_memory", "last_retrieved_at")) {
    db.exec(`ALTER TABLE jarvis_memory ADD COLUMN last_retrieved_at DATETIME`);
  }
  if (tableExists(db, "jarvis_memory") && !columnExists(db, "jarvis_memory", "source")) {
    db.exec(`ALTER TABLE jarvis_memory ADD COLUMN source TEXT`);
  }

  if (!tableExists(db, "entity_profiles")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        relationship_summary TEXT,
        last_interaction DATETIME,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        trust_level TEXT DEFAULT 'unknown',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS entity_profiles_name ON entity_profiles(name);
    `);
  }

  if (!tableExists(db, "episodic_memory")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS episodic_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_decisions TEXT,
        people_mentioned TEXT,
        topics TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS episodic_memory_session ON episodic_memory(session_id);
      CREATE INDEX IF NOT EXISTS episodic_memory_created ON episodic_memory(created_at);
    `);
  }

  if (!tableExists(db, "self_evolution_log")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS self_evolution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation TEXT NOT NULL,
        suggested_improvement TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      );
    `);
  }

  if (tableExists(db, "documents") && !columnExists(db, "documents", "mime_type")) {
    db.exec(`ALTER TABLE documents ADD COLUMN mime_type TEXT`);
  }

  if (!tableExists(db, "appointments")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_name TEXT,
        caller_phone TEXT,
        service_requested TEXT,
        preferred_date TEXT,
        notes TEXT,
        event_id TEXT,
        calendar_link TEXT,
        status TEXT DEFAULT 'scheduled',
        source TEXT DEFAULT 'vapi',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  if (!tableExists(db, "notes")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        ohio_time TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        source TEXT NOT NULL DEFAULT 'manual',
        category TEXT,
        linked_entities TEXT,
        promoted_to_memory INTEGER DEFAULT 0,
        seen_in_rundown INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS notes_created_at ON notes(created_at DESC);
    `);
  }

  if (tableExists(db, "notes") && !columnExists(db, "notes", "seen_in_rundown")) {
    db.exec(`ALTER TABLE notes ADD COLUMN seen_in_rundown INTEGER DEFAULT 0`);
  }

  if (!tableExists(db, "transcripts")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        date TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        raw_transcript TEXT NOT NULL,
        summary TEXT,
        action_items TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS transcripts_date ON transcripts(date);
      CREATE INDEX IF NOT EXISTS transcripts_created ON transcripts(created_at);
    `);
  }
}

export function applySchema(db: Database.Database) {
  db.exec(`PRAGMA journal_mode = WAL`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  applyMigrations(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      priority_level TEXT NOT NULL DEFAULT 'normal',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS communication_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('call', 'sms', 'email', 'tasker', 'web')),
      sender TEXT,
      content TEXT,
      category TEXT NOT NULL DEFAULT 'unknown',
      summary TEXT,
      action_required INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS triage_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      action TEXT NOT NULL,
      priority_level TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_state (
      session_id TEXT PRIMARY KEY,
      active_panel TEXT,
      active_items TEXT,
      selected_item TEXT,
      pending_action TEXT,
      draft TEXT,
      last_intent TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_number TEXT,
      caller_name TEXT,
      call_reason TEXT,
      transcript TEXT,
      outcome TEXT,
      duration_seconds INTEGER,
      priority_level TEXT,
      forwarded_to TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS priority_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone_number TEXT,
      relationship TEXT,
      always_forward BOOLEAN DEFAULT TRUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS priority_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      source_id TEXT,
      summary TEXT,
      action_needed TEXT,
      urgency TEXT,
      handled INTEGER NOT NULL DEFAULT 0,
      raw_data TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Briefing keys (rows, not columns): last_briefing_delivered (ISO), last_briefing_summary (text/JSON)

    CREATE TABLE IF NOT EXISTS jarvis_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      flagged INTEGER NOT NULL DEFAULT 0,
      flag_reason TEXT,
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      last_retrieved_at DATETIME,
      source TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS jarvis_memory_category_key
      ON jarvis_memory(category, key);

    CREATE TABLE IF NOT EXISTS execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      action TEXT,
      item_id TEXT,
      summary TEXT,
      result TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS texts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_number TEXT,
      from_name TEXT,
      body TEXT,
      direction TEXT NOT NULL DEFAULT 'inbound',
      handled INTEGER NOT NULL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS world_intel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      results_json TEXT,
      summary TEXT,
      relevance TEXT,
      briefed INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS world_intel_fetched_at ON world_intel(fetched_at);
    CREATE INDEX IF NOT EXISTS world_intel_relevance_briefed ON world_intel(relevance, briefed);

    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      document_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      original_filename TEXT,
      mime_type TEXT,
      content_raw TEXT,
      status TEXT NOT NULL DEFAULT 'processing',
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      char_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'upload'
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS documents_notebook_uploaded ON documents(notebook_id, uploaded_at);
    CREATE INDEX IF NOT EXISTS document_chunks_document ON document_chunks(document_id, chunk_index);

    CREATE TABLE IF NOT EXISTS memory_audit_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL CHECK(action IN ('delete', 'merge', 'flag')),
      category TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      merge_with_key TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS memory_audit_queue_status ON memory_audit_queue(status, created_at);

    CREATE TABLE IF NOT EXISTS entity_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      relationship_summary TEXT,
      last_interaction DATETIME,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT DEFAULT 'unknown',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS entity_profiles_name ON entity_profiles(name);

    CREATE TABLE IF NOT EXISTS episodic_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_decisions TEXT,
      people_mentioned TEXT,
      topics TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS episodic_memory_session ON episodic_memory(session_id);
    CREATE INDEX IF NOT EXISTS episodic_memory_created ON episodic_memory(created_at);

    CREATE TABLE IF NOT EXISTS self_evolution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation TEXT NOT NULL,
      suggested_improvement TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_name TEXT,
      caller_phone TEXT,
      service_requested TEXT,
      preferred_date TEXT,
      notes TEXT,
      event_id TEXT,
      calendar_link TEXT,
      status TEXT DEFAULT 'scheduled',
      source TEXT DEFAULT 'vapi',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.prepare(
    `
    INSERT OR IGNORE INTO notebooks (id, title, description, created_at, document_count)
    VALUES ('default', 'Totally Outdoors', 'Joe Stewart business documents', datetime('now'), 0)
  `
  ).run();

  applyMigrations(db);
}
