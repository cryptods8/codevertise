import express, { type Express, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { z } from "zod";
import { AdvertiserAuth, SESSION_COOKIE, SESSION_TTL_MS } from "./auth.js";
import { isEvmAddress, USD, usdToMicro, type Config } from "./config.js";
import type { Advertiser, Campaign, Payout, Report } from "./db.js";
import { MarketError, type Marketplace } from "./marketplace.js";
import { buildFundingPaywall, describePrice, fundingPriceMicro } from "./payments.js";
import { executePayout, retryPayout } from "./payouts.js";
import { Pacer, RateLimiter } from "./ratelimit.js";
import { signToken, verifyToken, type ServeToken } from "./tokens.js";

const RaiseBid = z.object({ bidPerBlockUsd: z.number().positive() });

// Farcaster domain-ownership proof for the Mini App manifest, signed for
// codevertise.dev. Override with FARCASTER_ACCOUNT_ASSOCIATION (the same JSON
// shape) when serving from a different domain.
const DEFAULT_ACCOUNT_ASSOCIATION = {
  header:
    "eyJmaWQiOjExMTI0LCJ0eXBlIjoiYXV0aCIsImtleSI6IjB4YzI5MjZBMzlkMGQ4OGQ0YzFCMjI3RGVCOTMzMDIyRjE0OTJlODE4QyJ9",
  payload: "eyJkb21haW4iOiJjb2RldmVydGlzZS5kZXYifQ",
  signature: "JTBgqjzTQTgOhc+HWZQjlYA54vdFOu3kLNfefoqP4dUYK2P+12rsbtWcZ9gsyfBX5aKwZnfNWWAG5OSMJriVvhs=",
};

function accountAssociation(): unknown {
  const env = process.env.FARCASTER_ACCOUNT_ASSOCIATION;
  if (env) {
    try {
      return JSON.parse(env);
    } catch {
      // Malformed override: fall back to the baked-in proof rather than 500.
    }
  }
  return DEFAULT_ACCOUNT_ASSOCIATION;
}

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
    termsVersion: adv.terms_version,
    termsAcceptedAt: adv.terms_accepted_at,
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
  // The session token arrives as the HttpOnly cookie in a normal browser, but
  // inside an embedded webview (Farcaster Mini App) the page's top-level site
  // is the host app, so the cookie is third-party and often dropped entirely.
  // The client mirrors the token in an X-Session-Token header for that case.
  const SESSION_HEADER = "x-session-token";
  const sessionToken = (req: Request): string | undefined =>
    cookieValue(req, SESSION_COOKIE) ?? req.header(SESSION_HEADER) ?? undefined;
  const sessionWallet = (req: Request): Promise<string | undefined> =>
    auth.sessionWallet(sessionToken(req));

  /** Campaign-owner gate: manage key, signed-in owner wallet, or admin token. */
  const canManage = async (req: Request, campaignId: string): Promise<boolean> => {
    if (isAdmin(req)) return true;
    if (await market.verifyManageKey(campaignId, manageKeyFrom(req))) return true;
    const wallet = await sessionWallet(req);
    return !!wallet && (await market.getCampaign(campaignId))?.owner_wallet === wallet;
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
  const secret = await market.signingSecret();
  const serveLimiter = new RateLimiter(cfg.serveRatePerSec, cfg.serveBurst);
  const eventLimiter = new RateLimiter(cfg.eventRatePerSec, cfg.eventBurst);
  const minViewMs = Math.floor(cfg.slotSeconds * 1000 * 0.9); // tolerate timer jitter
  const servePacer = new Pacer(minViewMs);
  const tokenTtlMs = cfg.tokenTtlSeconds * 1000;

  app.get("/healthz", asyncRoute(async (_req, res) => {
    try {
      await market.winner(); // exercises the DB
      res.json({ ok: true, mode: cfg.paymentsMode, uptimeSec: Math.floor(process.uptime()) });
    } catch (err) {
      res.status(503).json({ ok: false, error: String(err) });
    }
  }));

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
      legal: {
        version: cfg.legalVersion,
        termsUrl: `${cfg.publicUrl}/terms.html`,
        privacyUrl: `${cfg.publicUrl}/privacy.html`,
        acceptableUseUrl: `${cfg.publicUrl}/terms.html#8`,
        // DSA Art. 16 notice-and-action: report illegal/infringing content.
        reportContent:
          "POST /v1/reports {campaignId?, reason, details, reporter?} or email abuse@codevertise.dev",
        // Programmatic/agent advertisers accept the Terms by using the API; the
        // console binds human advertisers via the signed SIWE message.
        acceptance:
          "By accessing this API or funding a campaign you agree to the Terms of Service and Acceptable Use Policy at the URLs above. You are responsible for any agent you deploy.",
      },
      howToBid: [
        "POST /v1/campaigns {advertiser, message, url, bidPerBlockUsd} — response includes your one-time manage key",
        "POST /v1/fund?campaign=<id>&blocks=<n>  — returns 402; pay via x402 to settle",
        "POST /v1/campaigns/:id/bid {bidPerBlockUsd} + X-Manage-Key — raise to outrank competitors",
        "GET  /v1/auction — see the board you are bidding against",
        "Using this API constitutes acceptance of the Terms at legal.termsUrl.",
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

  // Over HTTPS, mark the cookie SameSite=None;Secure so it survives the
  // cross-site embedding of a Mini App webview; on plain-HTTP local dev fall
  // back to Lax (browsers reject SameSite=None without Secure). Detect TLS via
  // req.secure (when trust-proxy is on) or the proxy's X-Forwarded-Proto.
  const isHttps = (req: Request): boolean =>
    req.secure || req.headers["x-forwarded-proto"] === "https";
  const sessionCookieOpts = (req: Request) =>
    isHttps(req)
      ? ({ httpOnly: true, sameSite: "none", secure: true, path: "/" } as const)
      : ({ httpOnly: true, sameSite: "lax", secure: false, path: "/" } as const);

  // Step 1: the server authors the exact EIP-4361 message to sign. The
  // challenge is bound to the address and expires in minutes.
  app.get("/v1/auth/nonce", (req, res) => {
    if (!authAllowed(req, res)) return;
    const address = String(req.query.address ?? "");
    if (!isEvmAddress(address)) {
      return void res.status(400).json({ error: "address must be a 0x-prefixed EVM address" });
    }
    const domain = req.headers.host ?? "localhost";
    res.json(
      auth.issueChallenge({
        address,
        domain,
        uri: `${req.protocol}://${domain}`,
        termsVersion: cfg.legalVersion,
        termsUrl: `${cfg.publicUrl}/terms.html`,
        privacyUrl: `${cfg.publicUrl}/privacy.html`,
      }),
    );
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
    const verified = await auth.verifyChallenge(body.nonce, body.signature);
    if (!verified) {
      return void res.status(401).json({ error: "signature verification failed — request a fresh nonce and retry" });
    }
    const { wallet, termsVersion } = verified;
    // The signed message bound the wallet to this Terms version — record it as
    // durable, per-account proof of acceptance.
    const advertiser = await auth.recordTermsAcceptance(wallet, termsVersion);
    const session = await auth.createSession(wallet);
    res.cookie(SESSION_COOKIE, session.token, {
      ...sessionCookieOpts(req),
      maxAge: SESSION_TTL_MS,
    });
    // Also hand the token back in the body so an embedded webview (where the
    // cookie may be blocked) can replay it via the X-Session-Token header.
    res.json({ ...accountView(advertiser), token: session.token });
  }));

  app.get("/v1/auth/session", asyncRoute(async (req, res) => {
    const wallet = await sessionWallet(req);
    if (!wallet) return void res.json({ signedIn: false });
    res.json(accountView(await auth.ensureAdvertiser(wallet)));
  }));

  app.post("/v1/auth/logout", asyncRoute(async (req, res) => {
    const token = sessionToken(req);
    if (token) await auth.deleteSession(token);
    res.clearCookie(SESSION_COOKIE, sessionCookieOpts(req));
    res.json({ signedIn: false });
  }));

  /** 401-or-wallet gate for the signed-in account surface. */
  const requireSession = async (req: Request, res: Response): Promise<string | undefined> => {
    const wallet = await sessionWallet(req);
    if (!wallet) res.status(401).json({ error: "sign in with your wallet first" });
    return wallet;
  };

  // Account settings. The board name lives on the account and is applied to
  // the account's campaigns; the signed-in wallet doubles as the refund
  // destination, so no separate "advertiser wallet" setting exists.
  const AccountBody = z.object({ label: z.string().trim().min(1).max(32) });
  app.put("/v1/account", asyncRoute(async (req, res) => {
    const wallet = await requireSession(req, res);
    if (!wallet) return;
    const body = AccountBody.parse(req.body);
    const advertiser = await auth.saveSettings(wallet, body.label);
    await market.relabelOwnedCampaigns(wallet, body.label);
    res.json(accountView(advertiser));
  }));

  // The cross-browser "my campaigns" list: owner views (with refund trails)
  // of every campaign this wallet created while signed in.
  app.get("/v1/me/campaigns", asyncRoute(async (req, res) => {
    const wallet = await requireSession(req, res);
    if (!wallet) return;
    const owned = await market.listCampaignsByOwner(wallet);
    res.json({
      campaigns: await Promise.all(
        owned.map(async (c) => ({
          ...ownCampaign(c),
          refunds: await market.listCampaignPayouts(c.id),
        })),
      ),
    });
  }));

  // ---- advertiser side ----

  app.post("/v1/campaigns", asyncRoute(async (req, res) => {
    const body = CreateCampaign.parse(req.body);
    // Signed-in creators get the campaign bound to their wallet (manageable
    // from any browser) and inherit the account's board name; bare API
    // callers (agents) pass an advertiser wallet and keep the manage key.
    const owner = await sessionWallet(req);
    const advertiser = body.advertiser ?? owner;
    if (!advertiser) {
      return void res.status(400).json({
        error: "advertiser is required — sign in with your wallet or pass an advertiser address",
      });
    }
    const { manageKey, ...campaign } = await market.createCampaign({
      advertiser,
      label: body.label ?? (owner ? (await auth.getAdvertiser(owner))?.label : undefined) ?? undefined,
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
  }));

  // Listing is public and wallet-free. Campaign management and stats are
  // keyed by the per-campaign manage key, not by knowing a wallet address.
  // Cancelled campaigns are removed from public surfaces; their owners can
  // still fetch them by id to track the refund.
  app.get("/v1/campaigns", asyncRoute(async (_req, res) => {
    const all = await market.listCampaigns();
    res.json({
      campaigns: all.filter((c) => c.status !== "cancelled").map(publicCampaign),
    });
  }));

  app.get("/v1/campaigns/:id/stats", asyncRoute(async (req, res) => {
    if (!(await canManage(req, req.params.id))) {
      return void res.status(403).json({ error: "manage key required" });
    }
    res.json(await market.campaignStats(req.params.id));
  }));

  app.get("/v1/campaigns/:id", asyncRoute(async (req, res) => {
    const c = await market.getCampaign(req.params.id);
    if (!c) return void res.status(404).json({ error: "campaign not found" });
    // The owner view carries the refund payout trail so a cancelled
    // campaign's withdrawal can be tracked to its on-chain tx.
    res.json(
      (await canManage(req, c.id))
        ? { ...ownCampaign(c), refunds: await market.listCampaignPayouts(c.id) }
        : publicCampaign(c),
    );
  }));

  app.post("/v1/campaigns/:id/bid", asyncRoute(async (req, res) => {
    if (!(await canManage(req, req.params.id))) {
      return void res.status(403).json({ error: "manage key required to raise this campaign's bid" });
    }
    const body = RaiseBid.parse(req.body);
    const campaign = await market.raiseBid(req.params.id, usdToMicro(body.bidPerBlockUsd));
    res.json({ campaign: ownCampaign(campaign) });
  }));

  // Kill switch: the owner (manage key) or the operator (admin token) can
  // take a campaign off the board; paused campaigns never serve.
  app.post("/v1/campaigns/:id/pause", asyncRoute(async (req, res) => {
    if (!(await canManage(req, req.params.id))) {
      return void res.status(403).json({ error: "manage key or admin token required" });
    }
    res.json({ campaign: ownCampaign(await market.setCampaignStatus(req.params.id, "paused")) });
  }));

  app.post("/v1/campaigns/:id/resume", asyncRoute(async (req, res) => {
    if (!(await canManage(req, req.params.id))) {
      return void res.status(403).json({ error: "manage key or admin token required" });
    }
    res.json({ campaign: ownCampaign(await market.setCampaignStatus(req.params.id, "active")) });
  }));

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
    if (!(await canManage(req, req.params.id))) {
      return void res.status(403).json({ error: "manage key or admin token required" });
    }
    const body = RefundBody.parse(req.body ?? undefined);
    const existing = await market.getCampaign(req.params.id);
    if (!existing) return void res.status(404).json({ error: "campaign not found" });

    const remaining = market.remainingMicro(existing);
    const to = remaining > 0 ? refundWallet(existing, body.refundTo) : undefined;
    if (remaining > 0 && !to) {
      return void res.status(400).json({
        error:
          "refundTo must be a 0x-prefixed EVM address to receive the unspent budget (the advertiser field is not a wallet)",
      });
    }

    const campaign = await market.cancelCampaign(existing.id);
    let refund: (Payout & { error?: string }) | null = null;
    if (remaining > 0 && to) {
      const payout = await market.requestRefund(campaign.id, to);
      const result = await executePayout(cfg, market, payout.id, to, payout.amount_micro);
      refund = { ...payout, status: result.status, tx: result.tx ?? payout.tx, error: result.error };
    }
    res.json({ campaign: ownCampaign((await market.getCampaign(campaign.id))!), refund });
  }));

  // Withdraw what's left of a cancelled campaign's escrow — the retry path
  // when the cancel-time refund failed terminally or was skipped.
  app.post("/v1/campaigns/:id/withdraw", asyncRoute(async (req, res) => {
    if (!(await canManage(req, req.params.id))) {
      return void res.status(403).json({ error: "manage key or admin token required" });
    }
    const body = RefundBody.parse(req.body ?? undefined);
    const c = await market.getCampaign(req.params.id);
    if (!c) return void res.status(404).json({ error: "campaign not found" });
    const to = refundWallet(c, body.refundTo);
    if (!to) {
      return void res
        .status(400)
        .json({ error: "refundTo must be a 0x-prefixed EVM address" });
    }
    const payout = await market.requestRefund(c.id, to);
    const result = await executePayout(cfg, market, payout.id, to, payout.amount_micro);
    res.status(201).json({
      payout: { ...payout, ...result },
      campaign: ownCampaign((await market.getCampaign(c.id))!),
    });
  }));

  app.get("/v1/auction", asyncRoute(async (_req, res) => {
    res.json({ board: await market.auctionState() });
  }));

  // ---- content reports (DSA Art. 16 notice-and-action) ----
  // Public, rate-limited intake so anyone can report illegal/infringing
  // content. Notices land in a durable queue the operator reviews via the
  // admin surface — the takedown channel doesn't depend on watching an inbox.
  const reportLimiter = new RateLimiter(1, 10);
  const ReportBody = z.object({
    campaignId: z.string().trim().max(64).optional(),
    reason: z.enum(["illegal", "ip", "fraud", "malware", "deceptive", "other"]),
    details: z.string().trim().min(1).max(4000),
    reporter: z.string().trim().max(200).optional(),
  });
  app.post("/v1/reports", asyncRoute(async (req, res) => {
    if (!reportLimiter.allow(clientIp(req), Date.now())) {
      return void res.status(429).json({ error: "rate limit exceeded" });
    }
    const body = ReportBody.parse(req.body);
    const report = await market.createReport({
      campaignId: body.campaignId ?? null,
      reason: body.reason,
      details: body.details,
      reporter: body.reporter ?? null,
    });
    // Acknowledge with the id only — don't echo the queue back to the public.
    res.status(201).json({ id: report.id, status: report.status });
  }));

  // The one paid route. On the mock rail the middleware marks the request
  // settled and the handler credits escrow. On the x402 rail the credit
  // happens in the onAfterSettle hook (see payments.ts) — settlement runs
  // after this handler, and a failed settlement discards this response.
  const paywall = await buildFundingPaywall(cfg, market);
  app.post("/v1/fund", paywall, asyncRoute(async (req, res) => {
    const campaignId = String(req.query.campaign ?? "");
    const blocks = Number(req.query.blocks ?? 1);
    const amountMicro = await fundingPriceMicro(market, campaignId, String(blocks));

    if (cfg.paymentsMode === "mock") {
      const settled = req.settledPayment ?? { payer: "unknown", rail: "mock" as const };
      const { campaign, payment } = await market.fundCampaign({
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
  }));

  // ---- publisher side ----

  app.get("/v1/serve", asyncRoute(async (req, res) => {
    const now = Date.now();
    if (!serveLimiter.allow(clientIp(req), now)) {
      return void res.status(429).json({ error: "rate limit exceeded" });
    }
    const winner = await market.pickServe();
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
  }));

  app.post("/v1/events", asyncRoute(async (req, res) => {
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
      if (!(await market.hasEvent(tok.jti))) {
        return void res
          .status(409)
          .json({ error: "click without a counted impression", recorded: false });
      }
      // …and clicks bill at 50× an impression, so they are capped to a
      // plausible click-through ratio per (publisher, campaign). The floor of
      // one click keeps a brand-new surface usable.
      const counts = await market.publisherCampaignCounts(tok.publisher, tok.campaignId);
      const allowed = Math.max(1, Math.floor(counts.impressions * cfg.clickRatio));
      if (counts.clicks >= allowed) {
        return void res.status(429).json({
          error: `click ratio exceeded (${counts.clicks} clicks over ${counts.impressions} impressions)`,
          recorded: false,
        });
      }
    }

    const event = await market.recordEvent({
      key: body.type === "impression" ? tok.jti : `${tok.jti}#click`,
      type: body.type,
      campaignId: tok.campaignId,
      publisher: tok.publisher,
      surface: tok.surface,
    });
    if (!event) return void res.status(200).json({ recorded: false, reason: "duplicate or exhausted budget" });
    res.status(201).json({ recorded: true, earnedMicro: event.publisher_micro });
  }));

  app.get("/v1/publishers/:wallet", asyncRoute(async (req, res) => {
    const p = await market.getPublisher(req.params.wallet);
    res.json({
      wallet: p.wallet,
      earnedMicro: p.earned_micro,
      paidMicro: p.paid_micro,
      withdrawableMicro: await market.balanceMicro(p.wallet),
      minPayoutMicro: cfg.minPayoutMicro,
      payouts: await market.listPayouts(p.wallet),
    });
  }));

  app.post("/v1/publishers/:wallet/payouts", asyncRoute(async (req, res) => {
    const wallet = req.params.wallet;
    if (!isEvmAddress(wallet)) {
      return void res.status(400).json({ error: "wallet must be a 0x-prefixed EVM address" });
    }
    const payout = await market.requestPayout(wallet);
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

  // Operator dashboard summary: headline counts the admin console renders at
  // the top so the queue depth is visible at a glance.
  app.get("/v1/admin/overview", asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [campaigns, board, openReports, queuedPayouts, submittedPayouts] = await Promise.all([
      market.listCampaigns(),
      market.auctionState(),
      market.openReportCount(),
      market.listAllPayouts("queued"),
      market.listAllPayouts("submitted"),
    ]);
    res.json({
      mode: cfg.paymentsMode,
      network: cfg.network,
      campaigns: {
        total: campaigns.length,
        active: campaigns.filter((c) => c.status === "active").length,
        paused: campaigns.filter((c) => c.status === "paused").length,
        cancelled: campaigns.filter((c) => c.status === "cancelled").length,
        serving: board.filter((b) => b.serving).length,
      },
      reports: { open: openReports },
      payouts: { queued: queuedPayouts.length, submitted: submittedPayouts.length },
    });
  }));

  // Full campaign list for moderation — unlike the public board this exposes
  // the advertiser/owner wallets and every status (paused, cancelled too) so
  // the operator can act on a reported campaign.
  app.get("/v1/admin/campaigns", asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status =
      typeof req.query.status === "string" ? (req.query.status as Campaign["status"]) : undefined;
    let campaigns = await market.listCampaigns();
    if (status) campaigns = campaigns.filter((c) => c.status === status);
    res.json({
      campaigns: campaigns.map((c) => ({
        ...ownCampaign(c),
        advertiser: c.advertiser,
        ownerWallet: c.owner_wallet,
        remainingMicro: market.remainingMicro(c),
        serving: c.status === "active" && c.activated_at !== null,
      })),
    });
  }));

  app.get("/v1/admin/payouts", asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = typeof req.query.status === "string" ? (req.query.status as Payout["status"]) : undefined;
    res.json({ payouts: await market.listAllPayouts(status) });
  }));

  // Retry a queued payout (re-send) or reconcile a submitted one against its
  // recorded tx. Never re-sends a payout that has a tx hash.
  app.post("/v1/admin/payouts/:id/retry", asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ result: await retryPayout(cfg, market, req.params.id) });
  }));

  // Operator decision: give up on a payout and refund the publisher balance.
  // Refuse when a tx was broadcast and not yet proven reverted.
  app.post("/v1/admin/payouts/:id/fail", asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const payout = await market.getPayout(req.params.id);
    if (!payout) return void res.status(404).json({ error: "payout not found" });
    if (payout.status === "submitted" && req.query.force !== "1") {
      return void res.status(409).json({
        error:
          "payout has a broadcast tx; reconcile with /retry first, or pass ?force=1 if the tx is provably dead",
      });
    }
    await market.resolvePayout(payout.id, "failed");
    res.json({ payout: await market.getPayout(payout.id) });
  }));

  // The operator's notice-and-action review queue. Filter by ?status=open to
  // see what's awaiting a decision.
  app.get("/v1/admin/reports", asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status =
      typeof req.query.status === "string" ? (req.query.status as Report["status"]) : undefined;
    res.json({ reports: await market.listReports(status), openCount: await market.openReportCount() });
  }));

  // Record the operator's decision on a report. "actioned" documents that the
  // reported content was removed or restricted (do the removal via the campaign
  // kill switch / pause / cancel); "dismissed" closes it as not actionable.
  const ResolveReportBody = z.object({
    status: z.enum(["actioned", "dismissed"]),
    resolution: z.string().trim().max(2000).optional(),
  });
  app.post("/v1/admin/reports/:id/resolve", asyncRoute(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = ResolveReportBody.parse(req.body);
    const report = await market.resolveReport(req.params.id, body.status, body.resolution);
    if (!report) return void res.status(404).json({ error: "report not found" });
    res.json({ report });
  }));

  // ---- Farcaster Mini App manifest ----
  // Lets Farcaster clients discover and embed the console as a Mini App. The
  // console (console.html) is the launch surface; it speaks the Mini App SDK
  // and uses the host wallet when run inside a Farcaster client.
  app.get("/.well-known/farcaster.json", (_req, res) => {
    const base = cfg.publicUrl;
    const miniapp = {
      version: "1",
      name: "Codevertise",
      iconUrl: `${base}/apple-touch-icon.png`,
      homeUrl: `${base}/console.html`,
      // Embed/preview image must be 3:2 (1200x800) — a dedicated card, not the
      // 1.91:1 OpenGraph image.
      imageUrl: `${base}/miniapp-preview.png`,
      buttonTitle: "Open console",
      splashImageUrl: `${base}/apple-touch-icon.png`,
      splashBackgroundColor: "#0b0e14",
      subtitle: "The AI agent's status line", // ≤30 chars (Farcaster limit)
      description:
        "Fund sponsored lines on AI coding-agent surfaces, paid in USDC over HTTP 402.",
      primaryCategory: "finance",
      tags: ["ads", "usdc", "x402", "base", "agents"],
    };
    res.json({
      // Domain-ownership proof. Defaults to the signed proof for
      // codevertise.dev; override with FARCASTER_ACCOUNT_ASSOCIATION (JSON) when
      // serving another domain.
      accountAssociation: accountAssociation(),
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
