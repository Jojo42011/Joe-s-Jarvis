#!/bin/sh
cd /app || exit 1
node <<'NODE'
const Database = require("better-sqlite3");
const dbPath = process.env.DB_PATH || "/data/jarvis.sqlite";
const tables = [
  "jarvis_memory",
  "conversations",
  "conversation_state",
  "execution_log",
  "priority_queue",
  "calls",
  "world_intel",
  "memory_audit_queue",
  "system_state"
];
const db = new Database(dbPath);
const deleted = {};
for (const table of tables) {
  deleted[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
}
db.close();
console.log(JSON.stringify({ ok: true, dbPath, deleted }));
NODE
