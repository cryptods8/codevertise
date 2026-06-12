import Database from "better-sqlite3";

export interface Campaign {
  id: string;
  advertiser: string; // wallet address (or "house")
  message: string;
  url: string;
  bid_per_block_micro: number;
  budget_micro: number;
  spent_micro: number;
  status: "active" | "paused";
  created_at: number;
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
  status: "queued" | "sent" | "failed";
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
      message TEXT NOT NULL,
      url TEXT NOT NULL,
      bid_per_block_micro INTEGER NOT NULL,
      budget_micro INTEGER NOT NULL DEFAULT 0,
      spent_micro INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_campaigns_auction
      ON campaigns(status, bid_per_block_micro DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_events_publisher ON events(publisher);
  `);
  return db;
}
