import express, { type Express, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { z } from "zod";
import { isEvmAddress, USD, usdToMicro, type Config } from "./config.js";
import type { Campaign, Payout } from "./db.js";
import { MarketError, type Marketplace } from "./marketplace.js";
import { buildFundingPaywall, describePrice, fundingPriceMicro } from "./payments.js";
import { executePayout, retryPayout } from "./payouts.js";
import { Pacer, RateLimiter } from "./ratelimit.js";
import { signToken, verifyToken, type ServeToken } from "./tokens.js";

const RaiseBid = z.object({ bidPerBlockUsd: z.number().positive() });

// An event no longer carries the campaign/publisher/wallet — those are read
// from the signed serve token, so a caller can only bill what it was served.
const Event = z.object({
  token: z.string().min(16).max(2048),
  type: z.enum(["impression", "click"]),
});

/** Public view of a campaign: wallet and credential hash never leave the server. */
function publicCampaign({ advertiser: _wallet, manage_key_hash: _hash, ...c }: Campaign) {
  return { ...c, advertiser: c.label ?? "anonymous" };
}

/** Owner view: everything but the credential hash. */
function ownCampaign({ manage_key_hash: _hash, ...c }: Campaign) {
  return c;
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function manageKeyFrom(req: Request): string | undefined {
  const header = req.header("x-manage-key");
  if (header) return header;
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}

export async function buildApp(cfg: Config, market: Marketplace): Promise<Express> {
  const app = express();
  // Honoring X-Forwarded-For is opt-in: enabled blindly it lets any client
  // spoof its identity to the per-IP rate limits. Set TRUST_PROXY only when a
  // reverse proxy you control sits in front.
  app.set("trust proxy", cfg.trustProxy);
  app.use(express.json());

  // Structured request log on the API surface — errors always, plus every
  // state-changing request. GET /v1/serve at full volume stays out of it.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/v1/")) return next();
    const start = Date.now();
    res.on("finish", () => {
      if (res.statusCode < 400 && req.method === "GET") return;
      console.log(
        JSON.stringify({
          evt: "http",
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - start,
          ip: clientIp(req),
        }),
      );
    });
    next();
  });

  const isAdmin = (req: Request): boolean => {
    if (!cfg.adminToken) return false;
    const given =
      req.header("x-admin-token") ??
      (req.header("authorization")?.toLowerCase().startsWith("bearer ")
        ? req.header("authorization")!.slice(7).trim()
        : undefined);
    return !!given && constantTimeEq(given, cfg.adminToken);
  };

  /** Manage-key (campaign owner) or admin-token gate for campaign mutations. */
  const canManage = (req: Request, campaignId: string): boolean =>
    isAdmin(req) || market.verifyManageKey(campaignId, manageKeyFrom(req));

  // Campaign creative constraints. Landing URLs are https-only on the real
  // rail; the mock rail additionally allows localhost http for development.
  const urlOk = (raw: string): boolean => {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:") return true;
      return (
        cfg.paymentsMode === "mock" &&
        u.protocol === "http:" &&
        (u.hostname === "localhost" || u.hostname === "127.0.0.1")
      );
    } catch {
      return false;
    }
  };
  const CreateCampaign = z.object({
    advertiser: z.string().min(1).max(64),
    label: z.string().min(1).max(32).optional(),
    message: z.string().min(1).max(80),
    url: z
      .string()
      .max(512)
      .refine(urlOk, { message: "landing url must be https://" }),
    bidPerBlockUsd: z.number().positive(),
  });

  // Anti-fraud machinery: a signing key for serve tokens, per-IP buckets on
  // the two endpoints that move money, and a per-(publisher,surface) pacer so
  // a single surface can't bill faster than the human view rate.
  const secret = market.signingSecret();
  const serveLimiter = new RateLimiter(cfg.serveRatePerSec, cfg.serveBurst);
  const eventLimiter = new RateLimiter(cfg.eventRatePerSec, cfg.eventBurst);
  const minViewMs = Math.floor(cfg.slotSeconds * 1000 * 0.9); // tolerate timer jitter
  const servePacer = new Pacer(minViewMs);
  const tokenTtlMs = cfg.tokenTtlSeconds * 1000;

  app.get("/healthz", (_req, res) => {
    try {
      market.winner(); // exercises the DB
      res.json({ ok: true, mode: cfg.paymentsMode, uptimeSec: Math.floor(process.uptime()) });
    } catch (err) {
      res.status(503).json({ ok: false, error: String(err) });
    }
  });

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
        "POST /v1/campaigns {advertiser, message, url, bidPerBlockUsd} — response includes your one-time manage key",
        "POST /v1/fund?campaign=<id>&blocks=<n>  — returns 402; pay via x402 to settle",
        "POST /v1/campaigns/:id/bid {bidPerBlockUsd} + X-Manage-Key — raise to outrank competitors",
        "GET  /v1/auction — see the board you are bidding against",
      ],
    });
  });

  // ---- advertiser side ----

  app.post("/v1/campaigns", (req, res) => {
    const body = CreateCampaign.parse(req.body);
    const { manageKey, ...campaign } = market.createCampaign({
      advertiser: body.advertiser,
      label: body.label,
      message: body.message,
      url: body.url,
      bidPerBlockMicro: usdToMicro(body.bidPerBlockUsd),
    });
    res.status(201).json({
      campaign: ownCampaign(campaign),
      manageKey,
      manageKeyNote:
        "Save this key — it is shown exactly once and is required to raise bids, pause, or read stats.",
      next: `POST /v1/fund?campaign=${campaign.id}&blocks=1 (HTTP 402 → pay ${describePrice(
        campaign.bid_per_block_micro,
      )} per block via x402)`,
    });
  });

  // Listing is public and wallet-free. Campaign management and stats are
  // keyed by the per-campaign manage key, not by knowing a wallet address.
  app.get("/v1/campaigns", (_req, res) => {
    res.json({ campaigns: market.listCampaigns().map(publicCampaign) });
  });

  app.get("/v1/campaigns/:id/stats", (req, res) => {
    if (!canManage(req, req.params.id)) {
      return void res.status(403).json({ error: "manage key required" });
    }
    res.json(market.campaignStats(req.params.id));
  });

  app.get("/v1/campaigns/:id", (req, res) => {
    const c = market.getCampaign(req.params.id);
    if (!c) return void res.status(404).json({ error: "campaign not found" });
    res.json(canManage(req, c.id) ? ownCampaign(c) : publicCampaign(c));
  });

  app.post("/v1/campaigns/:id/bid", (req, res) => {
    if (!canManage(req, req.params.id)) {
      return void res.status(403).json({ error: "manage key required to raise this campaign's bid" });
    }
    const body = RaiseBid.parse(req.body);
    const campaign = market.raiseBid(req.params.id, usdToMicro(body.bidPerBlockUsd));
    res.json({ campaign: ownCampaign(campaign) });
  });

  // Kill switch: the owner (manage key) or the operator (admin token) can
  // take a campaign off the board; paused campaigns never serve.
  app.post("/v1/campaigns/:id/pause", (req, res) => {
    if (!canManage(req, req.params.id)) {
      return void res.status(403).json({ error: "manage key or admin token required" });
    }
    res.json({ campaign: ownCampaign(market.setCampaignStatus(req.params.id, "paused")) });
  });

  app.post("/v1/campaigns/:id/resume", (req, res) => {
    if (!canManage(req, req.params.id)) {
      return void res.status(403).json({ error: "manage key or admin token required" });
    }
    res.json({ campaign: ownCampaign(market.setCampaignStatus(req.params.id, "active")) });
  });

  app.get("/v1/auction", (_req, res) => {
    res.json({ board: market.auctionState() });
  });

  // The one paid route. On the mock rail the middleware marks the request
  // settled and the handler credits escrow. On the x402 rail the credit
  // happens in the onAfterSettle hook (see payments.ts) — settlement runs
  // after this handler, and a failed settlement discards this response.
  const paywall = await buildFundingPaywall(cfg, market);
  app.post("/v1/fund", paywall, (req, res) => {
    const campaignId = String(req.query.campaign ?? "");
    const blocks = Number(req.query.blocks ?? 1);
    const amountMicro = fundingPriceMicro(market, campaignId, String(blocks));

    if (cfg.paymentsMode === "mock") {
      const settled = req.settledPayment ?? { payer: "unknown", rail: "mock" as const };
      const { campaign, payment } = market.fundCampaign({
        campaignId,
        payer: settled.payer,
        amountMicro,
        rail: settled.rail,
        tx: settled.tx,
      });
      return void res.status(201).json({
        funded: describePrice(amountMicro),
        blocks,
        payment,
        campaign: ownCampaign(campaign),
      });
    }

    res.status(201).json({
      funded: describePrice(amountMicro),
      blocks,
      campaignId,
      payment: { rail: "x402", status: "settled" },
      note: "Escrow is credited at settlement; the on-chain tx hash is in the PAYMENT-RESPONSE header.",
    });
  });

  // ---- publisher side ----

  app.get("/v1/serve", (req, res) => {
    const now = Date.now();
    if (!serveLimiter.allow(clientIp(req), now)) {
      return void res.status(429).json({ error: "rate limit exceeded" });
    }
    const winner = market.winner();
    if (!winner) return void res.status(204).end();

    const impressionMicro = market.impressionCostMicro(winner);
    const clickMicro = market.clickCostMicro(winner);

    // A billable serve token is issued only to a valid payout wallet +
    // surface that hasn't been served within the slot window — one paid
    // impression per view. Anything else still gets the creative, unbillably.
    const publisher = typeof req.query.pub === "string" ? req.query.pub.slice(0, 64) : "";
    const surface = typeof req.query.surface === "string" ? req.query.surface.slice(0, 64) : "";
    let token: string | undefined;
    if (
      isEvmAddress(publisher) &&
      surface &&
      servePacer.ready(`${publisher}|${surface}`, now)
    ) {
      const payload: ServeToken = {
        jti: `evt_${nanoid(16)}`,
        campaignId: winner.id,
        publisher,
        surface,
        iat: now,
        impMicro: impressionMicro,
        clkMicro: clickMicro,
      };
      token = signToken(secret, payload);
    }

    res.json({
      campaignId: winner.id,
      message: winner.message,
      url: winner.url,
      slotSeconds: cfg.slotSeconds,
      impressionMicro,
      clickMicro,
      publisherShare: cfg.publisherShare,
      token,
    });
  });

  app.post("/v1/events", (req, res) => {
    const now = Date.now();
    if (!eventLimiter.allow(clientIp(req), now)) {
      return void res.status(429).json({ error: "rate limit exceeded" });
    }
    const body = Event.parse(req.body);

    const tok = verifyToken(secret, body.token);
    if (!tok) return void res.status(403).json({ error: "invalid serve token" });

    const age = now - tok.iat;
    if (age < minViewMs) {
      return void res.status(425).json({ error: "view threshold not met", recorded: false });
    }
    if (age > tokenTtlMs) {
      return void res.status(410).json({ error: "serve token expired", recorded: false });
    }

    if (body.type === "click") {
      // A click can only follow a counted view of the same serve token…
      if (!market.hasEvent(tok.jti)) {
        return void res
          .status(409)
          .json({ error: "click without a counted impression", recorded: false });
      }
      // …and clicks bill at 50× an impression, so they are capped to a
      // plausible click-through ratio per (publisher, campaign). The floor of
      // one click keeps a brand-new surface usable.
      const counts = market.publisherCampaignCounts(tok.publisher, tok.campaignId);
      const allowed = Math.max(1, Math.floor(counts.impressions * cfg.clickRatio));
      if (counts.clicks >= allowed) {
        return void res.status(429).json({
          error: `click ratio exceeded (${counts.clicks} clicks over ${counts.impressions} impressions)`,
          recorded: false,
        });
      }
    }

    const event = market.recordEvent({
      key: body.type === "impression" ? tok.jti : `${tok.jti}#click`,
      type: body.type,
      campaignId: tok.campaignId,
      publisher: tok.publisher,
      surface: tok.surface,
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
    if (!isEvmAddress(wallet)) {
      return void res.status(400).json({ error: "wallet must be a 0x-prefixed EVM address" });
    }
    const payout = market.requestPayout(wallet);
    const result = await executePayout(cfg, market, payout.id, wallet, payout.amount_micro);
    res.status(201).json({ payout: { ...payout, ...result } });
  });

  // ---- operator/admin (enabled only when ADMIN_TOKEN is set) ----

  const requireAdmin = (req: Request, res: Response): boolean => {
    // 404 (not 401) when admin is disabled, so the surface doesn't advertise itself.
    if (!cfg.adminToken) {
      res.status(404).json({ error: "not found" });
      return false;
    }
    if (!isAdmin(req)) {
      res.status(401).json({ error: "admin token required" });
      return false;
    }
    return true;
  };

  app.get("/v1/admin/payouts", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = typeof req.query.status === "string" ? (req.query.status as Payout["status"]) : undefined;
    res.json({ payouts: market.listAllPayouts(status) });
  });

  // Retry a queued payout (re-send) or reconcile a submitted one against its
  // recorded tx. Never re-sends a payout that has a tx hash.
  app.post("/v1/admin/payouts/:id/retry", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ result: await retryPayout(cfg, market, req.params.id) });
  });

  // Operator decision: give up on a payout and refund the publisher balance.
  // Refuse when a tx was broadcast and not yet proven reverted.
  app.post("/v1/admin/payouts/:id/fail", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const payout = market.getPayout(req.params.id);
    if (!payout) return void res.status(404).json({ error: "payout not found" });
    if (payout.status === "submitted" && req.query.force !== "1") {
      return void res.status(409).json({
        error:
          "payout has a broadcast tx; reconcile with /retry first, or pass ?force=1 if the tx is provably dead",
      });
    }
    market.resolvePayout(payout.id, "failed");
    res.json({ payout: market.getPayout(payout.id) });
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
