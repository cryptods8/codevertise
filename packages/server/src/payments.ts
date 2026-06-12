import type { NextFunction, Request, RequestHandler, Response } from "express";
import { USD, type Config } from "./config.js";
import type { Marketplace } from "./marketplace.js";

/**
 * Payment rails for the paid endpoint `POST /v1/fund?campaign=..&blocks=N`.
 *
 * - "x402": real HTTP-402 flow (Coinbase x402 v2). The middleware returns 402
 *   with PaymentRequired, the client retries with PAYMENT-SIGNATURE, and a
 *   facilitator verifies/settles USDC on the configured network.
 * - "mock": same marketplace semantics without a chain. A request carrying
 *   `X-Mock-Payment: <payer-address>` is treated as settled; anything else
 *   gets a 402 whose JSON mirrors the x402 shape so client code paths match.
 *
 * MPP (Machine Payments Protocol, Stripe/Tempo) is the same 402 pattern; a
 * third rail can register the `mppx` middleware on this route without touching
 * marketplace logic.
 */

export interface SettledPayment {
  payer: string;
  rail: "x402" | "mock";
  tx?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      settledPayment?: SettledPayment;
    }
  }
}

/** Price of a funding request: blocks × the campaign's own bid-per-block. */
export function fundingPriceMicro(
  market: Marketplace,
  campaignId: string | undefined,
  blocksRaw: string | undefined,
): number {
  const blocks = Number(blocksRaw ?? 1);
  if (!campaignId) throw badRequest("campaign query param is required");
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > 1000) {
    throw badRequest("blocks must be an integer in 1..1000");
  }
  const c = market.getCampaign(campaignId);
  if (!c) throw badRequest(`campaign ${campaignId} not found`);
  return c.bid_per_block_micro * blocks;
}

function badRequest(message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

export async function buildFundingPaywall(
  cfg: Config,
  market: Marketplace,
): Promise<RequestHandler> {
  if (cfg.paymentsMode === "mock") return mockPaywall(cfg, market);
  return x402Paywall(cfg, market);
}

// ---- mock rail ----

function mockPaywall(cfg: Config, market: Marketplace): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    let priceMicro: number;
    try {
      priceMicro = fundingPriceMicro(
        market,
        req.query.campaign as string | undefined,
        req.query.blocks as string | undefined,
      );
    } catch (e) {
      const err = e as Error & { status?: number };
      res.status(err.status ?? 400).json({ error: err.message });
      return;
    }

    const payer = req.header("x-mock-payment");
    if (!payer) {
      // Mirrors the x402 402 envelope closely enough for demo clients.
      res.status(402).json({
        x402Version: 2,
        error: "payment required",
        accepts: [
          {
            scheme: "exact",
            network: cfg.network,
            amount: String(priceMicro),
            asset: "USDC",
            payTo: cfg.payTo,
            description: "Fund a Codevertise campaign (mock rail — send X-Mock-Payment: <your-address>)",
          },
        ],
      });
      return;
    }
    req.settledPayment = { payer, rail: "mock" };
    next();
  };
}

// ---- x402 rail ----

/**
 * Minimal structural view of the x402 settle-hook context: enough to read the
 * funding request's query params, the settled tx, and the authoritative payer.
 */
interface SettleHookContext {
  transportContext?: {
    request?: {
      path?: string;
      adapter?: { getQueryParam?(name: string): string | string[] | undefined };
    };
  };
  result?: { payer?: string; transaction?: string };
  paymentPayload?: { payload?: Record<string, unknown> };
}

/** Payer from the verified payment payload (EVM "exact" carries the EIP-3009
 *  authorization). Falls back to the facilitator-reported payer. */
export function payerFromSettlement(ctx: SettleHookContext): string | undefined {
  if (ctx.result?.payer) return ctx.result.payer;
  const payload = ctx.paymentPayload?.payload as
    | { authorization?: { from?: string }; signature?: { from?: string } }
    | undefined;
  return payload?.authorization?.from ?? payload?.signature?.from;
}

/**
 * The x402 middleware settles AFTER the route handler runs (it buffers the
 * response and discards it when settlement fails). Escrow is therefore
 * credited HERE, at settlement time — never in the route handler — so:
 *   - a failed settlement credits nothing,
 *   - the ledger row carries the facilitator's payer and on-chain tx hash.
 * Exported for tests.
 */
export function creditSettledFunding(market: Marketplace, ctx: SettleHookContext): void {
  const request = ctx.transportContext?.request;
  if (request?.path !== "/v1/fund") return; // only one paid route today
  const adapter = request.adapter;
  const q = (name: string) => {
    const v = adapter?.getQueryParam?.(name);
    return Array.isArray(v) ? v[0] : v;
  };
  const campaignId = q("campaign");
  const amountMicro = fundingPriceMicro(market, campaignId, q("blocks"));
  const tx = ctx.result?.transaction;
  market.fundCampaign({
    campaignId: campaignId as string,
    payer: payerFromSettlement(ctx) ?? "unknown",
    amountMicro,
    rail: "x402",
    tx,
  });
  console.log(
    JSON.stringify({ evt: "funding_settled", campaignId, amountMicro, tx, rail: "x402" }),
  );
}

async function x402Paywall(cfg: Config, market: Marketplace): Promise<RequestHandler> {
  const [{ paymentMiddleware, x402ResourceServer }, { HTTPFacilitatorClient }, { ExactEvmScheme }] =
    await Promise.all([
      import("@x402/express"),
      import("@x402/core/server"),
      import("@x402/evm/exact/server"),
    ]);

  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(
    cfg.network as never,
    new ExactEvmScheme(),
  );

  server.onAfterSettle(async (ctx) => {
    try {
      creditSettledFunding(market, ctx as unknown as SettleHookContext);
    } catch (err) {
      // USDC moved but the ledger credit failed — surface it on both sides
      // and leave a reconciliation trail keyed by the tx hash.
      console.error(
        JSON.stringify({
          evt: "settled_funding_credit_error",
          tx: (ctx as unknown as SettleHookContext).result?.transaction,
          err: String(err),
        }),
      );
      throw err;
    }
  });

  const middleware = paymentMiddleware(
    {
      "POST /v1/fund": {
        accepts: {
          scheme: "exact",
          network: cfg.network as never,
          payTo: cfg.payTo,
          // Price depends on the campaign's current bid and requested blocks.
          price: (ctx) => {
            const q = (name: string) => {
              const v = ctx.adapter.getQueryParam?.(name);
              return Array.isArray(v) ? v[0] : v;
            };
            const micro = fundingPriceMicro(market, q("campaign"), q("blocks"));
            return { amount: String(micro), asset: usdcAddress(cfg.network), decimals: 6 } as never;
          },
        },
        description: "Fund a Codevertise ad campaign with USDC (1 block = 1,000 impressions)",
        mimeType: "application/json",
      },
    },
    server,
    undefined,
    undefined,
    // We sync supported kinds with the facilitator ourselves (below) instead
    // of letting the middleware do it: its boot-time initialize() promise has
    // no rejection handler until the first paid request, so a facilitator
    // outage during boot would crash the process. `false` here means the
    // middleware never syncs — without our own initialize() every paid
    // request fails with "Facilitator does not support exact on <network>".
    false,
  );

  let facilitatorSynced = false;
  const syncFacilitator = async () => {
    await server.initialize();
    facilitatorSynced = true;
    console.log(JSON.stringify({ evt: "facilitator_synced", url: cfg.facilitatorUrl }));
  };
  // Boot-time attempt is best-effort; paid requests retry until it sticks.
  syncFacilitator().catch((err) =>
    console.error(JSON.stringify({ evt: "facilitator_sync_failed", err: String(err) })),
  );

  // No req.settledPayment here: on the x402 rail the credit happens in the
  // onAfterSettle hook above, after the facilitator confirms settlement.
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!facilitatorSynced) {
      try {
        await syncFacilitator();
      } catch (err) {
        console.error(JSON.stringify({ evt: "facilitator_sync_failed", err: String(err) }));
        res.status(502).json({ error: "payment facilitator unreachable, try again shortly" });
        return;
      }
    }
    void middleware(req, res, next);
  };
}

/** USDC contract per supported network (CAIP-2 keyed). */
export function usdcAddress(network: string): string {
  const table: Record<string, string> = {
    "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
    "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  };
  const addr = table[network];
  if (!addr) throw new Error(`no USDC address configured for network ${network}`);
  return addr;
}

/** Human-readable summary of a funding price, used in route responses. */
export function describePrice(priceMicro: number): string {
  return `$${(priceMicro / USD).toFixed(2)} USDC`;
}
