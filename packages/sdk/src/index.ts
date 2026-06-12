/**
 * Codevertise publisher SDK.
 *
 * A "publisher" is any developer surface that can show one line of text while
 * an AI agent is thinking — a spinner, a status bar, a TUI footer. The SDK
 * fetches the current auction winner, enforces the view threshold before an
 * impression counts, and reports idempotent events so retries never
 * double-bill advertisers or double-credit you.
 *
 * Earnings accrue in micro-USD to your wallet address and are paid out in
 * USDC once you cross the marketplace threshold.
 */

export interface Ad {
  campaignId: string;
  message: string;
  url: string;
  slotSeconds: number;
  impressionMicro: number;
  clickMicro: number;
  publisherShare: number;
}

export interface PublisherEarnings {
  wallet: string;
  earnedMicro: number;
  paidMicro: number;
  withdrawableMicro: number;
  minPayoutMicro: number;
}

export interface CodevertiseOptions {
  /** Marketplace base URL, e.g. http://localhost:4021 */
  endpoint: string;
  /** Your payout wallet address — this is your publisher identity. */
  publisher: string;
  /** Which surface the ad runs on, e.g. "claude-code-spinner". */
  surface?: string;
  fetchImpl?: typeof fetch;
}

export class Codevertise {
  private endpoint: string;
  private publisher: string;
  private surface: string;
  private fetch: typeof fetch;

  constructor(opts: CodevertiseOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/, "");
    this.publisher = opts.publisher;
    this.surface = opts.surface ?? "unknown";
    this.fetch = opts.fetchImpl ?? fetch;
  }

  /** Current auction winner, or null when there is no fill. */
  async fetchAd(): Promise<Ad | null> {
    const res = await this.fetch(
      `${this.endpoint}/v1/serve?surface=${encodeURIComponent(this.surface)}&pub=${encodeURIComponent(this.publisher)}`,
    );
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`serve failed: ${res.status}`);
    return (await res.json()) as Ad;
  }

  /**
   * Count an impression. Call this only after the ad was actually visible for
   * its full slot (use `showAd` to get that for free). `key` makes the event
   * idempotent; omit it to generate one.
   */
  async reportImpression(ad: Ad, key?: string): Promise<number> {
    return this.report("impression", ad, key);
  }

  /** Count a click (the user opened ad.url). Worth `clickMicro`. */
  async reportClick(ad: Ad, key?: string): Promise<number> {
    return this.report("click", ad, key);
  }

  /**
   * View-threshold helper: renders the ad via your callback, waits the full
   * slot, then reports the impression. Returns publisher earnings in
   * micro-USD for this impression (0 if the budget ran dry).
   */
  async showAd(
    ad: Ad,
    render: (message: string, ad: Ad) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<number> {
    render(ad.message, ad);
    try {
      await sleep(ad.slotSeconds * 1000, opts.signal);
    } catch {
      return 0; // aborted before the view threshold: not an impression
    }
    return this.reportImpression(ad);
  }

  async earnings(): Promise<PublisherEarnings> {
    const res = await this.fetch(
      `${this.endpoint}/v1/publishers/${encodeURIComponent(this.publisher)}`,
    );
    if (!res.ok) throw new Error(`earnings failed: ${res.status}`);
    return (await res.json()) as PublisherEarnings;
  }

  /** Request a USDC payout of the full withdrawable balance. */
  async requestPayout(): Promise<unknown> {
    const res = await this.fetch(
      `${this.endpoint}/v1/publishers/${encodeURIComponent(this.publisher)}/payouts`,
      { method: "POST" },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(`payout failed: ${JSON.stringify(body)}`);
    return body;
  }

  private async report(type: "impression" | "click", ad: Ad, key?: string): Promise<number> {
    const res = await this.fetch(`${this.endpoint}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: key ?? cryptoRandomKey(),
        type,
        campaignId: ad.campaignId,
        publisher: this.publisher,
        surface: this.surface,
      }),
    });
    if (!res.ok) throw new Error(`event failed: ${res.status}`);
    const body = (await res.json()) as { recorded: boolean; earnedMicro?: number };
    return body.recorded ? (body.earnedMicro ?? 0) : 0;
  }
}

export function formatMicroUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(4)}`;
}

function cryptoRandomKey(): string {
  return globalThis.crypto.randomUUID();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}
