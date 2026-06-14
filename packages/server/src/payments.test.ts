import { describe, expect, it } from "vitest";
import { loadConfig, USD } from "./config.js";
import { openDb } from "./db.js";
import { Marketplace } from "./marketplace.js";
import { creditSettledFunding, payerFromSettlement } from "./payments.js";

/**
 * The x402 rail credits escrow in the onAfterSettle hook — these tests drive
 * that hook with a fake settle context, the same shape the middleware passes.
 */

const cfg = loadConfig({} as NodeJS.ProcessEnv);

async function marketWithCampaign() {
  const m = new Marketplace(await openDb(), cfg);
  const c = await m.createCampaign({
    advertiser: "0xAdv",
    message: "ad",
    url: "https://example.com",
    bidPerBlockMicro: 2 * USD,
  });
  return { m, c };
}

function settleCtx(campaignId: string, blocks: string, path = "/v1/fund") {
  return {
    transportContext: {
      request: {
        path,
        adapter: {
          getQueryParam: (name: string) =>
            name === "campaign" ? campaignId : name === "blocks" ? blocks : undefined,
        },
      },
    },
    result: { payer: "0xPayer", transaction: "0xsettletx" },
    paymentPayload: { payload: { authorization: { from: "0xAuthFrom" } } },
  };
}

describe("x402 settlement credit", () => {
  it("credits exactly blocks × bid with the facilitator's payer and tx", async () => {
    const { m, c } = await marketWithCampaign();
    await creditSettledFunding(m, settleCtx(c.id, "3"));
    expect((await m.getCampaign(c.id))!.budget_micro).toBe(6 * USD);
  });

  it("ignores settlements for other routes", async () => {
    const { m, c } = await marketWithCampaign();
    await creditSettledFunding(m, settleCtx(c.id, "3", "/v1/other"));
    expect((await m.getCampaign(c.id))!.budget_micro).toBe(0);
  });

  it("throws (and credits nothing) for a vanished campaign — money must never disappear silently", async () => {
    const { m } = await marketWithCampaign();
    await expect(creditSettledFunding(m, settleCtx("cmp_gone", "1"))).rejects.toThrow();
  });

  it("prefers the facilitator-reported payer, falls back to the signed authorization", () => {
    expect(payerFromSettlement({ result: { payer: "0xPayer" } })).toBe("0xPayer");
    expect(
      payerFromSettlement({ paymentPayload: { payload: { authorization: { from: "0xAuthFrom" } } } }),
    ).toBe("0xAuthFrom");
  });
});
