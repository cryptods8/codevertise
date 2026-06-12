import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { USD, usdToMicro, type Config } from "./config.js";
import { MarketError, type Marketplace } from "./marketplace.js";
import { buildFundingPaywall, describePrice, fundingPriceMicro } from "./payments.js";
import { executePayout } from "./payouts.js";

const CreateCampaign = z.object({
  advertiser: z.string().min(1).max(64),
  message: z.string().min(1).max(80),
  url: z.string().url().max(512),
  bidPerBlockUsd: z.number().positive(),
});

const RaiseBid = z.object({ bidPerBlockUsd: z.number().positive() });

const Event = z.object({
  key: z.string().min(8).max(128),
  type: z.enum(["impression", "click"]),
  campaignId: z.string(),
  publisher: z.string().min(1).max(64),
  surface: z.string().min(1).max(64).default("unknown"),
});

export async function buildApp(cfg: Config, market: Marketplace): Promise<Express> {
  const app = express();
  app.use(express.json());

  // Marketplace metadata — what an agent reads first.
  app.get("/v1/info", (_req, res) => {
    res.json({
      name: "codevertise",
      tagline: "Sponsored lines on AI coding-agent surfaces. Paid in USDC over HTTP 402.",
      paymentRails: {
        primary: { rail: "x402", network: cfg.network, asset: "USDC", mode: cfg.paymentsMode },
        planned: { rail: "mpp", chain: "tempo", note: "Machine Payments Protocol (Stripe/Tempo)" },
      },
      adUnit: {
        block: `${cfg.blockImpressions} impressions of 5s`,
        minBidUsd: cfg.minBidMicro / USD,
        minBidIncrementUsd: cfg.minBidIncrementMicro / USD,
        clickMultiplier: cfg.clickMultiplier,
      },
      publisherShare: cfg.publisherShare,
      minPayoutUsd: cfg.minPayoutMicro / USD,
      howToBid: [
        "POST /v1/campaigns {advertiser, message, url, bidPerBlockUsd}",
        "POST /v1/fund?campaign=<id>&blocks=<n>  — returns 402; pay via x402 to settle",
        "POST /v1/campaigns/:id/bid {bidPerBlockUsd} — raise to outrank competitors",
        "GET  /v1/auction — see the board you are bidding against",
      ],
    });
  });

  // ---- advertiser side ----

  app.post("/v1/campaigns", (req, res) => {
    const body = CreateCampaign.parse(req.body);
    const campaign = market.createCampaign({
      advertiser: body.advertiser,
      message: body.message,
      url: body.url,
      bidPerBlockMicro: usdToMicro(body.bidPerBlockUsd),
    });
    res.status(201).json({
      campaign,
      next: `POST /v1/fund?campaign=${campaign.id}&blocks=1 (HTTP 402 → pay ${describePrice(
        campaign.bid_per_block_micro,
      )} per block via x402)`,
    });
  });

  app.get("/v1/campaigns", (req, res) => {
    const advertiser = typeof req.query.advertiser === "string" ? req.query.advertiser : undefined;
    res.json({ campaigns: market.listCampaigns(advertiser) });
  });

  app.get("/v1/campaigns/:id/stats", (req, res) => {
    res.json(market.campaignStats(req.params.id));
  });

  app.get("/v1/campaigns/:id", (req, res) => {
    const c = market.getCampaign(req.params.id);
    if (!c) return void res.status(404).json({ error: "campaign not found" });
    res.json(c);
  });

  app.post("/v1/campaigns/:id/bid", (req, res) => {
    const body = RaiseBid.parse(req.body);
    const campaign = market.raiseBid(req.params.id, usdToMicro(body.bidPerBlockUsd));
    res.json({ campaign });
  });

  app.get("/v1/auction", (_req, res) => {
    res.json({ board: market.auctionState() });
  });

  // The one paid route. The paywall middleware (x402 or mock) must settle
  // payment before the handler runs; the handler then credits the escrow.
  const paywall = await buildFundingPaywall(cfg, market);
  app.post("/v1/fund", paywall, (req, res) => {
    const campaignId = String(req.query.campaign ?? "");
    const blocks = Number(req.query.blocks ?? 1);
    const amountMicro = fundingPriceMicro(market, campaignId, String(blocks));
    const settled = req.settledPayment ?? { payer: "unknown", rail: "mock" as const };
    const { campaign, payment } = market.fundCampaign({
      campaignId,
      payer: settled.payer,
      amountMicro,
      rail: settled.rail,
      tx: settled.tx,
    });
    res.status(201).json({
      funded: describePrice(amountMicro),
      blocks,
      payment,
      campaign,
    });
  });

  // ---- publisher side ----

  app.get("/v1/serve", (req, res) => {
    const winner = market.winner();
    if (!winner) return void res.status(204).end();
    res.json({
      campaignId: winner.id,
      message: winner.message,
      url: winner.url,
      slotSeconds: 5,
      impressionMicro: market.impressionCostMicro(winner),
      clickMicro: market.clickCostMicro(winner),
      publisherShare: cfg.publisherShare,
    });
  });

  app.post("/v1/events", (req, res) => {
    const body = Event.parse(req.body);
    const event = market.recordEvent({
      key: body.key,
      type: body.type,
      campaignId: body.campaignId,
      publisher: body.publisher,
      surface: body.surface,
    });
    if (!event) return void res.status(200).json({ recorded: false, reason: "duplicate or exhausted budget" });
    res.status(201).json({ recorded: true, earnedMicro: event.publisher_micro });
  });

  app.get("/v1/publishers/:wallet", (req, res) => {
    const p = market.getPublisher(req.params.wallet);
    res.json({
      wallet: p.wallet,
      earnedMicro: p.earned_micro,
      paidMicro: p.paid_micro,
      withdrawableMicro: market.balanceMicro(p.wallet),
      minPayoutMicro: cfg.minPayoutMicro,
      payouts: market.listPayouts(p.wallet),
    });
  });

  app.post("/v1/publishers/:wallet/payouts", async (req, res) => {
    const wallet = req.params.wallet;
    const payout = market.requestPayout(wallet);
    const result = await executePayout(cfg, market, payout.id, wallet, payout.amount_micro);
    res.status(201).json({ payout: { ...payout, ...result } });
  });

  // ---- advertiser webapp (static, no build step) ----
  const webappDir = fileURLToPath(new URL("../../webapp/public", import.meta.url));
  if (existsSync(webappDir)) app.use(express.static(webappDir));

  // ---- errors ----
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof MarketError) return void res.status(err.status).json({ error: err.message });
      if (err instanceof z.ZodError) return void res.status(400).json({ error: err.issues });
      const anyErr = err as { status?: number; message?: string };
      res.status(anyErr.status ?? 500).json({ error: anyErr.message ?? "internal error" });
    },
  );

  return app;
}
