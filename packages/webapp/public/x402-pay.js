/**
 * Minimal x402 v2 "exact" EVM client for browsers — just enough to pay a
 * Codevertise funding 402 with an injected EIP-1193 wallet (MetaMask,
 * Coinbase Wallet, …). The payment is an EIP-3009 transferWithAuthorization
 * signature: gasless for the payer, settled on-chain by the facilitator.
 *
 * The wire format mirrors @x402/core + @x402/evm exactly; the unit tests in
 * packages/server/src/x402-pay.test.ts decode our output with the real SDK.
 * Pure module (no window access) so it runs under vitest as-is.
 */

/** UTF-8-safe base64, byte-for-byte the SDK's safeBase64Encode/Decode. */
export function safeBase64Encode(data) {
  if (typeof globalThis.btoa === "function") {
    const bytes = new TextEncoder().encode(data);
    return globalThis.btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  }
  return Buffer.from(data, "utf8").toString("base64");
}

export function safeBase64Decode(data) {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  return Buffer.from(data, "base64").toString("utf-8");
}

/**
 * The 402 challenge. v2 servers put it in the PAYMENT-REQUIRED response
 * header (base64 JSON, body is `{}`); the mock rail and older servers put
 * the JSON straight in the body.
 */
export function parsePaymentRequired(headerValue, body) {
  if (headerValue) return JSON.parse(safeBase64Decode(headerValue));
  if (body && Array.isArray(body.accepts)) return body;
  throw new Error("402 response carried no payment challenge");
}

/** Pick the first accepts[] entry this client can pay: exact scheme on an EVM chain. */
export function selectExactEvmAccept(paymentRequired) {
  const accept = (paymentRequired.accepts ?? []).find(
    (a) => a.scheme === "exact" && typeof a.network === "string" && a.network.startsWith("eip155:"),
  );
  if (!accept) throw new Error("server offered no exact/EVM payment option");
  if (!accept.extra?.name || !accept.extra?.version) {
    throw new Error("payment option is missing the token's EIP-712 domain (extra.name/version)");
  }
  return accept;
}

/** Random 32-byte EIP-3009 nonce as 0x-hex. */
export function createNonce() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The transferWithAuthorization payload. All numerics are decimal strings on
 * the wire; validAfter backdates 10 minutes for clock skew, validBefore is
 * the server's declared timeout — both as in the official client.
 */
export function buildAuthorization(accept, from, nowSec = Math.floor(Date.now() / 1000)) {
  return {
    from,
    to: accept.payTo,
    value: String(accept.amount),
    validAfter: String(nowSec - 600),
    validBefore: String(nowSec + (accept.maxTimeoutSeconds ?? 300)),
    nonce: createNonce(),
  };
}

/**
 * EIP-712 typed data for eth_signTypedData_v4. uint256 fields go as decimal
 * strings (the RPC form of what viem signs as BigInt — same digest).
 */
export function buildTypedData(accept, authorization) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
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
    domain: {
      name: accept.extra.name,
      version: accept.extra.version,
      chainId: Number(accept.network.split(":")[1]),
      verifyingContract: accept.asset,
    },
    message: authorization,
  };
}

/**
 * Assemble the PaymentPayload the server verifies: the signed authorization
 * plus the challenge's resource and the chosen accepts entry echoed back
 * verbatim (the server deep-equality-matches `accepted` against its own
 * requirements before verifying the signature).
 */
export function buildPaymentPayload(paymentRequired, accept, authorization, signature) {
  return {
    x402Version: 2,
    payload: { signature, authorization },
    resource: paymentRequired.resource,
    accepted: accept,
  };
}

/**
 * One-shot: turn a parsed 402 challenge into the PAYMENT-SIGNATURE header.
 * `signTypedData(typedData)` must resolve to the 0x signature — in the
 * browser that's eth_signTypedData_v4 on the injected provider.
 */
export async function createPaymentSignatureHeader({ paymentRequired, from, signTypedData }) {
  const accept = selectExactEvmAccept(paymentRequired);
  const authorization = buildAuthorization(accept, from);
  const signature = await signTypedData(buildTypedData(accept, authorization));
  const payload = buildPaymentPayload(paymentRequired, accept, authorization, signature);
  return { header: safeBase64Encode(JSON.stringify(payload)), accept, payload };
}

/** Settlement details from the PAYMENT-RESPONSE header (tx hash, payer). */
export function parsePaymentResponse(headerValue) {
  if (!headerValue) return null;
  try {
    return JSON.parse(safeBase64Decode(headerValue));
  } catch {
    return null;
  }
}
