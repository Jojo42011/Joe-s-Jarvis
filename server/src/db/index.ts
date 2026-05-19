import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { applySchema } from "./schema";

const dbPath = process.env.DB_PATH || "./data/jarvis.sqlite";
const resolvedPath = path.resolve(process.cwd(), dbPath);
const dbDir = path.dirname(resolvedPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(resolvedPath);

applySchema(db);
