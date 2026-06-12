import type { Config } from "./config.js";
import type { Marketplace } from "./marketplace.js";
import { usdcAddress } from "./payments.js";

/**
 * Publisher payouts in USDC. With a treasury key configured the transfer is
 * sent on-chain immediately; otherwise the payout stays "queued" for an
 * operator to settle out-of-band (the ledger is already debited either way,
 * and a failed send refunds it).
 */
export async function executePayout(
  cfg: Config,
  market: Marketplace,
  payoutId: string,
  toWallet: string,
  amountMicro: number,
): Promise<{ status: "queued" | "sent" | "failed"; tx?: string }> {
  if (!cfg.payoutPrivateKey) return { status: "queued" };

  try {
    const [{ createWalletClient, http, erc20Abi }, { privateKeyToAccount }, chains] =
      await Promise.all([import("viem"), import("viem/accounts"), import("viem/chains")]);

    const chain = cfg.network === "eip155:8453" ? chains.base : chains.baseSepolia;
    const account = privateKeyToAccount(cfg.payoutPrivateKey as `0x${string}`);
    const client = createWalletClient({ account, chain, transport: http() });

    const tx = await client.writeContract({
      address: usdcAddress(cfg.network) as `0x${string}`,
      abi: erc20Abi,
      functionName: "transfer",
      args: [toWallet as `0x${string}`, BigInt(amountMicro)], // USDC has 6 decimals = micro-USD
    });
    market.resolvePayout(payoutId, "sent", tx);
    return { status: "sent", tx };
  } catch (err) {
    market.resolvePayout(payoutId, "failed");
    console.error(`payout ${payoutId} failed:`, err);
    return { status: "failed" };
  }
}
