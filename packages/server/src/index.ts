import { loadConfig, USD } from "./config.js";
import { openDb } from "./db.js";
import { Marketplace } from "./marketplace.js";
import { buildApp } from "./routes.js";

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const market = new Marketplace(db, cfg);

// Bootstrap inventory with house ads so publishers see fill from minute one
// (the same trick kickbacks.ai launched with).
seedHouseAds(market);

const app = await buildApp(cfg, market);
app.listen(cfg.port, () => {
  console.log(`codevertise marketplace on :${cfg.port}`);
  console.log(`  payments: ${cfg.paymentsMode} (${cfg.network}, payTo ${cfg.payTo})`);
  console.log(`  GET /v1/info for the agent-readable contract`);
});

function seedHouseAds(m: Marketplace) {
  if (m.auctionState().length > 0) return;
  const seeds = [
    {
      message: "Codevertise: this status line is for rent — paid in USDC over HTTP 402",
      url: "https://github.com/codevertise",
      bidUsd: 1.0,
    },
    {
      message: "Your agent can buy this slot itself: POST /v1/fund, pay the 402, done",
      url: "https://github.com/codevertise",
      bidUsd: 1.0,
    },
  ];
  for (const s of seeds) {
    const c = m.createCampaign({
      advertiser: "house",
      message: s.message,
      url: s.url,
      bidPerBlockMicro: Math.round(s.bidUsd * USD),
    });
    // House budget is bookkeeping only; no real funds move on the mock rail.
    m.fundCampaign({ campaignId: c.id, payer: "house", amountMicro: 5 * USD, rail: "mock" });
  }
  console.log("seeded 2 house campaigns");
}
