import pg from "pg";
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
  /** Unspent budget returned to the advertiser via refund payouts. */
  refunded_micro: number;
  /** cancelled is terminal: the campaign never serves or accepts funds again. */
  status: "active" | "paused" | "cancelled";
  created_at: number;
  /**
   * When the campaign was admitted into the serving pool, or null if it never
   * has been. Admission is gated on the auction: a campaign starts serving only
   * once it is funded AND its bid outbids the current top serving campaign (an
   * empty pool admits the first funded bid). Once set it persists through being
   * outbid and through pause/resume — only running out of budget clears it, so
   * a re-funded campaign must outbid the leader again to re-enter. status alone
   * no longer means "serving"; this column is the gate.
   */
  activated_at: number | null;
  /** sha256 of the campaign's manage key (issued once at creation); null for
   *  house/legacy campaigns, which then cannot be managed over HTTP at all. */
  manage_key_hash: string | null;
  /** Lowercase wallet of the SIWE-signed-in creator; null for campaigns
   *  created over the bare API (agents) — those manage via key only. */
  owner_wallet: string | null;
}

/** An advertiser account, keyed by the SIWE-verified wallet (lowercase). */
export interface Advertiser {
  wallet: string;
  /** Public board name, applied to the account's campaigns. */
  label: string | null;
  created_at: number;
  /** When account settings were last saved; null until the forced first-run
   *  settings pass completes. */
  settings_at: number | null;
  /** Version identifier of the Terms the advertiser accepted by signing the
   *  SIWE message (which references that version). Durable, per-wallet proof of
   *  agreement; null for accounts predating consent capture. */
  terms_version: string | null;
  /** When the most recent Terms acceptance was recorded. */
  terms_accepted_at: number | null;
}

export interface Session {
  /** sha256 of the bearer session token — the token itself is never stored. */
  token_hash: string;
  wallet: string;
  created_at: number;
  expires_at: number;
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
   * failed    — terminally failed; the debit was returned to its source
   *             (publisher balance for earnings, campaign escrow for refunds)
   */
  status: "queued" | "submitted" | "sent" | "failed";
  /** earnings — publisher withdrawal; refund — unspent escrow back to an advertiser. */
  kind: "earnings" | "refund";
  /** Set on refund payouts: the cancelled campaign the escrow came from. */
  campaign_id: string | null;
  tx: string | null;
  created_at: number;
}

/** A notice-and-action report against hosted advertiser content (DSA Art. 16):
 *  captured server-side so the operator has a durable, reviewable queue rather
 *  than depending on an email inbox being watched. */
export interface Report {
  id: string;
  /** The campaign complained of, when the reporter identified one. */
  campaign_id: string | null;
  /** Short category, e.g. "illegal" | "ip" | "fraud" | "malware" | "other". */
  reason: string;
  /** Free-text explanation / notice body. */
  details: string;
  /** Optional reporter contact (email or wallet) for follow-up. */
  reporter: string | null;
  /** open — awaiting review; actioned — content removed/restricted; dismissed. */
  status: "open" | "actioned" | "dismissed";
  created_at: number;
  resolved_at: number | null;
  /** Operator note recorded when the report was resolved. */
  resolution: string | null;
}

// node-postgres returns BIGINT (int8, OID 20) as a string to avoid precision
// loss past 2^53. Every BIGINT in this schema is a micro-USD amount or a
// millisecond timestamp, all comfortably under 2^53, so parse them back to
// JS numbers globally — the rest of the codebase treats them as numbers.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/** A query executor — the pool itself, or a single client inside a transaction. */
export interface Queryer {
  all<T>(text: string, params?: unknown[]): Promise<T[]>;
  get<T>(text: string, params?: unknown[]): Promise<T | undefined>;
  run(text: string, params?: unknown[]): Promise<number>;
}

function executor(q: pg.Pool | pg.PoolClient): Queryer {
  return {
    async all<T>(text: string, params?: unknown[]): Promise<T[]> {
      return (await q.query(text, params as never)).rows as T[];
    },
    async get<T>(text: string, params?: unknown[]): Promise<T | undefined> {
      return (await q.query(text, params as never)).rows[0] as T | undefined;
    },
    async run(text: string, params?: unknown[]): Promise<number> {
      return (await q.query(text, params as never)).rowCount ?? 0;
    },
  };
}

/**
 * The application's Postgres handle. Wraps a `pg.Pool` with the small async
 * query surface (`get`/`all`/`run`) the marketplace uses, plus `tx()` for
 * statements that must commit atomically (funding, event billing, payouts).
 */
export class Db {
  private exec: Queryer;
  constructor(private pool: pg.Pool) {
    this.exec = executor(pool);
  }

  all<T>(text: string, params?: unknown[]): Promise<T[]> {
    return this.exec.all<T>(text, params);
  }
  get<T>(text: string, params?: unknown[]): Promise<T | undefined> {
    return this.exec.get<T>(text, params);
  }
  run(text: string, params?: unknown[]): Promise<number> {
    return this.exec.run(text, params);
  }

  /** Run `fn` inside a single transaction; commits on success, rolls back on throw. */
  async tx<T>(fn: (t: Queryer) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(executor(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* connection already broken — release it below regardless */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    advertiser TEXT NOT NULL,
    label TEXT,
    message TEXT NOT NULL,
    url TEXT NOT NULL,
    bid_per_block_micro BIGINT NOT NULL,
    budget_micro BIGINT NOT NULL DEFAULT 0,
    spent_micro BIGINT NOT NULL DEFAULT 0,
    refunded_micro BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    manage_key_hash TEXT,
    owner_wallet TEXT,
    activated_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS advertisers (
    wallet TEXT PRIMARY KEY,
    label TEXT,
    created_at BIGINT NOT NULL,
    settings_at BIGINT,
    terms_version TEXT,
    terms_accepted_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    publisher TEXT NOT NULL,
    surface TEXT NOT NULL,
    amount_micro BIGINT NOT NULL,
    publisher_micro BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    payer TEXT NOT NULL,
    amount_micro BIGINT NOT NULL,
    rail TEXT NOT NULL,
    tx TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS publishers (
    wallet TEXT PRIMARY KEY,
    earned_micro BIGINT NOT NULL DEFAULT 0,
    paid_micro BIGINT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    amount_micro BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    kind TEXT NOT NULL DEFAULT 'earnings',
    campaign_id TEXT,
    tx TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    reason TEXT NOT NULL,
    details TEXT NOT NULL,
    reporter TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at BIGINT NOT NULL,
    resolved_at BIGINT,
    resolution TEXT
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_auction
    ON campaigns(status, bid_per_block_micro DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_campaigns_owner ON campaigns(owner_wallet);
  CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_events_publisher ON events(publisher);
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
`;

/**
 * Open the marketplace database.
 *
 * With a connection string (DATABASE_URL in production) this connects to a real
 * PostgreSQL server — the primary datastore. Without one, it spins up an
 * in-process `pg-mem` instance that speaks the same wire surface, so tests and
 * zero-config local dev run the identical SQL against an ephemeral Postgres.
 */
export async function openDb(connectionString?: string): Promise<Db> {
  let pool: pg.Pool;
  if (connectionString) {
    pool = new pg.Pool({ connectionString });
  } else {
    // pg-mem is a dev/test dependency; load it lazily so production images that
    // always set DATABASE_URL don't need it installed.
    const { newDb } = await import("pg-mem");
    const mem = newDb();
    const adapter = mem.adapters.createPg();
    pool = new adapter.Pool();
  }
  const db = new Db(pool);
  await pool.query(SCHEMA);
  return db;
}

/**
 * The HMAC key for serve tokens. Prefers the operator-supplied secret; falls
 * back to a random key persisted in the DB so tokens survive a restart (and a
 * fresh in-memory DB just gets an ephemeral one). Returned as raw bytes.
 */
export async function getOrCreateSigningSecret(db: Db, configured?: string): Promise<Buffer> {
  if (configured && configured.length > 0) return Buffer.from(configured, "utf8");
  const row = await db.get<{ value: string }>(
    `SELECT value FROM meta WHERE key = 'event_signing_secret'`,
  );
  if (row) return Buffer.from(row.value, "hex");
  const secret = randomBytes(32);
  // ON CONFLICT guards the race where two boots seed at once; re-read after.
  await db.run(
    `INSERT INTO meta (key, value) VALUES ('event_signing_secret', $1)
     ON CONFLICT (key) DO NOTHING`,
    [secret.toString("hex")],
  );
  const stored = await db.get<{ value: string }>(
    `SELECT value FROM meta WHERE key = 'event_signing_secret'`,
  );
  return Buffer.from(stored!.value, "hex");
}
