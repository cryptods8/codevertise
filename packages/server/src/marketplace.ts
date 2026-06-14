import { createHash, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import type { Config } from "./config.js";
import { getOrCreateSigningSecret, type Db } from "./db.js";
import type { AdEvent, Campaign, Payment, Payout, Publisher, Report } from "./db.js";

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
    readonly db: Db,
    private cfg: Config,
  ) {}

  /** HMAC key for serve tokens (lazily resolved/persisted). */
  async signingSecret(): Promise<Buffer> {
    return (this.secret ??= await getOrCreateSigningSecret(this.db, this.cfg.eventSigningSecret));
  }

  /** Whether an event with this idempotency key has already been recorded. */
  async hasEvent(key: string): Promise<boolean> {
    return (await this.db.get(`SELECT 1 FROM events WHERE key = $1`, [key])) !== undefined;
  }

  // ---- content reports (DSA notice-and-action) ----

  /** Record a notice about hosted content. Returns the stored report. */
  async createReport(input: {
    campaignId?: string | null;
    reason: string;
    details: string;
    reporter?: string | null;
  }): Promise<Report> {
    const id = `rep_${nanoid(12)}`;
    await this.db.run(
      `INSERT INTO reports (id, campaign_id, reason, details, reporter, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
      [id, input.campaignId ?? null, input.reason, input.details, input.reporter ?? null, Date.now()],
    );
    return (await this.getReport(id))!;
  }

  async getReport(id: string): Promise<Report | undefined> {
    return this.db.get<Report>(`SELECT * FROM reports WHERE id = $1`, [id]);
  }

  /** Reports for the operator's review queue, newest first; filter by status. */
  async listReports(status?: Report["status"]): Promise<Report[]> {
    return status
      ? this.db.all<Report>(`SELECT * FROM reports WHERE status = $1 ORDER BY created_at DESC`, [status])
      : this.db.all<Report>(`SELECT * FROM reports ORDER BY created_at DESC`);
  }

  /** Operator decision on a report: actioned (content removed/restricted) or dismissed. */
  async resolveReport(
    id: string,
    status: "actioned" | "dismissed",
    resolution?: string,
  ): Promise<Report | undefined> {
    const existing = await this.getReport(id);
    if (!existing) return undefined;
    await this.db.run(
      `UPDATE reports SET status = $1, resolved_at = $2, resolution = $3 WHERE id = $4`,
      [status, Date.now(), resolution ?? null, id],
    );
    return this.getReport(id);
  }

  /** Count of open reports — a cheap signal for the operator's review queue. */
  async openReportCount(): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`,
    );
    return row?.n ?? 0;
  }

  // ---- campaigns & auction ----

  async createCampaign(input: {
    advertiser: string;
    label?: string | null;
    message: string;
    url: string;
    bidPerBlockMicro: number;
    /** Lowercase SIWE wallet of the signed-in creator, when there is one. */
    ownerWallet?: string | null;
  }): Promise<Campaign & { manageKey: string }> {
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
    await this.db.run(
      `INSERT INTO campaigns (id, advertiser, label, message, url, bid_per_block_micro, budget_micro, spent_micro, refunded_micro, status, created_at, manage_key_hash, owner_wallet, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        campaign.id,
        campaign.advertiser,
        campaign.label,
        campaign.message,
        campaign.url,
        campaign.bid_per_block_micro,
        campaign.budget_micro,
        campaign.spent_micro,
        campaign.refunded_micro,
        campaign.status,
        campaign.created_at,
        campaign.manage_key_hash,
        campaign.owner_wallet,
        campaign.activated_at,
      ],
    );
    return Object.assign(campaign, { manageKey });
  }

  /** Constant-time check of a manage key against the campaign's stored hash.
   *  Campaigns without a hash (house/legacy) are unmanageable over HTTP. */
  async verifyManageKey(campaignId: string, key: string | undefined): Promise<boolean> {
    const c = await this.getCampaign(campaignId);
    if (!c?.manage_key_hash || !key) return false;
    const given = Buffer.from(sha256Hex(key), "hex");
    const want = Buffer.from(c.manage_key_hash, "hex");
    return given.length === want.length && timingSafeEqual(given, want);
  }

  async setCampaignStatus(id: string, status: "active" | "paused"): Promise<Campaign> {
    const c = await this.mustGetCampaign(id);
    if (c.status === "cancelled") {
      throw new MarketError(`campaign ${id} is cancelled and cannot be ${status}`, 409);
    }
    await this.db.run(`UPDATE campaigns SET status = $1 WHERE id = $2`, [status, id]);
    return this.mustGetCampaign(id);
  }

  /**
   * Cancel a campaign: terminal — it leaves the auction board immediately and
   * can never serve, be resumed, or accept funding again. The unspent escrow
   * stays withdrawable via requestRefund.
   */
  async cancelCampaign(id: string): Promise<Campaign> {
    const c = await this.mustGetCampaign(id);
    if (c.status === "cancelled") {
      throw new MarketError(`campaign ${id} is already cancelled`, 409);
    }
    await this.db.run(`UPDATE campaigns SET status = 'cancelled' WHERE id = $1`, [id]);
    return this.mustGetCampaign(id);
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    return this.db.get<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  }

  async listCampaigns(advertiser?: string): Promise<Campaign[]> {
    if (advertiser) {
      return this.db.all<Campaign>(
        `SELECT * FROM campaigns WHERE advertiser = $1 ORDER BY created_at DESC`,
        [advertiser],
      );
    }
    return this.db.all<Campaign>(`SELECT * FROM campaigns ORDER BY created_at DESC`);
  }

  /** Every campaign a signed-in wallet created — the cross-browser "mine" list. */
  async listCampaignsByOwner(ownerWallet: string): Promise<Campaign[]> {
    return this.db.all<Campaign>(
      `SELECT * FROM campaigns WHERE owner_wallet = $1 ORDER BY created_at DESC`,
      [ownerWallet],
    );
  }

  /** The board name is an account-level setting: saving it renames the
   *  account's campaigns too, so the public board stays coherent. */
  async relabelOwnedCampaigns(ownerWallet: string, label: string | null): Promise<void> {
    await this.db.run(`UPDATE campaigns SET label = $1 WHERE owner_wallet = $2`, [label, ownerWallet]);
  }

  async campaignStats(id: string) {
    const c = await this.mustGetCampaign(id);
    const row = (await this.db.get<{ impressions: number; clicks: number; publishers: number }>(
      `SELECT
         COUNT(CASE WHEN type = 'impression' THEN 1 END) AS impressions,
         COUNT(CASE WHEN type = 'click' THEN 1 END) AS clicks,
         COUNT(DISTINCT publisher) AS publishers
       FROM events WHERE campaign_id = $1`,
      [id],
    ))!;
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
  async raiseBid(id: string, newBidMicro: number): Promise<Campaign> {
    const c = await this.mustGetCampaign(id);
    if (c.status === "cancelled") {
      throw new MarketError(`campaign ${id} is cancelled`, 409);
    }
    if (newBidMicro < c.bid_per_block_micro + this.cfg.minBidIncrementMicro) {
      throw new MarketError(
        `new bid must be >= current bid + ${this.cfg.minBidIncrementMicro} micro-USD`,
        400,
      );
    }
    await this.db.run(`UPDATE campaigns SET bid_per_block_micro = $1 WHERE id = $2`, [newBidMicro, id]);
    // A funded-but-not-yet-serving campaign can raise its way past the leader
    // and into the pool. An already-serving one just keeps its place.
    await this.tryActivate(await this.mustGetCampaign(id));
    return this.mustGetCampaign(id);
  }

  /** Credit escrowed budget after a settled payment (x402 / mock / mpp). */
  async fundCampaign(input: {
    campaignId: string;
    payer: string;
    amountMicro: number;
    rail: string;
    tx?: string;
  }): Promise<{ campaign: Campaign; payment: Payment }> {
    const c = await this.mustGetCampaign(input.campaignId);
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
    await this.db.tx(async (t) => {
      await t.run(
        `INSERT INTO payments (id, campaign_id, payer, amount_micro, rail, tx, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [payment.id, payment.campaign_id, payment.payer, payment.amount_micro, payment.rail, payment.tx, payment.created_at],
      );
      await t.run(`UPDATE campaigns SET budget_micro = budget_micro + $1 WHERE id = $2`, [
        input.amountMicro,
        c.id,
      ]);
    });
    // Funding is the moment a campaign can enter the auction: admit it if it now
    // outbids the leader (or the pool is empty). If it can't, it stays funded
    // but unserved until it raises past the top — being funded is not enough.
    await this.tryActivate(await this.mustGetCampaign(c.id));
    return { campaign: await this.mustGetCampaign(c.id), payment };
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
  async eligible(): Promise<Campaign[]> {
    const rows = await this.db.all<Campaign>(
      `SELECT * FROM campaigns
       WHERE status = 'active' AND activated_at IS NOT NULL AND budget_micro - spent_micro > 0
       ORDER BY bid_per_block_micro DESC, created_at ASC`,
    );
    return rows.filter((c) => this.remainingMicro(c) >= this.impressionCostMicro(c));
  }

  /**
   * The highest bid currently in the serving pool, ignoring one campaign (the
   * admission candidate). 0 when the pool is otherwise empty — so the first
   * funded bid always clears the bar.
   */
  private async topServingBidMicro(excludeId: string): Promise<number> {
    let top = 0;
    for (const c of await this.eligible()) {
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
  private async tryActivate(c: Campaign): Promise<boolean> {
    if (c.status !== "active" || c.activated_at) return false;
    if (this.remainingMicro(c) < this.impressionCostMicro(c)) return false; // unfunded: never serves
    if (c.bid_per_block_micro <= (await this.topServingBidMicro(c.id))) return false; // didn't outbid the leader
    const now = Date.now();
    await this.db.run(`UPDATE campaigns SET activated_at = $1 WHERE id = $2`, [now, c.id]);
    c.activated_at = now;
    return true;
  }

  /**
   * The auction leader: highest funded active bid (ties broken by age). It no
   * longer monopolises serving — it's the top of the rotation, used for the
   * board's ranking and as the headline price.
   */
  async winner(): Promise<Campaign | undefined> {
    return (await this.eligible())[0];
  }

  /**
   * Pick the next campaign to serve, cycling the eligible pool so multiple
   * active campaigns rotate for the same recipient instead of one winner
   * taking every slot. Uses smooth weighted round-robin keyed on the bid:
   * a $5 bid is served ~5x as often as a $1 bid, but the $1 campaign still
   * gets its turns — it is never suspended for being outbid.
   */
  async pickServe(): Promise<Campaign | undefined> {
    const pool = await this.eligible();
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
   * Only funded campaigns appear: one that can't afford a single impression
   * (never funded, or budget exhausted) is left off the board entirely — the
   * same "unfunded" gate used by `eligible`/`tryActivate`. `serving` then
   * reflects the admission gate: a funded campaign that hasn't yet outbid the
   * leader still appears on the board but with serving=false.
   */
  async auctionState() {
    const all = await this.db.all<Campaign>(
      `SELECT * FROM campaigns WHERE status = 'active'
       ORDER BY bid_per_block_micro DESC, created_at ASC`,
    );
    const rows = all.filter((c) => this.remainingMicro(c) >= this.impressionCostMicro(c));
    const serving = new Set((await this.eligible()).map((c) => c.id));
    return rows.map((c, i) => ({
      rank: i + 1,
      campaignId: c.id,
      advertiser: c.label ?? "anonymous",
      message: c.message,
      url: c.url,
      bidPerBlockMicro: c.bid_per_block_micro,
      budgetMicro: c.budget_micro,
      spentMicro: c.spent_micro,
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
  async recordEvent(input: {
    key: string;
    type: "impression" | "click";
    campaignId: string;
    publisher: string;
    surface: string;
  }): Promise<AdEvent | undefined> {
    const c = await this.mustGetCampaign(input.campaignId);
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

    return this.db.tx(async (t) => {
      // Idempotency: the event key is the primary key, but check explicitly so
      // a duplicate is a clean no-op (and so the debit/credit never run twice)
      // rather than relying on ON CONFLICT row counts.
      const dup = await t.get(`SELECT 1 FROM events WHERE key = $1`, [event.key]);
      if (dup) return undefined;

      await t.run(
        `INSERT INTO events (key, type, campaign_id, publisher, surface, amount_micro, publisher_micro, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event.key,
          event.type,
          event.campaign_id,
          event.publisher,
          event.surface,
          event.amount_micro,
          event.publisher_micro,
          event.created_at,
        ],
      );
      await t.run(`UPDATE campaigns SET spent_micro = spent_micro + $1 WHERE id = $2`, [cost, c.id]);
      await t.run(
        `INSERT INTO publishers (wallet, earned_micro, paid_micro) VALUES ($1, $2, 0)
         ON CONFLICT(wallet) DO UPDATE SET earned_micro = publishers.earned_micro + excluded.earned_micro`,
        [input.publisher, publisherMicro],
      );
      // If this debit exhausted the budget, the campaign leaves the pool. It
      // is no longer "a campaign that was active" — re-funding it later must
      // outbid the leader again to re-enter, same as any new entrant.
      const after = (await t.get<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [c.id]))!;
      if (this.remainingMicro(after) < this.impressionCostMicro(after)) {
        await t.run(`UPDATE campaigns SET activated_at = NULL WHERE id = $1`, [c.id]);
      }
      return event;
    });
  }

  /** Impression/click counts for one (publisher, campaign) pair — the basis
   *  of the click-ratio cap. */
  async publisherCampaignCounts(
    publisher: string,
    campaignId: string,
  ): Promise<{ impressions: number; clicks: number }> {
    return (await this.db.get<{ impressions: number; clicks: number }>(
      `SELECT
         COUNT(CASE WHEN type = 'impression' THEN 1 END) AS impressions,
         COUNT(CASE WHEN type = 'click' THEN 1 END) AS clicks
       FROM events WHERE publisher = $1 AND campaign_id = $2`,
      [publisher, campaignId],
    ))!;
  }

  async getPublisher(wallet: string): Promise<Publisher> {
    const row = await this.db.get<Publisher>(`SELECT * FROM publishers WHERE wallet = $1`, [wallet]);
    return row ?? { wallet, earned_micro: 0, paid_micro: 0 };
  }

  /** Withdrawable balance for a publisher. */
  async balanceMicro(wallet: string): Promise<number> {
    const p = await this.getPublisher(wallet);
    return p.earned_micro - p.paid_micro;
  }

  /**
   * Create a payout for the full withdrawable balance. The caller is
   * responsible for actually moving USDC and then marking sent/failed.
   */
  async requestPayout(wallet: string): Promise<Payout> {
    const balance = await this.balanceMicro(wallet);
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
    await this.db.tx(async (t) => {
      await t.run(
        `INSERT INTO payouts (id, wallet, amount_micro, status, kind, campaign_id, tx, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [payout.id, payout.wallet, payout.amount_micro, payout.status, payout.kind, payout.campaign_id, payout.tx, payout.created_at],
      );
      await t.run(`UPDATE publishers SET paid_micro = paid_micro + $1 WHERE wallet = $2`, [balance, wallet]);
    });
    return payout;
  }

  /**
   * Withdraw a cancelled campaign's unspent escrow as a refund payout. Debits
   * the escrow (refunded_micro) the moment the payout row is created — the
   * same debit-first discipline as publisher payouts, so a crash mid-send can
   * never refund twice. No minimum: it's the advertiser's money.
   */
  async requestRefund(campaignId: string, toWallet: string): Promise<Payout> {
    const c = await this.mustGetCampaign(campaignId);
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
    await this.db.tx(async (t) => {
      await t.run(
        `INSERT INTO payouts (id, wallet, amount_micro, status, kind, campaign_id, tx, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [payout.id, payout.wallet, payout.amount_micro, payout.status, payout.kind, payout.campaign_id, payout.tx, payout.created_at],
      );
      await t.run(`UPDATE campaigns SET refunded_micro = refunded_micro + $1 WHERE id = $2`, [remaining, c.id]);
    });
    return payout;
  }

  /** Refund payouts issued for a campaign — the owner's withdrawal history. */
  async listCampaignPayouts(campaignId: string): Promise<Payout[]> {
    return this.db.all<Payout>(
      `SELECT * FROM payouts WHERE campaign_id = $1 ORDER BY created_at DESC`,
      [campaignId],
    );
  }

  async getPayout(id: string): Promise<Payout | undefined> {
    return this.db.get<Payout>(`SELECT * FROM payouts WHERE id = $1`, [id]);
  }

  /** Record that the payout transaction was broadcast (receipt still unknown). */
  async markPayoutSubmitted(id: string, tx: string): Promise<void> {
    const payout = await this.mustGetPayout(id);
    if (payout.status !== "queued") {
      throw new MarketError(`payout ${id} is ${payout.status}, expected queued`, 409);
    }
    await this.db.run(`UPDATE payouts SET status = 'submitted', tx = $1 WHERE id = $2`, [tx, id]);
  }

  /**
   * Terminal transition. "sent" confirms the receipt; "failed" returns the
   * debit to where it came from — the publisher's withdrawable pool for
   * earnings, the campaign's escrow for refunds (so the advertiser can
   * withdraw again, e.g. to a corrected wallet). Already-terminal payouts
   * cannot transition again — that's what makes a refund single-shot.
   */
  async resolvePayout(id: string, status: "sent" | "failed", tx?: string): Promise<void> {
    const payout = await this.mustGetPayout(id);
    if (payout.status === "sent" || payout.status === "failed") {
      throw new MarketError(`payout ${id} already resolved as ${payout.status}`, 409);
    }
    await this.db.tx(async (t) => {
      await t.run(`UPDATE payouts SET status = $1, tx = $2 WHERE id = $3`, [status, tx ?? payout.tx, id]);
      if (status === "failed") {
        if (payout.kind === "refund") {
          await t.run(`UPDATE campaigns SET refunded_micro = refunded_micro - $1 WHERE id = $2`, [
            payout.amount_micro,
            payout.campaign_id,
          ]);
        } else {
          await t.run(`UPDATE publishers SET paid_micro = paid_micro - $1 WHERE wallet = $2`, [
            payout.amount_micro,
            payout.wallet,
          ]);
        }
      }
    });
  }

  async listPayouts(wallet: string): Promise<Payout[]> {
    return this.db.all<Payout>(`SELECT * FROM payouts WHERE wallet = $1 ORDER BY created_at DESC`, [wallet]);
  }

  /** Operator view: every payout, optionally filtered by status. */
  async listAllPayouts(status?: Payout["status"]): Promise<Payout[]> {
    if (status) {
      return this.db.all<Payout>(`SELECT * FROM payouts WHERE status = $1 ORDER BY created_at DESC`, [status]);
    }
    return this.db.all<Payout>(`SELECT * FROM payouts ORDER BY created_at DESC`);
  }

  private async mustGetPayout(id: string): Promise<Payout> {
    const p = await this.getPayout(id);
    if (!p) throw new MarketError("payout not found", 404);
    return p;
  }

  private async mustGetCampaign(id: string): Promise<Campaign> {
    const c = await this.getCampaign(id);
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
