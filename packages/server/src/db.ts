import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export interface Campaign {
  id: string;
  advertiser: string; // wallet address (or "house") — never exposed on public surfaces
  label: string | null; // advertiser-chosen public name shown on the auction board
  message: string;
  url: string;
  bid_per_block_micro: number;
  budget_micro: number;
  spent_micro: number;
  status: "active" | "paused";
  created_at: number;
  /** sha256 of the campaign's manage key (issued once at creation); null for
   *  house/legacy campaigns, which then cannot be managed over HTTP at all. */
  manage_key_hash: string | null;
}

export interface AdEvent {
  key: string;
  type: "impression" | "click";
  campaign_id: string;
  publisher: string;
  surface: string;
  amount_micro: number;
  publisher_micro: number;
  created_at: number;
}

export interface Payment {
  id: string;
  campaign_id: string;
  payer: string;
  amount_micro: number;
  rail: string; // "x402" | "mock" | "mpp"
  tx: string | null;
  created_at: number;
}

export interface Publisher {
  wallet: string;
  earned_micro: number;
  paid_micro: number;
}

export interface Payout {
  id: string;
  wallet: string;
  amount_micro: number;
  /**
   * queued    — ledger debited, no transaction broadcast yet (safe to retry)
   * submitted — transaction broadcast, receipt unknown (NEVER auto-refund;
   *             reconcile against the chain before resolving)
   * sent      — receipt confirmed success
   * failed    — terminally failed; the debit was refunded to the publisher
   */
  status: "queued" | "submitted" | "sent" | "failed";
  tx: string | null;
  created_at: number;
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      advertiser TEXT NOT NULL,
      label TEXT,
      message TEXT NOT NULL,
      url TEXT NOT NULL,
      bid_per_block_micro INTEGER NOT NULL,
      budget_micro INTEGER NOT NULL DEFAULT 0,
      spent_micro INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      manage_key_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      publisher TEXT NOT NULL,
      surface TEXT NOT NULL,
      amount_micro INTEGER NOT NULL,
      publisher_micro INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      payer TEXT NOT NULL,
      amount_micro INTEGER NOT NULL,
      rail TEXT NOT NULL,
      tx TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publishers (
      wallet TEXT PRIMARY KEY,
      earned_micro INTEGER NOT NULL DEFAULT 0,
      paid_micro INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      amount_micro INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      tx TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_auction
      ON campaigns(status, bid_per_block_micro DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_events_publisher ON events(publisher);
  `);
  const campaignCols = db.prepare(`PRAGMA table_info(campaigns)`).all() as { name: string }[];
  if (!campaignCols.some((c) => c.name === "label")) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN label TEXT`);
  }
  if (!campaignCols.some((c) => c.name === "manage_key_hash")) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN manage_key_hash TEXT`);
  }
  return db;
}

/**
 * The HMAC key for serve tokens. Prefers the operator-supplied secret; falls
 * back to a random key persisted in the DB so tokens survive a restart (and a
 * fresh in-memory DB just gets an ephemeral one). Returned as raw bytes.
 */
export function getOrCreateSigningSecret(db: Database.Database, configured?: string): Buffer {
  if (configured && configured.length > 0) return Buffer.from(configured, "utf8");
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'event_signing_secret'`).get() as
    | { value: string }
    | undefined;
  if (row) return Buffer.from(row.value, "hex");
  const secret = randomBytes(32);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('event_signing_secret', ?)`).run(
    secret.toString("hex"),
  );
  return secret;
}
