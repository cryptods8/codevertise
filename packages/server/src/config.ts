export interface Config {
  port: number;
  dbPath: string;
  /** "mock" runs the marketplace without a chain; "x402" enforces real USDC payments. */
  paymentsMode: "mock" | "x402";
  /** CAIP-2 network for x402 payments. Base Sepolia by default. */
  network: string;
  /** Address that receives advertiser deposits (the marketplace treasury). */
  payTo: string;
  facilitatorUrl: string;
  /** Optional treasury key; when set, publisher payouts are sent on-chain in USDC. */
  payoutPrivateKey?: string;

  // Marketplace economics (kickbacks.ai-style block model)
  blockImpressions: number; // impressions per block
  minBidMicro: number; // minimum bid per block, micro-USD
  minBidIncrementMicro: number; // English-auction minimum raise
  clickMultiplier: number; // a click costs this many impressions
  publisherShare: number; // fraction of spend credited to the publisher
  minPayoutMicro: number; // payout threshold
}

export const USD = 1_000_000; // micro-USD per dollar (matches USDC's 6 decimals)

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.PAYMENTS_MODE === "x402" ? "x402" : "mock";
  return {
    port: Number(env.PORT ?? 4021),
    dbPath: env.DB_PATH ?? "codevertise.db",
    paymentsMode: mode,
    network: env.X402_NETWORK ?? "eip155:84532",
    payTo: env.PAY_TO_ADDRESS ?? "0x0000000000000000000000000000000000000000",
    facilitatorUrl: env.FACILITATOR_URL ?? "https://facilitator.x402.org",
    payoutPrivateKey: env.PAYOUT_PRIVATE_KEY,
    blockImpressions: 1000,
    minBidMicro: 1 * USD,
    minBidIncrementMicro: USD / 2,
    clickMultiplier: 50,
    publisherShare: 0.5,
    minPayoutMicro: 10 * USD,
  };
}

export function formatUsd(micro: number): string {
  return `$${(micro / USD).toFixed(micro % 10_000 === 0 ? 2 : 6)}`;
}

export function usdToMicro(usd: number): number {
  return Math.round(usd * USD);
}
