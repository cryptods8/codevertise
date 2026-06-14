import { loadConfig, USD } from "./config.js";
import { openDb } from "./db.js";
import { Marketplace } from "./marketplace.js";
import { buildApp } from "./routes.js";

const cfg = loadConfig();
const db = await openDb(cfg.databaseUrl);
const market = new Marketplace(db, cfg);

// Bootstrap inventory with house ads so publishers see fill from minute one —
// but only on the mock rail. On the real rail publisher earnings are real
// USDC liabilities, so unfunded house inventory would pay out of the treasury.
if (cfg.paymentsMode === "mock") await seedHouseAds(market);

const app = await buildApp(cfg, market);
const server = app.listen(cfg.port, () => {
  console.log(`codevertise marketplace on :${cfg.port}`);
  console.log(`  payments: ${cfg.paymentsMode} (${cfg.network}, payTo ${cfg.payTo})`);
  console.log(`  GET /v1/info for the agent-readable contract`);
  if (cfg.paymentsMode === "mock") {
    console.warn(
      "  ⚠ MOCK RAIL: funding is free (X-Mock-Payment header). Never expose this publicly.",
    );
  }
});

// Graceful shutdown: stop accepting connections, then close the ledger.
// In-flight payout sends finish through the serialized chain before exit.
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ evt: "shutdown", signal: sig }));
    server.close(() => {
      void db.close().finally(() => process.exit(0));
    });
    // Idle keep-alive sockets would hold close() open forever; drop them now
    // and give in-flight requests a short grace before the hard stop.
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 5_000).unref();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

async function seedHouseAds(m: Marketplace) {
  if ((await m.auctionState()).length > 0) return;
  const seeds = [
    {
      message: "Codevertise: this status line is for rent — paid in USDC over HTTP 402",
      url: "https://github.com/codevertise",
      bidUsd: 1.0,
    },
    {
      // Seeded a step above the first so it clears the admission gate (a new
      // campaign must outbid the leader to start serving) and both go live.
      message: "Your agent can buy this slot itself: POST /v1/fund, pay the 402, done",
      url: "https://github.com/codevertise",
      bidUsd: 1.5,
    },
  ];
  for (const s of seeds) {
    const c = await m.createCampaign({
      advertiser: "house",
      label: "codevertise",
      message: s.message,
      url: s.url,
      bidPerBlockMicro: Math.round(s.bidUsd * USD),
    });
    // House budget is bookkeeping only; no real funds move on the mock rail.
    await m.fundCampaign({ campaignId: c.id, payer: "house", amountMicro: 5 * USD, rail: "mock" });
  }
  console.log("seeded 2 house campaigns");
}
