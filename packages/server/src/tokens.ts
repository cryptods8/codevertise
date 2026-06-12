import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Serve tokens: the marketplace's authorization that a specific ad was served
 * to a specific publisher/surface at a specific time. A token is the only way
 * to bill an event, which is what makes fabricated traffic hard:
 *
 *  - Clients cannot forge one (HMAC over the payload with a server-held key).
 *  - The billed campaign, publisher, surface, and price all come from the
 *    signed payload, so an event can only ever credit the wallet the ad was
 *    actually served to — no wallet- or campaign-spoofing.
 *  - The `jti` is the single-use redemption key; one serve bills one event.
 *  - `iat` lets the redeemer enforce the view threshold (no instant minting)
 *    and a TTL (no stockpiling tokens to redeem in a burst later).
 */
export interface ServeToken {
  jti: string; // unique token id; doubles as the event idempotency key
  campaignId: string;
  publisher: string;
  surface: string;
  iat: number; // issued-at, ms since epoch
  impMicro: number; // advertiser cost of an impression, locked at serve time
  clkMicro: number; // advertiser cost of a click, locked at serve time
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signToken(secret: Buffer, payload: ServeToken): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

/** Verify signature and shape; returns the payload or null if anything is off. */
export function verifyToken(secret: Buffer, token: string): ServeToken | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = fromB64url(token.slice(dot + 1));
  const expected = createHmac("sha256", secret).update(body).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(fromB64url(body).toString("utf8")) as ServeToken;
    if (
      typeof p.jti === "string" &&
      typeof p.campaignId === "string" &&
      typeof p.publisher === "string" &&
      typeof p.surface === "string" &&
      Number.isFinite(p.iat) &&
      Number.isFinite(p.impMicro) &&
      Number.isFinite(p.clkMicro)
    ) {
      return p;
    }
    return null;
  } catch {
    return null;
  }
}
