#!/usr/bin/env node
/**
 * Backup of the marketplace ledger. The ledger lives in PostgreSQL, so this is
 * a thin wrapper around `pg_dump` (consistent online snapshot) writing a
 * timestamped dump.
 *
 *   node scripts/backup.mjs [out-dir]
 *   DATABASE_URL=postgres://… node scripts/backup.mjs
 *
 * Cron this and ship the output somewhere off-host: the DB is the record of
 * who is owed what. Requires `pg_dump` on PATH (postgresql-client).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is required — there is nothing durable to back up without a PostgreSQL server " +
      "(an unset DATABASE_URL runs on an ephemeral in-process pg-mem instance).",
  );
  process.exit(1);
}

const outDir = process.argv[2] ?? process.env.BACKUP_DIR ?? "backups";
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = join(outDir, `codevertise-${stamp}.sql`);

const fd = openSync(dest, "w");
try {
  const res = spawnSync("pg_dump", ["--no-owner", "--no-privileges", url], {
    stdio: ["ignore", fd, "inherit"],
  });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      console.error("pg_dump not found on PATH — install the PostgreSQL client tools.");
      process.exit(1);
    }
    throw res.error;
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
} finally {
  closeSync(fd);
}
console.log(`backed up PostgreSQL ledger → ${dest}`);
