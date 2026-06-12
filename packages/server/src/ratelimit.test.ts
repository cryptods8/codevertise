import { describe, expect, it } from "vitest";
import { Pacer, RateLimiter } from "./ratelimit.js";

describe("RateLimiter", () => {
  it("allows up to the burst, then denies until tokens refill", () => {
    const rl = new RateLimiter(1, 3); // 1/sec, burst 3
    const t0 = 1_000_000;
    expect(rl.allow("ip", t0)).toBe(true);
    expect(rl.allow("ip", t0)).toBe(true);
    expect(rl.allow("ip", t0)).toBe(true);
    expect(rl.allow("ip", t0)).toBe(false); // burst exhausted
    expect(rl.allow("ip", t0 + 1000)).toBe(true); // one token refilled after 1s
    expect(rl.allow("ip", t0 + 1000)).toBe(false);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1);
    const t0 = 1_000_000;
    expect(rl.allow("a", t0)).toBe(true);
    expect(rl.allow("b", t0)).toBe(true);
    expect(rl.allow("a", t0)).toBe(false);
  });
});

describe("Pacer", () => {
  it("permits a key at most once per interval", () => {
    const p = new Pacer(5000);
    const t0 = 1_000_000;
    expect(p.ready("pub|surface", t0)).toBe(true);
    expect(p.ready("pub|surface", t0 + 4999)).toBe(false);
    expect(p.ready("pub|surface", t0 + 5000)).toBe(true);
  });
});
