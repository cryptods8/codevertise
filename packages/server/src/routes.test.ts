import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, USD, type Config } from "./config.js";
import { openDb } from "./db.js";
import { Marketplace } from "./marketplace.js";
import { buildApp } from "./routes.js";
import { signToken, type ServeToken } from "./tokens.js";

/**
 * End-to-end checks on the anti-fraud boundary: a billable event must redeem a
 * server-issued, single-use, time-boxed serve token, and the per-IP/per-surface
 * limits cap how fast traffic can be fabricated.
 */

interface Harness {
  base: string;
  market: Marketplace;
  cfg: Config;
  campaignId: string;
  manageKey: string;
  close: () => Promise<void>;
}

const servers: Harness[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(overrides: Partial<Config> = {}): Promise<Harness> {
  const cfg: Config = {
    ...loadConfig({ PUBLISHER_SHARE: "0.5" } as NodeJS.ProcessEnv),
    slotSeconds: 0.1, // minView ≈ 90ms — short enough to await in a test
    tokenTtlSeconds: 5,
    ...overrides,
  };
  const market = new Marketplace(openDb(":memory:"), cfg);
  const c = market.createCampaign({
    advertiser: "adv",
    message: "ad",
    url: "https://example.com",
    bidPerBlockMicro: 2 * USD, // $0.002/impression at 1000 impressions/block
  });
  market.fundCampaign({ campaignId: c.id, payer: "adv", amountMicro: 100 * USD, rail: "mock" });

  const app = await buildApp(cfg, market);
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const h: Harness = {
    base: `http://127.0.0.1:${port}`,
    market,
    cfg,
    campaignId: c.id,
    manageKey: c.manageKey,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  servers.push(h);
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Billable serve tokens are only issued to valid EVM payout addresses.
const PUB = `0x${"a1".repeat(20)}`;
const HONEST = `0x${"b2".repeat(20)}`;
const ATTACKER = `0x${"c3".repeat(20)}`;

async function serve(h: Harness, pub = PUB, surface = "spinner") {
  const res = await fetch(`${h.base}/v1/serve?pub=${pub}&surface=${surface}`);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function postEvent(h: Harness, payload: unknown) {
  const res = await fetch(`${h.base}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("serve → event redemption", () => {
  it("issues a token and bills exactly one impression per serve (replays are no-ops)", async () => {
    const h = await start();
    const { body: ad } = await serve(h);
    expect(ad.token).toBeTypeOf("string");

    await sleep(150);
    const first = await postEvent(h, { token: ad.token, type: "impression" });
    expect(first.status).toBe(201);
    expect(first.body.recorded).toBe(true);
    expect(h.market.balanceMicro(PUB)).toBe(1000); // 50% of $0.002

    const replay = await postEvent(h, { token: ad.token, type: "impression" });
    expect(replay.body.recorded).toBe(false);
    expect(h.market.balanceMicro(PUB)).toBe(1000); // unchanged
  });

  it("credits the token's publisher — a body field can't redirect earnings", async () => {
    const h = await start();
    const { body: ad } = await serve(h, HONEST);
    await sleep(150);
    // Attacker tries to bolt a different wallet onto the request body.
    await postEvent(h, { token: ad.token, type: "impression", publisher: ATTACKER });
    expect(h.market.balanceMicro(HONEST)).toBe(1000);
    expect(h.market.balanceMicro(ATTACKER)).toBe(0);
  });

  it("rejects a forged token", async () => {
    const h = await start();
    const forged = signToken(randomBytes(32), {
      jti: "evt_x",
      campaignId: h.campaignId,
      publisher: ATTACKER,
      surface: "s",
      iat: Date.now() - 200,
      impMicro: 2000,
      clkMicro: 100_000,
    } satisfies ServeToken);
    const res = await postEvent(h, { token: forged, type: "impression" });
    expect(res.status).toBe(403);
    expect(h.market.balanceMicro(ATTACKER)).toBe(0);
  });

  it("rejects redemption before the view threshold", async () => {
    const h = await start();
    const { body: ad } = await serve(h);
    const res = await postEvent(h, { token: ad.token, type: "impression" }); // no wait
    expect(res.status).toBe(425);
    expect(h.market.balanceMicro(PUB)).toBe(0);
  });

  it("rejects an expired token", async () => {
    const h = await start({ tokenTtlSeconds: 1 });
    const stale = signToken(h.market.signingSecret(), {
      jti: "evt_old",
      campaignId: h.campaignId,
      publisher: PUB,
      surface: "s",
      iat: Date.now() - 5000,
      impMicro: 2000,
      clkMicro: 100_000,
    } satisfies ServeToken);
    const res = await postEvent(h, { token: stale, type: "impression" });
    expect(res.status).toBe(410);
  });

  it("requires a counted impression before a click bills", async () => {
    const h = await start();
    const { body: ad } = await serve(h);
    await sleep(150);

    const earlyClick = await postEvent(h, { token: ad.token, type: "click" });
    expect(earlyClick.status).toBe(409);

    await postEvent(h, { token: ad.token, type: "impression" });
    const click = await postEvent(h, { token: ad.token, type: "click" });
    expect(click.status).toBe(201);
    expect(click.body.recorded).toBe(true);
  });
});

describe("pacing and rate limits", () => {
  it("issues at most one billable token per surface per view window", async () => {
    const h = await start();
    const a = await serve(h, PUB, "spinner");
    const b = await serve(h, PUB, "spinner"); // immediate re-serve
    expect(a.body.token).toBeTypeOf("string");
    expect(b.body.token).toBeUndefined(); // paced out — display only, not billable
  });

  it("rate-limits a single IP hammering /v1/serve", async () => {
    const h = await start({ serveRatePerSec: 1, serveBurst: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await serve(h, `0x${String(i).repeat(40).slice(0, 40)}`, `s${i}`)).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it("issues no billable token to a publisher that is not an EVM address", async () => {
    const h = await start();
    const res = await serve(h, "not-a-wallet", "spinner");
    expect(res.status).toBe(200); // creative still served…
    expect(res.body.token).toBeUndefined(); // …but unbillably
  });
});

describe("click-ratio cap", () => {
  it("caps clicks to a plausible ratio per (publisher, campaign)", async () => {
    const h = await start(); // default clickRatio 0.05 → floor of 1 click
    const a = await serve(h, PUB, "s1");
    const b = await serve(h, PUB, "s2");
    await sleep(150);
    await postEvent(h, { token: a.body.token, type: "impression" });
    await postEvent(h, { token: b.body.token, type: "impression" });

    const first = await postEvent(h, { token: a.body.token, type: "click" });
    expect(first.status).toBe(201); // the floor: a new surface gets one click

    const second = await postEvent(h, { token: b.body.token, type: "click" });
    expect(second.status).toBe(429); // 2 impressions can't justify a 2nd click at 5%
    expect(second.body.recorded).toBe(false);
  });
});

describe("advertiser auth (manage keys)", () => {
  async function post(h: Harness, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${h.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it("create returns a one-time manage key and never exposes its hash", async () => {
    const h = await start();
    const created = await post(h, "/v1/campaigns", {
      advertiser: "0xWallet",
      message: "hi",
      url: "https://example.com",
      bidPerBlockUsd: 2,
    });
    expect(created.status).toBe(201);
    expect(created.body.manageKey).toMatch(/^cvk_/);
    expect(JSON.stringify(created.body.campaign)).not.toContain("manage_key_hash");
  });

  it("raising a bid requires the campaign's manage key", async () => {
    const h = await start();
    const anon = await post(h, `/v1/campaigns/${h.campaignId}/bid`, { bidPerBlockUsd: 9 });
    expect(anon.status).toBe(403);

    const wrong = await post(
      h,
      `/v1/campaigns/${h.campaignId}/bid`,
      { bidPerBlockUsd: 9 },
      { "x-manage-key": "cvk_wrong" },
    );
    expect(wrong.status).toBe(403);

    const ok = await post(
      h,
      `/v1/campaigns/${h.campaignId}/bid`,
      { bidPerBlockUsd: 9 },
      { "x-manage-key": h.manageKey },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.campaign.bid_per_block_micro).toBe(9 * USD);
  });

  it("pause takes a campaign off the board; resume restores it", async () => {
    const h = await start();
    const paused = await post(h, `/v1/campaigns/${h.campaignId}/pause`, undefined, {
      "x-manage-key": h.manageKey,
    });
    expect(paused.status).toBe(200);
    expect(h.market.winner()).toBeUndefined();
    expect((await serve(h)).status).toBe(204);

    await post(h, `/v1/campaigns/${h.campaignId}/resume`, undefined, { "x-manage-key": h.manageKey });
    expect(h.market.winner()?.id).toBe(h.campaignId);
  });

  it("stats require the manage key; the public view hides the wallet", async () => {
    const h = await start();
    const noKey = await fetch(`${h.base}/v1/campaigns/${h.campaignId}/stats`);
    expect(noKey.status).toBe(403);

    const withKey = await fetch(`${h.base}/v1/campaigns/${h.campaignId}/stats`, {
      headers: { "x-manage-key": h.manageKey },
    });
    expect(withKey.status).toBe(200);

    const pub = await (await fetch(`${h.base}/v1/campaigns/${h.campaignId}`)).json();
    expect(pub.advertiser).not.toBe("adv"); // wallet replaced by label/anonymous
    const listing = await (await fetch(`${h.base}/v1/campaigns`)).json();
    expect(JSON.stringify(listing)).not.toContain("manage_key_hash");
  });

  it("admin token can moderate any campaign (kill switch)", async () => {
    const h = await start({ adminToken: "secret-admin" });
    const denied = await post(h, `/v1/campaigns/${h.campaignId}/pause`);
    expect(denied.status).toBe(403);
    const ok = await post(h, `/v1/campaigns/${h.campaignId}/pause`, undefined, {
      "x-admin-token": "secret-admin",
    });
    expect(ok.status).toBe(200);
    expect(h.market.winner()).toBeUndefined();
  });
});

describe("campaign content constraints", () => {
  it("rejects non-https landing urls (mock rail still allows localhost)", async () => {
    const h = await start();
    const make = (url: string) =>
      fetch(`${h.base}/v1/campaigns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ advertiser: "a", message: "m", url, bidPerBlockUsd: 2 }),
      });
    expect((await make("http://evil.example.com/phish")).status).toBe(400);
    expect((await make("javascript:alert(1)")).status).toBe(400);
    expect((await make("https://fine.example.com")).status).toBe(201);
    expect((await make("http://localhost:3000/dev")).status).toBe(201); // mock-rail dev nicety
  });
});

describe("ops surface", () => {
  it("healthz reports ok and the payments mode", async () => {
    const h = await start();
    const res = await fetch(`${h.base}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("mock");
  });

  it("admin payout listing is hidden without ADMIN_TOKEN and gated with it", async () => {
    const h = await start();
    expect((await fetch(`${h.base}/v1/admin/payouts`)).status).toBe(404);

    const h2 = await start({ adminToken: "ops" });
    expect((await fetch(`${h2.base}/v1/admin/payouts`)).status).toBe(401);
    const ok = await fetch(`${h2.base}/v1/admin/payouts`, { headers: { "x-admin-token": "ops" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ payouts: [] });
  });

  it("rejects payout requests to a malformed wallet", async () => {
    const h = await start();
    const res = await fetch(`${h.base}/v1/publishers/not-a-wallet/payouts`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});
