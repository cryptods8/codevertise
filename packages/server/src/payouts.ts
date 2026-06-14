import type { Config } from "./config.js";
import type { Marketplace } from "./marketplace.js";
import { usdcAddress } from "./payments.js";

/**
 * Publisher payouts in USDC.
 *
 * State machine (statuses live in the payouts table):
 *
 *   queued ──send──▶ submitted ──receipt ok──▶ sent
 *     │                  │
 *     │                  └─receipt reverted──▶ failed (refund)
 *     └─send threw before broadcast──▶ stays queued (retry later)
 *
 * The rules that keep money safe:
 *  - A payout is marked `submitted` with its tx hash the moment the
 *    transaction is broadcast, BEFORE we wait for the receipt — so a crash or
 *    RPC timeout after broadcast can never lead to an automatic refund (and
 *    therefore never to a double-send). `retryPayout` reconciles a stuck
 *    `submitted` payout against the chain instead of re-sending.
 *  - Refunds happen only on provable failure: a reverted receipt, or an
 *    explicit operator decision (admin "fail" endpoint).
 *  - Sends are serialized per process so treasury nonces never collide.
 *
 * Without a treasury key the payout stays `queued` for out-of-band settlement
 * (the ledger is already debited).
 */

export interface PayoutSender {
  /** Broadcast a USDC transfer; resolves with the tx hash once accepted by the RPC. */
  send(toWallet: string, amountMicro: number): Promise<string>;
  /** Wait for the receipt of a broadcast tx. */
  wait(tx: string): Promise<"success" | "reverted">;
}

export interface PayoutResult {
  status: "queued" | "submitted" | "sent" | "failed";
  tx?: string;
  error?: string;
}

/** Serializes all treasury sends; a single key must not race its own nonce. */
let sendChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = sendChain.then(fn, fn);
  sendChain = next.catch(() => undefined);
  return next;
}

async function viemSender(cfg: Config): Promise<PayoutSender> {
  const [{ createWalletClient, createPublicClient, http, erc20Abi }, { privateKeyToAccount }, chains] =
    await Promise.all([import("viem"), import("viem/accounts"), import("viem/chains")]);

  const chain = cfg.network === "eip155:8453" ? chains.base : chains.baseSepolia;
  const account = privateKeyToAccount(cfg.payoutPrivateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http() });
  const reader = createPublicClient({ chain, transport: http() });

  return {
    send: (toWallet, amountMicro) =>
      wallet.writeContract({
        address: usdcAddress(cfg.network) as `0x${string}`,
        abi: erc20Abi,
        functionName: "transfer",
        args: [toWallet as `0x${string}`, BigInt(amountMicro)], // USDC has 6 decimals = micro-USD
      }),
    wait: async (tx) => {
      const receipt = await reader.waitForTransactionReceipt({ hash: tx as `0x${string}` });
      return receipt.status === "success" ? "success" : "reverted";
    },
  };
}

export async function executePayout(
  cfg: Config,
  market: Marketplace,
  payoutId: string,
  toWallet: string,
  amountMicro: number,
  sender?: PayoutSender,
): Promise<PayoutResult> {
  if (!cfg.payoutPrivateKey && !sender) return { status: "queued" };

  return serialized(async () => {
    const s = sender ?? (await viemSender(cfg));

    let tx: string;
    try {
      tx = await s.send(toWallet, amountMicro);
    } catch (err) {
      // Nothing provably broadcast: leave the payout queued (debit stands,
      // operator or a later request can retry). No refund — refunding on an
      // ambiguous error is how double-sends happen.
      console.error(JSON.stringify({ evt: "payout_send_error", payoutId, err: String(err) }));
      return { status: "queued", error: "send failed; payout remains queued for retry" };
    }
    await market.markPayoutSubmitted(payoutId, tx);

    try {
      const outcome = await s.wait(tx);
      if (outcome === "reverted") {
        await market.resolvePayout(payoutId, "failed", tx);
        console.error(JSON.stringify({ evt: "payout_reverted", payoutId, tx }));
        return { status: "failed", tx, error: "transaction reverted; balance refunded" };
      }
      await market.resolvePayout(payoutId, "sent", tx);
      console.log(JSON.stringify({ evt: "payout_sent", payoutId, tx, toWallet, amountMicro }));
      return { status: "sent", tx };
    } catch (err) {
      // Broadcast but receipt unknown (RPC timeout etc.): keep `submitted`.
      console.error(JSON.stringify({ evt: "payout_receipt_unknown", payoutId, tx, err: String(err) }));
      return { status: "submitted", tx, error: "receipt pending; will be reconciled" };
    }
  });
}

/**
 * Operator retry. A `queued` payout is re-sent; a `submitted` payout is
 * reconciled against the chain by its recorded tx (never re-sent).
 */
export async function retryPayout(
  cfg: Config,
  market: Marketplace,
  payoutId: string,
  sender?: PayoutSender,
): Promise<PayoutResult> {
  const payout = await market.getPayout(payoutId);
  if (!payout) return { status: "failed", error: "payout not found" };

  if (payout.status === "queued") {
    return executePayout(cfg, market, payout.id, payout.wallet, payout.amount_micro, sender);
  }
  if (payout.status === "submitted" && payout.tx) {
    if (!cfg.payoutPrivateKey && !sender) {
      return { status: "submitted", tx: payout.tx, error: "no treasury key configured to reconcile" };
    }
    const s = sender ?? (await viemSender(cfg));
    const outcome = await s.wait(payout.tx);
    if (outcome === "reverted") {
      await market.resolvePayout(payoutId, "failed", payout.tx);
      return { status: "failed", tx: payout.tx, error: "transaction reverted; balance refunded" };
    }
    await market.resolvePayout(payoutId, "sent", payout.tx);
    return { status: "sent", tx: payout.tx };
  }
  return { status: payout.status, tx: payout.tx ?? undefined };
}
