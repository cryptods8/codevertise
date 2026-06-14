export interface Config {
  port: number;
  /** PostgreSQL connection string (the primary datastore). When unset, the app
   *  falls back to an in-process pg-mem instance for tests / zero-config dev. */
  databaseUrl?: string;
  /** "mock" runs the marketplace without a chain; "x402" enforces real USDC payments. */
  paymentsMode: "mock" | "x402";
  /** CAIP-2 network for x402 payments. Base Sepolia by default. */
  network: string;
  /** Public origin the app is served from (no trailing slash). Used to build
   *  absolute URLs in the Farcaster Mini App manifest. */
  publicUrl: string;
  /** Version identifier of the Terms of Service currently in effect. Embedded
   *  in the SIWE sign-in message so each advertiser cryptographically signs
   *  agreement to a specific version, and recorded against their account. */
  legalVersion: string;
  /** Address that receives advertiser deposits (the marketplace treasury). */
  payTo: string;
  facilitatorUrl: string;
  /** Optional treasury key; when set, publisher payouts are sent on-chain in USDC. */
  payoutPrivateKey?: string;

  // Marketplace economics (block-auction model)
  blockImpressions: number; // impressions per block
  minBidMicro: number; // minimum bid per block, micro-USD
  minBidIncrementMicro: number; // English-auction minimum raise
  clickMultiplier: number; // a click costs this many impressions
  publisherShare: number; // fraction of spend credited to the publisher
  minPayoutMicro: number; // payout threshold

  // Anti-fraud: every billable event must redeem a server-issued, single-use
  // serve token. These knobs govern issuance and redemption.
  /** HMAC key for signing serve tokens. Persisted in the DB if unset, so a
   *  restart doesn't invalidate tokens already in flight. Set in production. */
  eventSigningSecret?: string;
  /** View threshold: how long an ad must be on screen before it counts. */
  slotSeconds: number;
  /** How long a serve token stays redeemable after issuance. */
  tokenTtlSeconds: number;
  /** Per-IP token bucket on GET /v1/serve. */
  serveRatePerSec: number;
  serveBurst: number;
  /** Per-IP token bucket on POST /v1/events. */
  eventRatePerSec: number;
  eventBurst: number;
  /** Max clicks per (publisher, campaign) as a fraction of impressions (floor of 1). */
  clickRatio: number;

  /** Express `trust proxy` setting. Enable ONLY behind a reverse proxy you
   *  control — otherwise clients spoof X-Forwarded-For to dodge rate limits. */
  trustProxy: boolean | number | string;
  /** Bearer token enabling /v1/admin/* (moderation kill switch, payout ops). */
  adminToken?: string;
}

export const USD = 1_000_000; // micro-USD per dollar (matches USDC's 6 decimals)

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.PAYMENTS_MODE === "x402" ? "x402" : "mock";
  const publisherShare = Number(env.PUBLISHER_SHARE ?? 0.4);
  if (!(publisherShare >= 0 && publisherShare <= 1)) {
    throw new Error(`PUBLISHER_SHARE must be a fraction between 0 and 1, got ${env.PUBLISHER_SHARE}`);
  }

  // Boot-time guards: the failure modes here hand out money, so refuse to
  // start rather than serve with a dangerous combination.
  const payoutPrivateKey = env.PAYOUT_PRIVATE_KEY;
  if (mode === "mock" && payoutPrivateKey) {
    throw new Error(
      "refusing to start: PAYMENTS_MODE=mock with PAYOUT_PRIVATE_KEY set — " +
        "mock funding is free, so real on-chain payouts would drain the treasury. " +
        "Unset one of the two.",
    );
  }
  if (mode === "mock" && env.NODE_ENV === "production" && env.ALLOW_MOCK_PAYMENTS !== "1") {
    throw new Error(
      "refusing to start: PAYMENTS_MODE=mock in NODE_ENV=production " +
        "(anyone can fund campaigns for free). Set PAYMENTS_MODE=x402, or " +
        "ALLOW_MOCK_PAYMENTS=1 if this really is a demo deployment.",
    );
  }
  const payTo = env.PAY_TO_ADDRESS ?? ZERO_ADDRESS;
  if (mode === "x402") {
    if (!isEvmAddress(payTo) || payTo === ZERO_ADDRESS) {
      throw new Error(
        `PAYMENTS_MODE=x402 requires PAY_TO_ADDRESS to be a real treasury address, got "${payTo}"`,
      );
    }
  }
  if (payoutPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(payoutPrivateKey)) {
    throw new Error("PAYOUT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  }

  return {
    port: Number(env.PORT ?? 4021),
    databaseUrl: env.DATABASE_URL,
    paymentsMode: mode,
    network: env.X402_NETWORK ?? "eip155:84532",
    publicUrl: (env.PUBLIC_URL ?? "https://codevertise.dev").replace(/\/+$/, ""),
    legalVersion: env.LEGAL_VERSION ?? "2026-06-13.6",
    payTo,
    facilitatorUrl: env.FACILITATOR_URL ?? "https://facilitator.x402.org",
    payoutPrivateKey,
    blockImpressions: 1000,
    minBidMicro: 1 * USD,
    minBidIncrementMicro: USD / 2,
    clickMultiplier: 50,
    publisherShare,
    minPayoutMicro: 10 * USD,

    eventSigningSecret: env.EVENT_SIGNING_SECRET,
    slotSeconds: posInt(env.SLOT_SECONDS, 5),
    tokenTtlSeconds: posInt(env.TOKEN_TTL_SECONDS, 900),
    serveRatePerSec: posNum(env.SERVE_RATE_PER_SEC, 4),
    serveBurst: posInt(env.SERVE_BURST, 40),
    eventRatePerSec: posNum(env.EVENT_RATE_PER_SEC, 4),
    eventBurst: posInt(env.EVENT_BURST, 40),
    clickRatio: posNum(env.CLICK_RATIO, 0.05),

    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    adminToken: env.ADMIN_TOKEN,
  };
}

/** TRUST_PROXY: unset/"false" → off, "true" → on, a number → hop count,
 *  anything else → passed through to Express (e.g. "loopback"). */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : raw;
}

function posNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!(n > 0)) throw new Error(`expected a positive number, got ${raw}`);
  return n;
}

function posInt(raw: string | undefined, fallback: number): number {
  const n = posNum(raw, fallback);
  if (!Number.isInteger(n)) throw new Error(`expected a positive integer, got ${raw}`);
  return n;
}

export function formatUsd(micro: number): string {
  return `$${(micro / USD).toFixed(micro % 10_000 === 0 ? 2 : 6)}`;
}

export function usdToMicro(usd: number): number {
  return Math.round(usd * USD);
}
