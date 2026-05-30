$ErrorActionPreference = "Stop"
$app = "joes-jarvis"
$machine = "148ee26ef37d98"

$nodeScript = @'
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
  deleted[table] = db.prepare("DELETE FROM " + table).run().changes;
}
db.close();
console.log(JSON.stringify({ ok: true, dbPath, deleted }));
'@

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeScript))
$remote = "sh -c 'cd /app && echo $b64 | base64 -d | DB_PATH=/data/jarvis.sqlite node'"

Write-Host "Wiping prod SQLite on $app (no restart)..."
& fly machine exec $machine -a $app $remote
