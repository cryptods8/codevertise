import type Database from "better-sqlite3";
import { createHash, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import type { Config } from "./config.js";
import { getOrCreateSigningSecret } from "./db.js";
import type { AdEvent, Campaign, Payment, Payout, Publisher } from "./db.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * The Codevertise marketplace core: an English ascending auction over ad
 * "blocks" (1 block = `blockImpressions` five-second impressions), funded in
 * USDC and settled to an internal micro-USD ledger.
 */
export class Marketplace {
  private secret?: Buffer;
  /** Per-campaign smooth-weighted-round-robin state for serve rotation. */
  private serveWeights = new Map<string, number>();

  constructor(
    readonly db: Database.Database,
    private cfg: Config,
  ) {}

  /** HMAC key for serve tokens (lazily resolved/persisted). */
  signingSecret(): Buffer {
    return (this.secret ??= getOrCreateSigningSecret(this.db, this.cfg.eventSigningSecret));
  }

  /** Whether an event with this idempotency key has already been recorded. */
  hasEvent(key: string): boolean {
    return this.db.prepare(`SELECT 1 FROM events WHERE key = ?`).get(key) !== undefined;
  }

  // ---- campaigns & auction ----

  createCampaign(input: {
    advertiser: string;
    label?: string | null;
    message: string;
    url: string;
    bidPerBlockMicro: number;
    /** Lowercase SIWE wallet of the signed-in creator, when there is one. */
    ownerWallet?: string | null;
  }): Campaign & { manageKey: string } {
    if (input.bidPerBlockMicro < this.cfg.minBidMicro) {
      throw new MarketError(
        `bid_per_block must be at least ${this.cfg.minBidMicro} micro-USD`,
        400,
      );
    }
    if (!input.message || input.message.length > 80) {
      throw new MarketError("message is required, max 80 chars (it's a status line)", 400);
    }
    const label = input.label?.trim() || null;
    if (label && label.length > 32) {
      throw new MarketError("label is max 32 chars (it's your public board name)", 400);
    }
    // The manage key is the campaign's only credential: shown once in the
    // create response, stored only as a hash. Losing it means losing raise/
    // pause control (funding stays open to anyone by design).
    const manageKey = `cvk_${nanoid(24)}`;
    const campaign: Campaign = {
      id: `cmp_${nanoid(12)}`,
      advertiser: input.advertiser,
      label,
      message: input.message,
      url: input.url,
      bid_per_block_micro: input.bidPerBlockMicro,
      budget_micro: 0,
      spent_micro: 0,
      refunded_micro: 0,
      status: "active",
      created_at: Date.now(),
      manage_key_hash: sha256Hex(manageKey),
      owner_wallet: input.ownerWallet ?? null,
      // Not serving yet: a campaign only joins the pool once it is funded and
      // outbids the current leader (see tryActivate, called on fund/raise).
      activated_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO campaigns (id, advertiser, label, message, url, bid_per_block_micro, budget_micro, spent_micro, refunded_micro, status, created_at, manage_key_hash, owner_wallet, activated_at)
         VALUES (@id, @advertiser, @label, @message, @url, @bid_per_block_micro, @budget_micro, @spent_micro, @refunded_micro, @status, @created_at, @manage_key_hash, @owner_wallet, @activated_at)`,
      )
      .run(campaign);
    return Object.assign(campaign, { manageKey });
  }

  /** Constant-time check of a manage key against the campaign's stored hash.
   *  Campaigns without a hash (house/legacy) are unmanageable over HTTP. */
  verifyManageKey(campaignId: string, key: string | undefined): boolean {
    const c = this.getCampaign(campaignId);
    if (!c?.manage_key_hash || !key) return false;
    const given = Buffer.from(sha256Hex(key), "hex");
    const want = Buffer.from(c.manage_key_hash, "hex");
    return given.length === want.length && timingSafeEqual(given, want);
  }

  setCampaignStatus(id: string, status: "active" | "paused"): Campaign {
    const c = this.mustGetCampaign(id);
    if (c.status === "cancelled") {
      throw new MarketError(`campaign ${id} is cancelled and cannot be ${status}`, 409);
    }
    this.db.prepare(`UPDATE campaigns SET status = ? WHERE id = ?`).run(status, id);
    return this.mustGetCampaign(id);
  }

  /**
   * Cancel a campaign: terminal — it leaves the auction board immediately and
   * can never serve, be resumed, or accept funding again. The unspent escrow
   * stays withdrawable via requestRefund.
   */
  cancelCampaign(id: string): Campaign {
    const c = this.mustGetCampaign(id);
    if (c.status === "cancelled") {
      throw new MarketError(`campaign ${id} is already cancelled`, 409);
    }
    this.db.prepare(`UPDATE campaigns SET status = 'cancelled' WHERE id = ?`).run(id);
    return this.mustGetCampaign(id);
  }

  getCampaign(id: string): Campaign | undefined {
    return this.db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) as
      | Campaign
      | undefined;
  }

  listCampaigns(advertiser?: string): Campaign[] {
    if (advertiser) {
      return this.db
        .prepare(`SELECT * FROM campaigns WHERE advertiser = ? ORDER BY created_at DESC`)
        .all(advertiser) as Campaign[];
    }
    return this.db
      .prepare(`SELECT * FROM campaigns ORDER BY created_at DESC`)
      .all() as Campaign[];
  }

  /** Every campaign a signed-in wallet created — the cross-browser "mine" list. */
  listCampaignsByOwner(ownerWallet: string): Campaign[] {
    return this.db
      .prepare(`SELECT * FROM campaigns WHERE owner_wallet = ? ORDER BY created_at DESC`)
      .all(ownerWallet) as Campaign[];
  }

  /** The board name is an account-level setting: saving it renames the
   *  account's campaigns too, so the public board stays coherent. */
  relabelOwnedCampaigns(ownerWallet: string, label: string | null): void {
    this.db
      .prepare(`UPDATE campaigns SET label = ? WHERE owner_wallet = ?`)
      .run(label, ownerWallet);
  }

  campaignStats(id: string) {
    const c = this.mustGetCampaign(id);
    const row = this.db
      .prepare(
        `SELECT
           COUNT(CASE WHEN type = 'impression' THEN 1 END) AS impressions,
           COUNT(CASE WHEN type = 'click' THEN 1 END) AS clicks,
           COUNT(DISTINCT publisher) AS publishers
         FROM events WHERE campaign_id = ?`,
      )
      .get(id) as { impressions: number; clicks: number; publishers: number };
    return {
      campaignId: c.id,
      impressions: row.impressions,
      clicks: row.clicks,
      publishers: row.publishers,
      spentMicro: c.spent_micro,
      budgetMicro: c.budget_micro,
      remainingMicro: this.remainingMicro(c),
      impressionCostMicro: this.impressionCostMicro(c),
      clickCostMicro: this.clickCostMicro(c),
    };
  }

  /** English ascending auction: a raise must beat your own bid by the minimum increment. */
  raiseBid(id: string, newBidMicro: number): Campaign {
    const c = this.mustGetCampaign(id);
    if (c.status === "cancelled") {
      throw new MarketError(`campaign ${id} is cancelled`, 409);
    }
    if (newBidMicro < c.bid_per_block_micro + this.cfg.minBidIncrementMicro) {
      throw new MarketError(
        `new bid must be >= current bid + ${this.cfg.minBidIncrementMicro} micro-USD`,
        400,
      );
    }
    this.db
      .prepare(`UPDATE campaigns SET bid_per_block_micro = ? WHERE id = ?`)
      .run(newBidMicro, id);
    // A funded-but-not-yet-serving campaign can raise its way past the leader
    // and into the pool. An already-serving one just keeps its place.
    this.tryActivate(this.mustGetCampaign(id));
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
    if (c.status === "cancelled") {
      throw new MarketError(`campaign ${c.id} is cancelled and no longer accepts funding`, 409);
    }
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
    // Funding is the moment a campaign can enter the auction: admit it if it now
    // outbids the leader (or the pool is empty). If it can't, it stays funded
    // but unserved until it raises past the top — being funded is not enough.
    this.tryActivate(this.mustGetCampaign(c.id));
    return { campaign: this.mustGetCampaign(c.id), payment };
  }

  impressionCostMicro(c: Campaign): number {
    return Math.ceil(c.bid_per_block_micro / this.cfg.blockImpressions);
  }

  clickCostMicro(c: Campaign): number {
    return this.impressionCostMicro(c) * this.cfg.clickMultiplier;
  }

  remainingMicro(c: Campaign): number {
    return c.budget_micro - c.spent_micro - c.refunded_micro;
  }

  /**
   * The live serving pool: every campaign that was *admitted* into the auction
   * (activated_at set — it outbid the leader and was funded), is still active,
   * and can afford at least one more impression, ranked by bid (ties broken by
   * age). Admission is the entry gate; once in, being outbid no longer drops a
   * campaign — only an explicit pause/cancel or running out of budget does. The
   * whole admitted pool serves; bids decide share, not exclusivity.
   */
  eligible(): Campaign[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM campaigns
         WHERE status = 'active' AND activated_at IS NOT NULL AND budget_micro - spent_micro > 0
         ORDER BY bid_per_block_micro DESC, created_at ASC`,
      )
      .all() as Campaign[];
    return rows.filter((c) => this.remainingMicro(c) >= this.impressionCostMicro(c));
  }

  /**
   * The highest bid currently in the serving pool, ignoring one campaign (the
   * admission candidate). 0 when the pool is otherwise empty — so the first
   * funded bid always clears the bar.
   */
  private topServingBidMicro(excludeId: string): number {
    let top = 0;
    for (const c of this.eligible()) {
      if (c.id === excludeId) continue;
      if (c.bid_per_block_micro > top) top = c.bid_per_block_micro;
    }
    return top;
  }

  /**
   * Admit a campaign into the serving pool if it now qualifies: active, funded
   * (can afford an impression), not already serving, and outbidding the current
   * top serving campaign. This is the auction's entry gate — funding or raising
   * is what triggers it. Already-admitted campaigns are never displaced by a new
   * entrant; they leave only via pause/cancel/budget-exhaustion. Returns true if
   * the campaign just became active.
   */
  private tryActivate(c: Campaign): boolean {
    if (c.status !== "active" || c.activated_at) return false;
    if (this.remainingMicro(c) < this.impressionCostMicro(c)) return false; // unfunded: never serves
    if (c.bid_per_block_micro <= this.topServingBidMicro(c.id)) return false; // didn't outbid the leader
    const now = Date.now();
    this.db.prepare(`UPDATE campaigns SET activated_at = ? WHERE id = ?`).run(now, c.id);
    c.activated_at = now;
    return true;
  }

  /**
   * The auction leader: highest funded active bid (ties broken by age). It no
   * longer monopolises serving — it's the top of the rotation, used for the
   * board's ranking and as the headline price.
   */
  winner(): Campaign | undefined {
    return this.eligible()[0];
  }

  /**
   * Pick the next campaign to serve, cycling the eligible pool so multiple
   * active campaigns rotate for the same recipient instead of one winner
   * taking every slot. Uses smooth weighted round-robin keyed on the bid:
   * a $5 bid is served ~5x as often as a $1 bid, but the $1 campaign still
   * gets its turns — it is never suspended for being outbid.
   */
  pickServe(): Campaign | undefined {
    const pool = this.eligible();
    if (pool.length <= 1) return pool[0];

    // Forget campaigns that have left the pool so their weight can't grow stale.
    const live = new Set(pool.map((c) => c.id));
    for (const id of this.serveWeights.keys()) {
      if (!live.has(id)) this.serveWeights.delete(id);
    }

    const total = pool.reduce((sum, c) => sum + c.bid_per_block_micro, 0);
    let best: Campaign | undefined;
    let bestWeight = -Infinity;
    for (const c of pool) {
      const next = (this.serveWeights.get(c.id) ?? 0) + c.bid_per_block_micro;
      this.serveWeights.set(c.id, next);
      // Strict `>` keeps the pool's (bid desc, age asc) order as the tiebreak.
      if (next > bestWeight) {
        bestWeight = next;
        best = c;
      }
    }
    this.serveWeights.set(best!.id, bestWeight - total);
    return best;
  }

  /**
   * Public auction board: ranked queue with remaining budget. Wallets stay
   * private — the board identifies advertisers by their chosen label only.
   * `serving` reflects the admission gate: a funded campaign that hasn't yet
   * outbid the leader appears on the board but with serving=false.
   */
  auctionState() {
    const rows = this.db
      .prepare(
        `SELECT * FROM campaigns WHERE status = 'active'
         ORDER BY bid_per_block_micro DESC, created_at ASC`,
      )
      .all() as Campaign[];
    const serving = new Set(this.eligible().map((c) => c.id));
    return rows.map((c, i) => ({
      rank: i + 1,
      campaignId: c.id,
      advertiser: c.label ?? "anonymous",
      message: c.message,
      bidPerBlockMicro: c.bid_per_block_micro,
      remainingMicro: this.remainingMicro(c),
      serving: serving.has(c.id),
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

    const dropFromPool = this.db.prepare(
      `UPDATE campaigns SET activated_at = NULL WHERE id = ?`,
    );

    let inserted = false;
    this.db.transaction(() => {
      const res = insertEvent.run(event);
      if (res.changes === 0) return; // duplicate key: no-op
      inserted = true;
      debit.run(cost, c.id);
      credit.run(input.publisher, publisherMicro);
      // If this debit exhausted the budget, the campaign leaves the pool. It
      // is no longer "a campaign that was active" — re-funding it later must
      // outbid the leader again to re-enter, same as any new entrant.
      if (this.remainingMicro(this.mustGetCampaign(c.id)) < this.impressionCostMicro(c)) {
        dropFromPool.run(c.id);
      }
    })();
    return inserted ? event : undefined;
  }

  /** Impression/click counts for one (publisher, campaign) pair — the basis
   *  of the click-ratio cap. */
  publisherCampaignCounts(publisher: string, campaignId: string): { impressions: number; clicks: number } {
    return this.db
      .prepare(
        `SELECT
           COUNT(CASE WHEN type = 'impression' THEN 1 END) AS impressions,
           COUNT(CASE WHEN type = 'click' THEN 1 END) AS clicks
         FROM events WHERE publisher = ? AND campaign_id = ?`,
      )
      .get(publisher, campaignId) as { impressions: number; clicks: number };
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
      kind: "earnings",
      campaign_id: null,
      tx: null,
      created_at: Date.now(),
    };
    const insert = this.db.prepare(
      `INSERT INTO payouts (id, wallet, amount_micro, status, kind, campaign_id, tx, created_at)
       VALUES (@id, @wallet, @amount_micro, @status, @kind, @campaign_id, @tx, @created_at)`,
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

  /**
   * Withdraw a cancelled campaign's unspent escrow as a refund payout. Debits
   * the escrow (refunded_micro) the moment the payout row is created — the
   * same debit-first discipline as publisher payouts, so a crash mid-send can
   * never refund twice. No minimum: it's the advertiser's money.
   */
  requestRefund(campaignId: string, toWallet: string): Payout {
    const c = this.mustGetCampaign(campaignId);
    if (c.status !== "cancelled") {
      throw new MarketError("cancel the campaign before withdrawing its escrow", 409);
    }
    const remaining = this.remainingMicro(c);
    if (remaining <= 0) {
      throw new MarketError("no unspent budget to withdraw", 400);
    }
    const payout: Payout = {
      id: `out_${nanoid(12)}`,
      wallet: toWallet,
      amount_micro: remaining,
      status: "queued",
      kind: "refund",
      campaign_id: c.id,
      tx: null,
      created_at: Date.now(),
    };
    const insert = this.db.prepare(
      `INSERT INTO payouts (id, wallet, amount_micro, status, kind, campaign_id, tx, created_at)
       VALUES (@id, @wallet, @amount_micro, @status, @kind, @campaign_id, @tx, @created_at)`,
    );
    const debit = this.db.prepare(
      `UPDATE campaigns SET refunded_micro = refunded_micro + ? WHERE id = ?`,
    );
    this.db.transaction(() => {
      insert.run(payout);
      debit.run(remaining, c.id);
    })();
    return payout;
  }

  /** Refund payouts issued for a campaign — the owner's withdrawal history. */
  listCampaignPayouts(campaignId: string): Payout[] {
    return this.db
      .prepare(`SELECT * FROM payouts WHERE campaign_id = ? ORDER BY created_at DESC`)
      .all(campaignId) as Payout[];
  }

  getPayout(id: string): Payout | undefined {
    return this.db.prepare(`SELECT * FROM payouts WHERE id = ?`).get(id) as Payout | undefined;
  }

  /** Record that the payout transaction was broadcast (receipt still unknown). */
  markPayoutSubmitted(id: string, tx: string): void {
    const payout = this.mustGetPayout(id);
    if (payout.status !== "queued") {
      throw new MarketError(`payout ${id} is ${payout.status}, expected queued`, 409);
    }
    this.db.prepare(`UPDATE payouts SET status = 'submitted', tx = ? WHERE id = ?`).run(tx, id);
  }

  /**
   * Terminal transition. "sent" confirms the receipt; "failed" returns the
   * debit to where it came from — the publisher's withdrawable pool for
   * earnings, the campaign's escrow for refunds (so the advertiser can
   * withdraw again, e.g. to a corrected wallet). Already-terminal payouts
   * cannot transition again — that's what makes a refund single-shot.
   */
  resolvePayout(id: string, status: "sent" | "failed", tx?: string): void {
    const payout = this.mustGetPayout(id);
    if (payout.status === "sent" || payout.status === "failed") {
      throw new MarketError(`payout ${id} already resolved as ${payout.status}`, 409);
    }
    const update = this.db.prepare(`UPDATE payouts SET status = ?, tx = ? WHERE id = ?`);
    const refundEarnings = this.db.prepare(
      `UPDATE publishers SET paid_micro = paid_micro - ? WHERE wallet = ?`,
    );
    const refundEscrow = this.db.prepare(
      `UPDATE campaigns SET refunded_micro = refunded_micro - ? WHERE id = ?`,
    );
    this.db.transaction(() => {
      update.run(status, tx ?? payout.tx, id);
      if (status === "failed") {
        if (payout.kind === "refund") refundEscrow.run(payout.amount_micro, payout.campaign_id);
        else refundEarnings.run(payout.amount_micro, payout.wallet);
      }
    })();
  }

  listPayouts(wallet: string): Payout[] {
    return this.db
      .prepare(`SELECT * FROM payouts WHERE wallet = ? ORDER BY created_at DESC`)
      .all(wallet) as Payout[];
  }

  /** Operator view: every payout, optionally filtered by status. */
  listAllPayouts(status?: Payout["status"]): Payout[] {
    if (status) {
      return this.db
        .prepare(`SELECT * FROM payouts WHERE status = ? ORDER BY created_at DESC`)
        .all(status) as Payout[];
    }
    return this.db.prepare(`SELECT * FROM payouts ORDER BY created_at DESC`).all() as Payout[];
  }

  private mustGetPayout(id: string): Payout {
    const p = this.getPayout(id);
    if (!p) throw new MarketError("payout not found", 404);
    return p;
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
