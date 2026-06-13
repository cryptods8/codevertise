import express, { type Express, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { z } from "zod";
import { AdvertiserAuth, SESSION_COOKIE, SESSION_TTL_MS } from "./auth.js";
import { isEvmAddress, USD, usdToMicro, type Config } from "./config.js";
import type { Advertiser, Campaign, Payout } from "./db.js";
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

/** Public view of a campaign: wallets and credential hash never leave the server. */
function publicCampaign({ advertiser: _wallet, manage_key_hash: _hash, owner_wallet: _owner, ...c }: Campaign) {
  return { ...c, advertiser: c.label ?? "anonymous" };
}

/** Owner view: everything but the credential hash. */
function ownCampaign({ manage_key_hash: _hash, ...c }: Campaign) {
  return c;
}

/** What the webapp knows about a signed-in account. */
function accountView(adv: Advertiser) {
  return {
    signedIn: true,
    wallet: adv.wallet,
    label: adv.label,
    settingsSet: adv.settings_at !== null,
  };
}

function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Express 4 doesn't route async rejections to the error middleware itself. */
const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: express.NextFunction) =>
    fn(req, res).catch(next);

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

  // SIWE sign-in: the chain id is informational in the message; auth itself is
  // just an EIP-191 signature over a server-authored challenge.
  const chainId = Number(cfg.network.split(":")[1]) || 1;
  const auth = new AdvertiserAuth(market.db, chainId);
  const sessionWallet = (req: Request): string | undefined =>
    auth.sessionWallet(cookieValue(req, SESSION_COOKIE));

  /** Campaign-owner gate: manage key, signed-in owner wallet, or admin token. */
  const canManage = (req: Request, campaignId: string): boolean => {
    if (isAdmin(req)) return true;
    if (market.verifyManageKey(campaignId, manageKeyFrom(req))) return true;
    const wallet = sessionWallet(req);
    return !!wallet && market.getCampaign(campaignId)?.owner_wallet === wallet;
  };

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
    // Optional when a SIWE session identifies the creator's wallet.
    advertiser: z.string().min(1).max(64).optional(),
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

  // ---- advertiser sign-in (SIWE) & account ----

  // Brute-force / nonce-flood protection on the auth surface.
  const authLimiter = new RateLimiter(2, 20);
  const authAllowed = (req: Request, res: Response): boolean => {
    if (authLimiter.allow(clientIp(req), Date.now())) return true;
    res.status(429).json({ error: "rate limit exceeded" });
    return false;
  };

  const sessionCookieOpts = (req: Request) =>
    ({ httpOnly: true, sameSite: "lax", secure: req.secure, path: "/" }) as const;

  // Step 1: the server authors the exact EIP-4361 message to sign. The
  // challenge is bound to the address and expires in minutes.
  app.get("/v1/auth/nonce", (req, res) => {
    if (!authAllowed(req, res)) return;
    const address = String(req.query.address ?? "");
    if (!isEvmAddress(address)) {
      return void res.status(400).json({ error: "address must be a 0x-prefixed EVM address" });
    }
    const domain = req.headers.host ?? "localhost";
    res.json(auth.issueChallenge({ address, domain, uri: `${req.protocol}://${domain}` }));
  });

  // Step 2: redeem the signed challenge for a session cookie. The nonce is
  // single-use whatever the outcome.
  const VerifyBody = z.object({
    nonce: z.string().min(8).max(128),
    signature: z
      .string()
      .max(4096)
      .regex(/^0x[0-9a-fA-F]+$/, "signature must be 0x-prefixed hex"),
  });
  app.post("/v1/auth/verify", asyncRoute(async (req, res) => {
    if (!authAllowed(req, res)) return;
    const body = VerifyBody.parse(req.body);
    const wallet = await auth.verifyChallenge(body.nonce, body.signature);
    if (!wallet) {
      return void res.status(401).json({ error: "signature verification failed — request a fresh nonce and retry" });
    }
    const advertiser = auth.ensureAdvertiser(wallet);
    const session = auth.createSession(wallet);
    res.cookie(SESSION_COOKIE, session.token, {
      ...sessionCookieOpts(req),
      maxAge: SESSION_TTL_MS,
    });
    res.json(accountView(advertiser));
  }));

  app.get("/v1/auth/session", (req, res) => {
    const wallet = sessionWallet(req);
    if (!wallet) return void res.json({ signedIn: false });
    res.json(accountView(auth.ensureAdvertiser(wallet)));
  });

  app.post("/v1/auth/logout", (req, res) => {
    const token = cookieValue(req, SESSION_COOKIE);
    if (token) auth.deleteSession(token);
    res.clearCookie(SESSION_COOKIE, sessionCookieOpts(req));
    res.json({ signedIn: false });
  });

  /** 401-or-wallet gate for the signed-in account surface. */
  const requireSession = (req: Request, res: Response): string | undefined => {
    const wallet = sessionWallet(req);
    if (!wallet) res.status(401).json({ error: "sign in with your wallet first" });
    return wallet;
  };

  // Account settings. The board name lives on the account and is applied to
  // the account's campaigns; the signed-in wallet doubles as the refund
  // destination, so no separate "advertiser wallet" setting exists.
  const AccountBody = z.object({ label: z.string().trim().min(1).max(32) });
  app.put("/v1/account", (req, res) => {
    const wallet = requireSession(req, res);
    if (!wallet) return;
    const body = AccountBody.parse(req.body);
    const advertiser = auth.saveSettings(wallet, body.label);
    market.relabelOwnedCampaigns(wallet, body.label);
    res.json(accountView(advertiser));
  });

  // The cross-browser "my campaigns" list: owner views (with refund trails)
  // of every campaign this wallet created while signed in.
  app.get("/v1/me/campaigns", (req, res) => {
    const wallet = requireSession(req, res);
    if (!wallet) return;
    res.json({
      campaigns: market.listCampaignsByOwner(wallet).map((c) => ({
        ...ownCampaign(c),
        refunds: market.listCampaignPayouts(c.id),
      })),
    });
  });

  // ---- advertiser side ----

  app.post("/v1/campaigns", (req, res) => {
    const body = CreateCampaign.parse(req.body);
    // Signed-in creators get the campaign bound to their wallet (manageable
    // from any browser) and inherit the account's board name; bare API
    // callers (agents) pass an advertiser wallet and keep the manage key.
    const owner = sessionWallet(req);
    const advertiser = body.advertiser ?? owner;
    if (!advertiser) {
      return void res.status(400).json({
        error: "advertiser is required — sign in with your wallet or pass an advertiser address",
      });
    }
    const { manageKey, ...campaign } = market.createCampaign({
      advertiser,
      label: body.label ?? (owner ? auth.getAdvertiser(owner)?.label : undefined) ?? undefined,
      message: body.message,
      url: body.url,
      bidPerBlockMicro: usdToMicro(body.bidPerBlockUsd),
      ownerWallet: owner ?? null,
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
  // Cancelled campaigns are removed from public surfaces; their owners can
  // still fetch them by id to track the refund.
  app.get("/v1/campaigns", (_req, res) => {
    res.json({
      campaigns: market
        .listCampaigns()
        .filter((c) => c.status !== "cancelled")
        .map(publicCampaign),
    });
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
    // The owner view carries the refund payout trail so a cancelled
    // campaign's withdrawal can be tracked to its on-chain tx.
    res.json(
      canManage(req, c.id)
        ? { ...ownCampaign(c), refunds: market.listCampaignPayouts(c.id) }
        : publicCampaign(c),
    );
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

  // Where a refund payout goes: the caller's explicit choice, falling back to
  // the wallet given at creation, then to the SIWE owner wallet. An explicit
  // refundTo must itself be valid — escrow is only ever returned in USDC,
  // never re-routed silently.
  const RefundBody = z.object({ refundTo: z.string().max(64).optional() }).default({});
  const refundWallet = (c: Campaign, refundTo?: string): string | undefined => {
    if (refundTo) return isEvmAddress(refundTo) ? refundTo : undefined;
    return [c.advertiser, c.owner_wallet ?? ""].find(isEvmAddress);
  };

  // Cancel is terminal: the campaign leaves the board for good and any
  // unspent escrow is withdrawn back to the advertiser in the same call.
  app.post("/v1/campaigns/:id/cancel", asyncRoute(async (req, res) => {
    if (!canManage(req, req.params.id)) {
      return void res.status(403).json({ error: "manage key or admin token required" });
    }
    const body = RefundBody.parse(req.body ?? undefined);
    const existing = market.getCampaign(req.params.id);
    if (!existing) return void res.status(404).json({ error: "campaign not found" });

    const remaining = market.remainingMicro(existing);
    const to = remaining > 0 ? refundWallet(existing, body.refundTo) : undefined;
    if (remaining > 0 && !to) {
      return void res.status(400).json({
        error:
          "refundTo must be a 0x-prefixed EVM address to receive the unspent budget (the advertiser field is not a wallet)",
      });
    }

    const campaign = market.cancelCampaign(existing.id);
    let refund: (Payout & { error?: string }) | null = null;
    if (remaining > 0 && to) {
      const payout = market.requestRefund(campaign.id, to);
      const result = await executePayout(cfg, market, payout.id, to, payout.amount_micro);
      refund = { ...payout, status: result.status, tx: result.tx ?? payout.tx, error: result.error };
    }
    res.json({ campaign: ownCampaign(market.getCampaign(campaign.id)!), refund });
  }));

  // Withdraw what's left of a cancelled campaign's escrow — the retry path
  // when the cancel-time refund failed terminally or was skipped.
  app.post("/v1/campaigns/:id/withdraw", asyncRoute(async (req, res) => {
    if (!canManage(req, req.params.id)) {
      return void res.status(403).json({ error: "manage key or admin token required" });
    }
    const body = RefundBody.parse(req.body ?? undefined);
    const c = market.getCampaign(req.params.id);
    if (!c) return void res.status(404).json({ error: "campaign not found" });
    const to = refundWallet(c, body.refundTo);
    if (!to) {
      return void res
        .status(400)
        .json({ error: "refundTo must be a 0x-prefixed EVM address" });
    }
    const payout = market.requestRefund(c.id, to);
    const result = await executePayout(cfg, market, payout.id, to, payout.amount_micro);
    res.status(201).json({
      payout: { ...payout, ...result },
      campaign: ownCampaign(market.getCampaign(c.id)!),
    });
  }));

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
    const winner = market.pickServe();
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

  app.post("/v1/publishers/:wallet/payouts", asyncRoute(async (req, res) => {
    const wallet = req.params.wallet;
    if (!isEvmAddress(wallet)) {
      return void res.status(400).json({ error: "wallet must be a 0x-prefixed EVM address" });
    }
    const payout = market.requestPayout(wallet);
    const result = await executePayout(cfg, market, payout.id, wallet, payout.amount_micro);
    res.status(201).json({ payout: { ...payout, ...result } });
  }));

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
  app.post("/v1/admin/payouts/:id/retry", asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ result: await retryPayout(cfg, market, req.params.id) });
  }));

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

  // ---- Farcaster Mini App manifest ----
  // Lets Farcaster clients discover and embed the console as a Mini App. The
  // console (console.html) is the launch surface; it speaks the Mini App SDK
  // and uses the host wallet when run inside a Farcaster client. Domain
  // ownership is proved by FARCASTER_ACCOUNT_ASSOCIATION (a JSON object signed
  // for the deployed domain via the Farcaster manifest tool); omitted when
  // unset so the manifest still serves for local/preview use.
  app.get("/.well-known/farcaster.json", (_req, res) => {
    const base = cfg.publicUrl;
    const miniapp = {
      version: "1",
      name: "Codevertise",
      iconUrl: `${base}/apple-touch-icon.png`,
      homeUrl: `${base}/console.html`,
      imageUrl: `${base}/og-image.png`,
      buttonTitle: "Open console",
      splashImageUrl: `${base}/apple-touch-icon.png`,
      splashBackgroundColor: "#0b0e14",
      subtitle: "Rent the AI agent's status line",
      description:
        "Fund sponsored lines on AI coding-agent surfaces, paid in USDC over HTTP 402.",
      primaryCategory: "finance",
      tags: ["ads", "usdc", "x402", "base", "agents"],
    };
    let accountAssociation: unknown;
    if (process.env.FARCASTER_ACCOUNT_ASSOCIATION) {
      try {
        accountAssociation = JSON.parse(process.env.FARCASTER_ACCOUNT_ASSOCIATION);
      } catch {
        // Malformed env: serve the manifest without the (invalid) association
        // rather than 500. The domain just won't verify until it's fixed.
      }
    }
    res.json({
      ...(accountAssociation ? { accountAssociation } : {}),
      // `miniapp` is the current key; `frame` is the legacy alias some clients
      // still read. Both carry the same config.
      miniapp,
      frame: miniapp,
    });
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
