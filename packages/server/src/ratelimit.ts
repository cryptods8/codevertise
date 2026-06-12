/**
 * In-memory token-bucket rate limiter and a per-key minimum-interval pacer.
 * Dependency-free and per-process — a coarse backstop against one host pulling
 * serve tokens or posting events fast enough to fabricate traffic at scale.
 * (A multi-instance deployment would back these with a shared store.)
 */

const SWEEP_THRESHOLD = 50_000; // prune idle keys once the map grows past this

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private ratePerSec: number,
    private burst: number,
  ) {}

  /** Consume one token for `key`; returns false when the bucket is empty. */
  allow(key: string, now: number): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, updated: now };
      this.buckets.set(key, b);
    } else {
      const refill = ((now - b.updated) / 1000) * this.ratePerSec;
      b.tokens = Math.min(this.burst, b.tokens + refill);
      b.updated = now;
    }
    if (this.buckets.size > SWEEP_THRESHOLD) this.sweep(now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private sweep(now: number): void {
    // Drop fully-refilled (idle) buckets; they carry no state worth keeping.
    const idleMs = (this.burst / this.ratePerSec) * 1000;
    for (const [k, b] of this.buckets) {
      if (now - b.updated > idleMs) this.buckets.delete(k);
    }
  }
}

/** Allows a key through at most once per `minIntervalMs`. */
export class Pacer {
  private last = new Map<string, number>();

  constructor(private minIntervalMs: number) {}

  /** Returns true and records `now` if enough time has passed for `key`. */
  ready(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.minIntervalMs) return false;
    if (this.last.size > SWEEP_THRESHOLD) {
      for (const [k, t] of this.last) {
        if (now - t > this.minIntervalMs) this.last.delete(k);
      }
    }
    this.last.set(key, now);
    return true;
  }
}
