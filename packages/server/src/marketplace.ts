import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { Config } from "./config.js";
import type { AdEvent, Campaign, Payment, Payout, Publisher } from "./db.js";

/**
 * The Codevertise marketplace core: an English ascending auction over ad
 * "blocks" (1 block = `blockImpressions` five-second impressions), funded in
 * USDC and settled to an internal micro-USD ledger. Kickbacks.ai economics,
 * crypto rails.
 */
export class Marketplace {
  constructor(
    private db: Database.Database,
    private cfg: Config,
  ) {}

  // ---- campaigns & auction ----

  createCampaign(input: {
    advertiser: string;
    message: string;
    url: string;
    bidPerBlockMicro: number;
  }): Campaign {
    if (input.bidPerBlockMicro < this.cfg.minBidMicro) {
      throw new MarketError(
        `bid_per_block must be at least ${this.cfg.minBidMicro} micro-USD`,
        400,
      );
    }
    if (!input.message || input.message.length > 80) {
      throw new MarketError("message is required, max 80 chars (it's a status line)", 400);
    }
    const campaign: Campaign = {
      id: `cmp_${nanoid(12)}`,
      advertiser: input.advertiser,
      message: input.message,
      url: input.url,
      bid_per_block_micro: input.bidPerBlockMicro,
      budget_micro: 0,
      spent_micro: 0,
      status: "active",
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO campaigns (id, advertiser, message, url, bid_per_block_micro, budget_micro, spent_micro, status, created_at)
         VALUES (@id, @advertiser, @message, @url, @bid_per_block_micro, @budget_micro, @spent_micro, @status, @created_at)`,
      )
      .run(campaign);
    return campaign;
  }

  getCampaign(id: string): Campaign | undefined {
    return this.db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) as
      | Campaign
      | undefined;
  }

  /** English ascending auction: a raise must beat your own bid by the minimum increment. */
  raiseBid(id: string, newBidMicro: number): Campaign {
    const c = this.mustGetCampaign(id);
    if (newBidMicro < c.bid_per_block_micro + this.cfg.minBidIncrementMicro) {
      throw new MarketError(
        `new bid must be >= current bid + ${this.cfg.minBidIncrementMicro} micro-USD`,
        400,
      );
    }
    this.db
      .prepare(`UPDATE campaigns SET bid_per_block_micro = ? WHERE id = ?`)
      .run(newBidMicro, id);
    return this.mustGetCampaign(id);
  }

  /** Credit escrowed budget after a settled payment (x402 / mock / mpp). */
  fundCampaign(input: {
    campaignId: string;
    payer: string;
    amountMicro: number;
    rail: string;
    tx?: string;
  }): { campaign: Campaign; payment: Payment } {
    const c = this.mustGetCampaign(input.campaignId);
    if (input.amountMicro <= 0) throw new MarketError("amount must be positive", 400);
    const payment: Payment = {
      id: `pay_${nanoid(12)}`,
      campaign_id: c.id,
      payer: input.payer,
      amount_micro: input.amountMicro,
      rail: input.rail,
      tx: input.tx ?? null,
      created_at: Date.now(),
    };
    const insert = this.db.prepare(
      `INSERT INTO payments (id, campaign_id, payer, amount_micro, rail, tx, created_at)
       VALUES (@id, @campaign_id, @payer, @amount_micro, @rail, @tx, @created_at)`,
    );
    const credit = this.db.prepare(
      `UPDATE campaigns SET budget_micro = budget_micro + ? WHERE id = ?`,
    );
    this.db.transaction(() => {
      insert.run(payment);
      credit.run(input.amountMicro, c.id);
    })();
    return { campaign: this.mustGetCampaign(c.id), payment };
  }

  impressionCostMicro(c: Campaign): number {
    return Math.ceil(c.bid_per_block_micro / this.cfg.blockImpressions);
  }

  clickCostMicro(c: Campaign): number {
    return this.impressionCostMicro(c) * this.cfg.clickMultiplier;
  }

  remainingMicro(c: Campaign): number {
    return c.budget_micro - c.spent_micro;
  }

  /**
   * The serving winner: highest bid among active campaigns that can still
   * afford at least one impression; ties broken by age (earlier bid wins).
   */
  winner(): Campaign | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM campaigns
         WHERE status = 'active' AND budget_micro - spent_micro > 0
         ORDER BY bid_per_block_micro DESC, created_at ASC`,
      )
      .all() as Campaign[];
    return rows.find((c) => this.remainingMicro(c) >= this.impressionCostMicro(c));
  }

  /** Public auction board: ranked queue with remaining budget. */
  auctionState() {
    const rows = this.db
      .prepare(
        `SELECT * FROM campaigns WHERE status = 'active'
         ORDER BY bid_per_block_micro DESC, created_at ASC`,
      )
      .all() as Campaign[];
    const winner = this.winner();
    return rows.map((c, i) => ({
      rank: i + 1,
      campaignId: c.id,
      advertiser: c.advertiser,
      bidPerBlockMicro: c.bid_per_block_micro,
      remainingMicro: this.remainingMicro(c),
      serving: c.id === winner?.id,
    }));
  }

  // ---- events & earnings ----

  /**
   * Record an impression or click, idempotently keyed by the client-supplied
   * event key. Debits the campaign and credits the publisher their share.
   * Returns the event, or undefined when the key was already seen.
   */
  recordEvent(input: {
    key: string;
    type: "impression" | "click";
    campaignId: string;
    publisher: string;
    surface: string;
  }): AdEvent | undefined {
    const c = this.mustGetCampaign(input.campaignId);
    const fullCost =
      input.type === "impression" ? this.impressionCostMicro(c) : this.clickCostMicro(c);
    // A nearly-exhausted budget still pays out what's left rather than serving free.
    const cost = Math.min(fullCost, this.remainingMicro(c));
    if (cost <= 0) return undefined;
    const publisherMicro = Math.floor(cost * this.cfg.publisherShare);

    const event: AdEvent = {
      key: input.key,
      type: input.type,
      campaign_id: c.id,
      publisher: input.publisher,
      surface: input.surface,
      amount_micro: cost,
      publisher_micro: publisherMicro,
      created_at: Date.now(),
    };

    const insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO events (key, type, campaign_id, publisher, surface, amount_micro, publisher_micro, created_at)
       VALUES (@key, @type, @campaign_id, @publisher, @surface, @amount_micro, @publisher_micro, @created_at)`,
    );
    const debit = this.db.prepare(`UPDATE campaigns SET spent_micro = spent_micro + ? WHERE id = ?`);
    const credit = this.db.prepare(
      `INSERT INTO publishers (wallet, earned_micro, paid_micro) VALUES (?, ?, 0)
       ON CONFLICT(wallet) DO UPDATE SET earned_micro = earned_micro + excluded.earned_micro`,
    );

    let inserted = false;
    this.db.transaction(() => {
      const res = insertEvent.run(event);
      if (res.changes === 0) return; // duplicate key: no-op
      inserted = true;
      debit.run(cost, c.id);
      credit.run(input.publisher, publisherMicro);
    })();
    return inserted ? event : undefined;
  }

  getPublisher(wallet: string): Publisher {
    const row = this.db.prepare(`SELECT * FROM publishers WHERE wallet = ?`).get(wallet) as
      | Publisher
      | undefined;
    return row ?? { wallet, earned_micro: 0, paid_micro: 0 };
  }

  /** Withdrawable balance for a publisher. */
  balanceMicro(wallet: string): number {
    const p = this.getPublisher(wallet);
    return p.earned_micro - p.paid_micro;
  }

  /**
   * Create a payout for the full withdrawable balance. The caller is
   * responsible for actually moving USDC and then marking sent/failed.
   */
  requestPayout(wallet: string): Payout {
    const balance = this.balanceMicro(wallet);
    if (balance < this.cfg.minPayoutMicro) {
      throw new MarketError(
        `balance ${balance} micro-USD below payout threshold ${this.cfg.minPayoutMicro}`,
        400,
      );
    }
    const payout: Payout = {
      id: `out_${nanoid(12)}`,
      wallet,
      amount_micro: balance,
      status: "queued",
      tx: null,
      created_at: Date.now(),
    };
    const insert = this.db.prepare(
      `INSERT INTO payouts (id, wallet, amount_micro, status, tx, created_at)
       VALUES (@id, @wallet, @amount_micro, @status, @tx, @created_at)`,
    );
    const markPaid = this.db.prepare(
      `UPDATE publishers SET paid_micro = paid_micro + ? WHERE wallet = ?`,
    );
    this.db.transaction(() => {
      insert.run(payout);
      markPaid.run(balance, wallet);
    })();
    return payout;
  }

  resolvePayout(id: string, status: "sent" | "failed", tx?: string): void {
    const payout = this.db.prepare(`SELECT * FROM payouts WHERE id = ?`).get(id) as
      | Payout
      | undefined;
    if (!payout) throw new MarketError("payout not found", 404);
    const update = this.db.prepare(`UPDATE payouts SET status = ?, tx = ? WHERE id = ?`);
    const refund = this.db.prepare(
      `UPDATE publishers SET paid_micro = paid_micro - ? WHERE wallet = ?`,
    );
    this.db.transaction(() => {
      update.run(status, tx ?? null, id);
      // A failed send returns the balance to the publisher's withdrawable pool.
      if (status === "failed") refund.run(payout.amount_micro, payout.wallet);
    })();
  }

  listPayouts(wallet: string): Payout[] {
    return this.db
      .prepare(`SELECT * FROM payouts WHERE wallet = ? ORDER BY created_at DESC`)
      .all(wallet) as Payout[];
  }

  private mustGetCampaign(id: string): Campaign {
    const c = this.getCampaign(id);
    if (!c) throw new MarketError(`campaign ${id} not found`, 404);
    return c;
  }
}

export class MarketError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
