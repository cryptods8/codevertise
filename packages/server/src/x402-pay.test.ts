import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { parsePaymentPayload } from "@x402/core/schemas";

/**
 * The advertiser console pays funding 402s in the browser with a hand-rolled
 * x402 "exact" EVM client (packages/webapp/public/x402-pay.js — vanilla JS,
 * no build step, signs via eth_signTypedData_v4). These tests pin its wire
 * format to the real SDK: the header must decode with @x402/core, validate
 * against the PaymentPayload schema, echo `accepted` verbatim (the server
 * deep-equality-matches it), and carry a signature that recovers to the
 * payer exactly as the facilitator verifies it.
 */

// Outside tsconfig's rootDir, so loaded dynamically (vitest resolves it fine).
const pay = (await import(
  new URL("../../webapp/public/x402-pay.js", import.meta.url).href
)) as Record<string, any>;

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

// Mirrors the challenge our server builds for POST /v1/fund on Base Sepolia.
const accept = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "2000000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: `0x${"ab".repeat(20)}`,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};
const paymentRequired = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://ads.example/v1/fund?campaign=cmp_x&blocks=1",
    description: "Fund a Codevertise ad campaign with USDC (1 block = 1,000 impressions)",
    mimeType: "application/json",
  },
  accepts: [accept],
};

// What MetaMask does with eth_signTypedData_v4: hash the RPC-form typed data
// (decimal-string uints) and sign. viem signs the identical digest from
// BigInt form — if x402-pay.js built the wrong typed data, recovery fails.
const signTypedData = (td: {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, string>;
}) =>
  account.signTypedData({
    domain: td.domain as never,
    types: { TransferWithAuthorization: (td.types as any).TransferWithAuthorization },
    primaryType: "TransferWithAuthorization",
    message: {
      ...td.message,
      value: BigInt(td.message.value),
      validAfter: BigInt(td.message.validAfter),
      validBefore: BigInt(td.message.validBefore),
    },
  });

describe("browser x402 exact-EVM payment", () => {
  it("produces a PAYMENT-SIGNATURE header the SDK decodes and validates", async () => {
    const { header, payload } = await pay.createPaymentSignatureHeader({
      paymentRequired,
      from: account.address,
      signTypedData,
    });

    const decoded = decodePaymentSignatureHeader(header);
    expect(decoded).toEqual(payload);

    const parsed = parsePaymentPayload(decoded);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.x402Version).toBe(2);

    // The server matches `accepted` against its requirements by deep
    // equality before verifying anything — it must be echoed verbatim.
    expect(decoded.accepted).toEqual(accept);
    expect(decoded.resource).toEqual(paymentRequired.resource);
  });

  it("signs an EIP-3009 authorization the facilitator's checks accept", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { payload } = await pay.createPaymentSignatureHeader({
      paymentRequired,
      from: account.address,
      signTypedData,
    });
    const auth = payload.payload.authorization;

    // Wire format: decimal-string numerics, 32-byte hex nonce.
    expect(auth.from).toBe(account.address);
    expect(auth.to).toBe(accept.payTo);
    expect(auth.value).toBe("2000000");
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    // Facilitator time window: validAfter <= now, validBefore >= now + 6s.
    expect(Number(auth.validAfter)).toBeLessThanOrEqual(before);
    expect(Number(auth.validBefore)).toBeGreaterThanOrEqual(before + 6);

    // Signature recovery over the canonical typed data, as the facilitator does.
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: accept.extra.name,
        version: accept.extra.version,
        chainId: 84532,
        verifyingContract: accept.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: payload.payload.signature,
    });
    expect(recovered).toBe(account.address);
  });

  it("reads the v2 challenge from the PAYMENT-REQUIRED header, body as fallback", () => {
    const header = pay.safeBase64Encode(JSON.stringify(paymentRequired));
    expect(pay.parsePaymentRequired(header, {})).toEqual(paymentRequired);
    // Mock rail / v1-style: challenge in the JSON body, no header.
    expect(pay.parsePaymentRequired(null, paymentRequired)).toEqual(paymentRequired);
    expect(() => pay.parsePaymentRequired(null, {})).toThrow(/challenge/);
  });

  it("base64 helpers are UTF-8 safe and roundtrip with the SDK alphabet", () => {
    const tricky = JSON.stringify({ note: "ünïcødé ✓ — $2.00" });
    const encoded = pay.safeBase64Encode(tricky);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(pay.safeBase64Decode(encoded)).toBe(tricky);
  });
});
