import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signToken, verifyToken, type ServeToken } from "./tokens.js";

const secret = randomBytes(32);
const payload: ServeToken = {
  jti: "evt_abc",
  campaignId: "cmp_1",
  publisher: "0xpub",
  surface: "spinner",
  iat: 1_700_000_000_000,
  impMicro: 2000,
  clkMicro: 100_000,
};

describe("serve tokens", () => {
  it("round-trips a signed payload", () => {
    expect(verifyToken(secret, signToken(secret, payload))).toEqual(payload);
  });

  it("rejects a token signed with a different key", () => {
    expect(verifyToken(randomBytes(32), signToken(secret, payload))).toBeNull();
  });

  it("rejects a tampered payload (the signature no longer matches)", () => {
    const [body, sig] = signToken(secret, payload).split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, publisher: "0xattacker" }), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyToken(secret, `${forged}.${sig}`)).toBeNull();
    expect(body).not.toBe(forged);
  });

  it("rejects garbage", () => {
    expect(verifyToken(secret, "")).toBeNull();
    expect(verifyToken(secret, "nodot")).toBeNull();
    expect(verifyToken(secret, "a.b")).toBeNull();
  });
});
