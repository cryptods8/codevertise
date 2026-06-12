#!/usr/bin/env node
/**
 * Online backup of the marketplace ledger (safe while the server runs — uses
 * SQLite's backup API over the same WAL database).
 *
 *   node scripts/backup.mjs [db-path] [out-dir]
 *   DB_PATH=/data/codevertise.db node scripts/backup.mjs
 *
 * Cron this and ship the output somewhere off-host: the DB is the record of
 * who is owed what.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dbPath = process.argv[2] ?? process.env.DB_PATH ?? "codevertise.db";
const outDir = process.argv[3] ?? process.env.BACKUP_DIR ?? "backups";

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = join(outDir, `codevertise-${stamp}.db`);

const db = new Database(dbPath, { readonly: true });
await db.backup(dest);
db.close();
console.log(`backed up ${dbPath} → ${dest}`);
