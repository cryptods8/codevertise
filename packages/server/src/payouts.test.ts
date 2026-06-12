import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, USD, type Config } from "./config.js";
import { openDb } from "./db.js";
import { Marketplace } from "./marketplace.js";
import { executePayout, retryPayout, type PayoutSender } from "./payouts.js";

/**
 * The payout state machine, exercised with a fake on-chain sender. The
 * invariant under test: a refund can only ever follow a PROVABLE failure
 * (reverted receipt or explicit operator action) — ambiguous outcomes leave
 * the debit standing so a retry can never double-send.
 */

const cfg: Config = loadConfig({ PUBLISHER_SHARE: "0.5" } as NodeJS.ProcessEnv);
const WALLET = `0x${"d4".repeat(20)}`;

function makeMarket() {
  return new Marketplace(openDb(":memory:"), cfg);
}

function earn(m: Marketplace, usd: number) {
  const c = m.createCampaign({
    advertiser: "adv",
    message: "ad",
    url: "https://example.com",
    bidPerBlockMicro: 1000 * USD, // $1/impression
  });
  m.fundCampaign({ campaignId: c.id, payer: "adv", amountMicro: usd * 2 * USD, rail: "mock" });
  for (let i = 0; i < usd * 2; i++) {
    m.recordEvent({ key: `e${i}`, type: "impression", campaignId: c.id, publisher: WALLET, surface: "s" });
  }
}

const okSender = (): PayoutSender => ({
  send: async () => "0xtx_ok",
  wait: async () => "success",
});

describe("payout state machine", () => {
  let m: Marketplace;
  beforeEach(() => {
    m = makeMarket();
    earn(m, 12);
  });

  it("happy path: queued → submitted → sent, balance stays debited", async () => {
    const p = m.requestPayout(WALLET);
    const result = await executePayout(cfg, m, p.id, WALLET, p.amount_micro, okSender());
    expect(result).toMatchObject({ status: "sent", tx: "0xtx_ok" });
    expect(m.getPayout(p.id)!.status).toBe("sent");
    expect(m.balanceMicro(WALLET)).toBe(0);
  });

  it("reverted receipt: payout fails and the balance is refunded once", async () => {
    const p = m.requestPayout(WALLET);
    const sender: PayoutSender = { send: async () => "0xtx_rev", wait: async () => "reverted" };
    const result = await executePayout(cfg, m, p.id, WALLET, p.amount_micro, sender);
    expect(result.status).toBe("failed");
    expect(m.balanceMicro(WALLET)).toBe(12 * USD);
    // A second resolution attempt must not refund again.
    expect(() => m.resolvePayout(p.id, "failed")).toThrow(/already resolved/);
  });

  it("send threw before broadcast: payout stays queued, NO refund, retry succeeds", async () => {
    const p = m.requestPayout(WALLET);
    const sender: PayoutSender = {
      send: async () => {
        throw new Error("rpc unreachable");
      },
      wait: async () => "success",
    };
    const result = await executePayout(cfg, m, p.id, WALLET, p.amount_micro, sender);
    expect(result.status).toBe("queued");
    expect(m.getPayout(p.id)!.status).toBe("queued");
    expect(m.balanceMicro(WALLET)).toBe(0); // debit stands

    const retried = await retryPayout(cfg, m, p.id, okSender());
    expect(retried.status).toBe("sent");
  });

  it("receipt timeout after broadcast: stays submitted with its tx, retry reconciles without re-sending", async () => {
    const p = m.requestPayout(WALLET);
    let sends = 0;
    const flaky: PayoutSender = {
      send: async () => {
        sends++;
        return "0xtx_pending";
      },
      wait: async () => {
        throw new Error("receipt timeout");
      },
    };
    const result = await executePayout(cfg, m, p.id, WALLET, p.amount_micro, flaky);
    expect(result).toMatchObject({ status: "submitted", tx: "0xtx_pending" });
    expect(m.balanceMicro(WALLET)).toBe(0); // ambiguous → debit stands

    const reconciler: PayoutSender = { send: async () => "0xNEVER", wait: async () => "success" };
    const retried = await retryPayout(cfg, m, p.id, reconciler);
    expect(retried).toMatchObject({ status: "sent", tx: "0xtx_pending" }); // original tx, no re-send
    expect(sends).toBe(1);
  });

  it("without a treasury key the payout queues for manual settlement", async () => {
    const p = m.requestPayout(WALLET);
    const result = await executePayout(cfg, m, p.id, WALLET, p.amount_micro);
    expect(result.status).toBe("queued");
  });
});
