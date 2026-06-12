import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, USD } from "./config.js";
import { openDb } from "./db.js";
import { Marketplace, MarketError } from "./marketplace.js";

// The economics tests below assume a 50% publisher share; pin it explicitly
// (the production default is 40%, settable via PUBLISHER_SHARE).
const cfg = loadConfig({ PUBLISHER_SHARE: "0.5" } as NodeJS.ProcessEnv);

function makeMarket() {
  return new Marketplace(openDb(":memory:"), cfg);
}

function fundedCampaign(m: Marketplace, bidUsd: number, budgetUsd: number, advertiser = "adv") {
  const c = m.createCampaign({
    advertiser,
    message: `ad at $${bidUsd}`,
    url: "https://example.com",
    bidPerBlockMicro: bidUsd * USD,
  });
  m.fundCampaign({ campaignId: c.id, payer: advertiser, amountMicro: budgetUsd * USD, rail: "mock" });
  return m.getCampaign(c.id)!;
}

describe("auction", () => {
  let m: Marketplace;
  beforeEach(() => (m = makeMarket()));

  it("rejects bids below the minimum", () => {
    expect(() =>
      m.createCampaign({ advertiser: "a", message: "x", url: "https://e.com", bidPerBlockMicro: USD / 2 }),
    ).toThrow(MarketError);
  });

  it("rejects status lines over 80 chars", () => {
    expect(() =>
      m.createCampaign({ advertiser: "a", message: "y".repeat(81), url: "https://e.com", bidPerBlockMicro: USD }),
    ).toThrow(/80/);
  });

  it("highest funded bid wins; unfunded campaigns never serve", () => {
    fundedCampaign(m, 2, 10);
    const rich = fundedCampaign(m, 5, 10);
    m.createCampaign({ advertiser: "broke", message: "no budget", url: "https://e.com", bidPerBlockMicro: 9 * USD });
    expect(m.winner()?.id).toBe(rich.id);
  });

  it("breaks bid ties by campaign age", () => {
    const first = fundedCampaign(m, 3, 10);
    fundedCampaign(m, 3, 10);
    expect(m.winner()?.id).toBe(first.id);
  });

  it("enforces the English-auction minimum raise", () => {
    const c = fundedCampaign(m, 2, 10);
    expect(() => m.raiseBid(c.id, 2.2 * USD)).toThrow(/increment|must be/);
    const raised = m.raiseBid(c.id, 2.5 * USD);
    expect(raised.bid_per_block_micro).toBe(2.5 * USD);
  });

  it("a raised bid takes over serving", () => {
    const low = fundedCampaign(m, 2, 10);
    fundedCampaign(m, 5, 10);
    m.raiseBid(low.id, 6 * USD);
    expect(m.winner()?.id).toBe(low.id);
  });
});

describe("events and earnings", () => {
  let m: Marketplace;
  beforeEach(() => (m = makeMarket()));

  it("an impression costs bid/1000 and splits 50/50 with the publisher", () => {
    const c = fundedCampaign(m, 2, 10); // $2/block → $0.002/impression
    const e = m.recordEvent({ key: "k1", type: "impression", campaignId: c.id, publisher: "0xpub", surface: "s" })!;
    expect(e.amount_micro).toBe(2000);
    expect(e.publisher_micro).toBe(1000);
    expect(m.getCampaign(c.id)!.spent_micro).toBe(2000);
    expect(m.balanceMicro("0xpub")).toBe(1000);
  });

  it("a click costs 50x an impression", () => {
    const c = fundedCampaign(m, 2, 10);
    const e = m.recordEvent({ key: "k2", type: "click", campaignId: c.id, publisher: "0xpub", surface: "s" })!;
    expect(e.amount_micro).toBe(100_000); // $0.10
  });

  it("duplicate event keys are no-ops (idempotency)", () => {
    const c = fundedCampaign(m, 2, 10);
    m.recordEvent({ key: "dup", type: "impression", campaignId: c.id, publisher: "0xpub", surface: "s" });
    const again = m.recordEvent({ key: "dup", type: "impression", campaignId: c.id, publisher: "0xpub", surface: "s" });
    expect(again).toBeUndefined();
    expect(m.getCampaign(c.id)!.spent_micro).toBe(2000);
    expect(m.balanceMicro("0xpub")).toBe(1000);
  });

  it("clamps the last event to remaining budget and then stops serving", () => {
    const c = fundedCampaign(m, 1, 10);
    // Budget $10; a click costs $0.05 at $1/block. Drain to one click left:
    for (let i = 0; i < 199; i++) {
      m.recordEvent({ key: `c${i}`, type: "click", campaignId: c.id, publisher: "0xpub", surface: "s" });
    }
    expect(m.remainingMicro(m.getCampaign(c.id)!)).toBe(50_000); // one click left
    m.recordEvent({ key: "last", type: "click", campaignId: c.id, publisher: "0xpub", surface: "s" });
    expect(m.remainingMicro(m.getCampaign(c.id)!)).toBe(0);
    expect(m.recordEvent({ key: "over", type: "impression", campaignId: c.id, publisher: "0xpub", surface: "s" })).toBeUndefined();
    expect(m.winner()).toBeUndefined();
  });
});

describe("config", () => {
  it("defaults the publisher share to 40% and honors PUBLISHER_SHARE", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).publisherShare).toBe(0.4);
    expect(loadConfig({ PUBLISHER_SHARE: "0.25" } as NodeJS.ProcessEnv).publisherShare).toBe(0.25);
    expect(() => loadConfig({ PUBLISHER_SHARE: "1.5" } as NodeJS.ProcessEnv)).toThrow(/PUBLISHER_SHARE/);
  });

  const TREASURY = `0x${"e5".repeat(20)}`;
  const KEY = `0x${"f6".repeat(32)}`;

  it("refuses the treasury-draining combo: mock payments + real payout key", () => {
    expect(() =>
      loadConfig({ PAYMENTS_MODE: "mock", PAYOUT_PRIVATE_KEY: KEY } as NodeJS.ProcessEnv),
    ).toThrow(/drain the treasury/);
  });

  it("refuses mock payments in production unless explicitly allowed", () => {
    expect(() => loadConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/x402/);
    expect(
      loadConfig({ NODE_ENV: "production", ALLOW_MOCK_PAYMENTS: "1" } as NodeJS.ProcessEnv)
        .paymentsMode,
    ).toBe("mock");
  });

  it("x402 mode requires a real treasury address", () => {
    expect(() => loadConfig({ PAYMENTS_MODE: "x402" } as NodeJS.ProcessEnv)).toThrow(/PAY_TO_ADDRESS/);
    expect(() =>
      loadConfig({ PAYMENTS_MODE: "x402", PAY_TO_ADDRESS: "not-an-address" } as NodeJS.ProcessEnv),
    ).toThrow(/PAY_TO_ADDRESS/);
    expect(
      loadConfig({ PAYMENTS_MODE: "x402", PAY_TO_ADDRESS: TREASURY } as NodeJS.ProcessEnv).payTo,
    ).toBe(TREASURY);
  });

  it("validates the payout key shape", () => {
    expect(() =>
      loadConfig({
        PAYMENTS_MODE: "x402",
        PAY_TO_ADDRESS: TREASURY,
        PAYOUT_PRIVATE_KEY: "0xshort",
      } as NodeJS.ProcessEnv),
    ).toThrow(/PAYOUT_PRIVATE_KEY/);
  });
});

describe("manage keys", () => {
  let m: Marketplace;
  beforeEach(() => (m = makeMarket()));

  it("verifies only the exact key, and house/legacy campaigns are unmanageable", () => {
    const c = m.createCampaign({ advertiser: "a", message: "x", url: "https://e.com", bidPerBlockMicro: USD });
    expect(m.verifyManageKey(c.id, c.manageKey)).toBe(true);
    expect(m.verifyManageKey(c.id, "cvk_nope")).toBe(false);
    expect(m.verifyManageKey(c.id, undefined)).toBe(false);

    // simulate a legacy row with no hash
    m.setCampaignStatus(c.id, "active");
    const db = (m as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`UPDATE campaigns SET manage_key_hash = NULL WHERE id = ?`).run(c.id);
    expect(m.verifyManageKey(c.id, c.manageKey)).toBe(false);
  });
});

describe("auction board privacy", () => {
  let m: Marketplace;
  beforeEach(() => (m = makeMarket()));

  it("shows the advertiser label, never the wallet", () => {
    m.createCampaign({
      advertiser: "0xSecretWallet",
      label: "acme",
      message: "x",
      url: "https://e.com",
      bidPerBlockMicro: 2 * USD,
    });
    m.createCampaign({
      advertiser: "0xOtherWallet",
      message: "y",
      url: "https://e.com",
      bidPerBlockMicro: USD,
    });
    const board = m.auctionState();
    expect(JSON.stringify(board)).not.toContain("0xSecretWallet");
    expect(JSON.stringify(board)).not.toContain("0xOtherWallet");
    expect(board.map((b) => b.advertiser)).toEqual(["acme", "anonymous"]);
  });

  it("rejects labels over 32 chars", () => {
    expect(() =>
      m.createCampaign({
        advertiser: "a",
        label: "z".repeat(33),
        message: "x",
        url: "https://e.com",
        bidPerBlockMicro: USD,
      }),
    ).toThrow(/label/);
  });
});

describe("advertiser console queries", () => {
  let m: Marketplace;
  beforeEach(() => (m = makeMarket()));

  it("lists campaigns filtered by advertiser", () => {
    fundedCampaign(m, 2, 10, "alice");
    fundedCampaign(m, 3, 10, "bob");
    fundedCampaign(m, 4, 10, "alice");
    expect(m.listCampaigns("alice")).toHaveLength(2);
    expect(m.listCampaigns()).toHaveLength(3);
  });

  it("aggregates per-campaign stats", () => {
    const c = fundedCampaign(m, 2, 10);
    m.recordEvent({ key: "i1", type: "impression", campaignId: c.id, publisher: "p1", surface: "s" });
    m.recordEvent({ key: "i2", type: "impression", campaignId: c.id, publisher: "p2", surface: "s" });
    m.recordEvent({ key: "c1", type: "click", campaignId: c.id, publisher: "p1", surface: "s" });
    const stats = m.campaignStats(c.id);
    expect(stats.impressions).toBe(2);
    expect(stats.clicks).toBe(1);
    expect(stats.publishers).toBe(2);
    expect(stats.spentMicro).toBe(2000 + 2000 + 100_000);
  });
});

describe("payouts", () => {
  let m: Marketplace;
  beforeEach(() => (m = makeMarket()));

  function earn(publisher: string, usd: number) {
    const c = fundedCampaign(m, 1000, usd * 2, `adv-${Math.random()}`); // $1/impression at $1000/block
    const impressions = usd * 2; // 50% share → each impression earns $0.50
    for (let i = 0; i < impressions; i++) {
      m.recordEvent({ key: `${publisher}-${c.id}-${i}`, type: "impression", campaignId: c.id, publisher, surface: "s" });
    }
  }

  it("rejects payouts under the threshold", () => {
    earn("0xpub", 5);
    expect(() => m.requestPayout("0xpub")).toThrow(/threshold/);
  });

  it("pays out the full balance and debits the ledger", () => {
    earn("0xpub", 12);
    expect(m.balanceMicro("0xpub")).toBe(12 * USD);
    const payout = m.requestPayout("0xpub");
    expect(payout.amount_micro).toBe(12 * USD);
    expect(m.balanceMicro("0xpub")).toBe(0);
    expect(() => m.requestPayout("0xpub")).toThrow();
  });

  it("a failed payout refunds the withdrawable balance", () => {
    earn("0xpub", 12);
    const payout = m.requestPayout("0xpub");
    m.resolvePayout(payout.id, "failed");
    expect(m.balanceMicro("0xpub")).toBe(12 * USD);
    expect(m.listPayouts("0xpub")[0].status).toBe("failed");
  });
});
