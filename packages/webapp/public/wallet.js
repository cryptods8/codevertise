/**
 * Wallet layer for the console.
 *
 * Resolves the active EIP-1193 provider — the Farcaster Mini App host wallet
 * when the console runs inside a Farcaster client, otherwise the injected
 * browser wallet (window.ethereum) — and keeps it on the marketplace's payment
 * network, switching (or adding) the chain when the connected wallet differs.
 *
 * The Farcaster Mini App SDK is loaded best-effort from a CDN: if it's
 * unreachable or we're not inside a Farcaster client, everything degrades to
 * the injected wallet with no behavior change.
 */

// CAIP-2 → EIP-3085 params for wallet_addEthereumChain. Only the chains the
// marketplace settles USDC on; an unknown target falls back to a plain switch.
const CHAIN_PARAMS = {
  "eip155:8453": {
    chainId: "0x2105",
    chainName: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"],
  },
  "eip155:84532": {
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
};

const CHAIN_NAMES = {
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
};

let farcasterSdk = null; // the @farcaster/miniapp-sdk `sdk`, when loaded
let farcasterProvider = null; // its EIP-1193 provider, when in a Mini App
let inMiniApp = false;

/**
 * Detect a Farcaster Mini App context and wire up the host wallet. Always
 * resolves; call once at boot. In a Mini App it also signals the host that the
 * UI is ready (dismisses the splash). Safe to call when offline.
 */
export async function initWallet() {
  try {
    const { sdk } = await import("https://esm.sh/@farcaster/miniapp-sdk");
    farcasterSdk = sdk;
    inMiniApp = typeof sdk.isInMiniApp === "function" ? await sdk.isInMiniApp() : false;
    if (inMiniApp) {
      farcasterProvider = await sdk.wallet.getEthereumProvider();
    }
    // No-op outside a Mini App host; inside, it dismisses the splash screen.
    try {
      await sdk.actions.ready();
    } catch {}
  } catch {
    // SDK unreachable or not a Mini App — use the injected wallet.
  }
  return { inMiniApp };
}

export function isInMiniApp() {
  return inMiniApp;
}

/** The active EIP-1193 provider, or null when no wallet is available. */
export function provider() {
  return farcasterProvider ?? (typeof window !== "undefined" ? window.ethereum : null) ?? null;
}

export function chainName(caip2) {
  return CHAIN_NAMES[caip2] ?? caip2;
}

function caip2ToHexChainId(caip2) {
  return "0x" + Number(caip2.split(":")[1]).toString(16);
}

/**
 * Ensure `prov` is on `caip2`, switching the wallet if it isn't (adding the
 * chain first when the wallet doesn't know it). Returns true when the wallet
 * is on the right chain afterward.
 *
 * `onSwitching(name)` fires once just before a switch is requested, so the UI
 * can tell the user to confirm the prompt. A wallet that can't report its
 * chain is left alone — the EIP-712/EIP-3009 signature still carries the
 * chainId, so the facilitator settles on the right chain regardless.
 */
export async function ensureChain(prov, caip2, { onSwitching } = {}) {
  if (!prov || !caip2) return true;
  const want = caip2ToHexChainId(caip2);
  let current;
  try {
    current = await prov.request({ method: "eth_chainId" });
  } catch {
    return true;
  }
  if (Number(current) === Number(want)) return true;

  onSwitching?.(chainName(caip2));
  try {
    await prov.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: want }],
    });
    return true;
  } catch (err) {
    // 4902 (and some wallets' -32603) = chain unknown; add it, which selects it.
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code === 4902 || code === -32603) {
      const params = CHAIN_PARAMS[caip2];
      if (!params) throw err;
      await prov.request({ method: "wallet_addEthereumChain", params: [params] });
      return true;
    }
    // User rejected (4001) or anything else: surface to the caller.
    throw err;
  }
}
