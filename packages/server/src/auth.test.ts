import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { loadConfig, USD, type Config } from "./config.js";
import { openDb } from "./db.js";
import { Marketplace } from "./marketplace.js";
import { buildApp } from "./routes.js";

/**
 * SIWE advertiser auth: a wallet signature buys a session cookie, the session
 * owns its campaigns from any browser, and the account settings (board name)
 * ride on the wallet — no manage key required in the webapp flow.
 */

interface Harness {
  base: string;
  market: Marketplace;
  close: () => Promise<void>;
}

const servers: Harness[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(overrides: Partial<Config> = {}): Promise<Harness> {
  const cfg: Config = { ...loadConfig({} as NodeJS.ProcessEnv), ...overrides };
  const market = new Marketplace(openDb(":memory:"), cfg);
  const app = await buildApp(cfg, market);
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const h: Harness = {
    base: `http://127.0.0.1:${port}`,
    market,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  servers.push(h);
  return h;
}

async function getJson(h: Harness, path: string, cookie?: string) {
  const res = await fetch(`${h.base}${path}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function send(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), res };
}

/** Run the full nonce → sign → verify flow; returns the session cookie. */
async function signIn(h: Harness, account: PrivateKeyAccount) {
  const nonce = await getJson(h, `/v1/auth/nonce?address=${account.address}`);
  expect(nonce.status).toBe(200);
  const signature = await account.signMessage({ message: nonce.body.message });
  const verify = await send(h, "POST", "/v1/auth/verify", { nonce: nonce.body.nonce, signature });
  const setCookie = verify.res.headers.get("set-cookie") ?? "";
  return { ...verify, cookie: setCookie.split(";")[0] };
}

describe("SIWE sign-in", () => {
  it("signs in with a wallet signature and the session survives across requests", async () => {
    const h = await start();
    const account = privateKeyToAccount(generatePrivateKey());

    const { status, body, cookie } = await signIn(h, account);
    expect(status).toBe(200);
    expect(body.signedIn).toBe(true);
    expect(body.wallet).toBe(account.address.toLowerCase());
    expect(body.settingsSet).toBe(false); // forced settings pass still pending
    expect(cookie).toMatch(/^cv_session=cvs_/);

    // A "different browser" is just the cookie presented on a later request.
    const session = await getJson(h, "/v1/auth/session", cookie);
    expect(session.body).toMatchObject({ signedIn: true, wallet: account.address.toLowerCase() });

    const anonymous = await getJson(h, "/v1/auth/session");
    expect(anonymous.body).toEqual({ signedIn: false });
  });

  it("rejects a replayed nonce and a signature from the wrong wallet", async () => {
    const h = await start();
    const account = privateKeyToAccount(generatePrivateKey());
    const imposter = privateKeyToAccount(generatePrivateKey());

    const nonce = await getJson(h, `/v1/auth/nonce?address=${account.address}`);
    const wrongSig = await imposter.signMessage({ message: nonce.body.message });
    const denied = await send(h, "POST", "/v1/auth/verify", { nonce: nonce.body.nonce, signature: wrongSig });
    expect(denied.status).toBe(401);

    // The failed attempt consumed the nonce: even the right wallet can't reuse it.
    const rightSig = await account.signMessage({ message: nonce.body.message });
    const replayed = await send(h, "POST", "/v1/auth/verify", { nonce: nonce.body.nonce, signature: rightSig });
    expect(replayed.status).toBe(401);
  });

  it("logout invalidates the session server-side", async () => {
    const h = await start();
    const { cookie } = await signIn(h, privateKeyToAccount(generatePrivateKey()));
    await send(h, "POST", "/v1/auth/logout", undefined, cookie);
    const session = await getJson(h, "/v1/auth/session", cookie);
    expect(session.body).toEqual({ signedIn: false });
  });
});

describe("session-owned campaigns", () => {
  const CREATIVE = { message: "siwe ad", url: "https://example.com", bidPerBlockUsd: 2 };

  it("a signed-in creator manages campaigns from any browser, without a manage key", async () => {
    const h = await start();
    const account = privateKeyToAccount(generatePrivateKey());
    const { cookie } = await signIn(h, account);

    // No advertiser field: the session wallet is the advertiser.
    const created = await send(h, "POST", "/v1/campaigns", CREATIVE, cookie);
    expect(created.status).toBe(201);
    const id = created.body.campaign.id;

    // Same wallet, brand-new session = a different browser.
    const { cookie: otherBrowser } = await signIn(h, account);
    const mine = await getJson(h, "/v1/me/campaigns", otherBrowser);
    expect(mine.body.campaigns.map((c: { id: string }) => c.id)).toEqual([id]);

    const raised = await send(h, "POST", `/v1/campaigns/${id}/bid`, { bidPerBlockUsd: 9 }, otherBrowser);
    expect(raised.status).toBe(200);
    expect(raised.body.campaign.bid_per_block_micro).toBe(9 * USD);

    const stats = await getJson(h, `/v1/campaigns/${id}/stats`, otherBrowser);
    expect(stats.status).toBe(200);
  });

  it("another wallet's session cannot touch the campaign", async () => {
    const h = await start();
    const { cookie } = await signIn(h, privateKeyToAccount(generatePrivateKey()));
    const created = await send(h, "POST", "/v1/campaigns", CREATIVE, cookie);
    const id = created.body.campaign.id;

    const { cookie: strangers } = await signIn(h, privateKeyToAccount(generatePrivateKey()));
    expect((await send(h, "POST", `/v1/campaigns/${id}/pause`, undefined, strangers)).status).toBe(403);
    expect((await getJson(h, "/v1/me/campaigns", strangers)).body.campaigns).toEqual([]);
  });

  it("never leaks the owner wallet on public surfaces", async () => {
    const h = await start();
    const account = privateKeyToAccount(generatePrivateKey());
    const { cookie } = await signIn(h, account);
    await send(h, "POST", "/v1/campaigns", CREATIVE, cookie);

    const listing = await getJson(h, "/v1/campaigns");
    expect(JSON.stringify(listing.body).toLowerCase()).not.toContain(account.address.toLowerCase());
    expect(JSON.stringify(listing.body)).not.toContain("owner_wallet");
  });

  it("creating without a session still requires an advertiser wallet (agent path)", async () => {
    const h = await start();
    const missing = await send(h, "POST", "/v1/campaigns", CREATIVE);
    expect(missing.status).toBe(400);
    const agent = await send(h, "POST", "/v1/campaigns", { ...CREATIVE, advertiser: "0xagent" });
    expect(agent.status).toBe(201);
    expect(agent.body.manageKey).toMatch(/^cvk_/);
  });

  it("cancel refunds to the SIWE owner wallet when no refundTo is given", async () => {
    const h = await start();
    const account = privateKeyToAccount(generatePrivateKey());
    const { cookie } = await signIn(h, account);
    const created = await send(h, "POST", "/v1/campaigns", CREATIVE, cookie);
    const id = created.body.campaign.id;
    h.market.fundCampaign({ campaignId: id, payer: "test", amountMicro: 5 * USD, rail: "mock" });

    const cancelled = await send(h, "POST", `/v1/campaigns/${id}/cancel`, {}, cookie);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.refund.wallet).toBe(account.address.toLowerCase());
    expect(cancelled.body.refund.amount_micro).toBe(5 * USD);
  });
});

describe("account settings", () => {
  it("requires a session, saves the board name, and renames owned campaigns", async () => {
    const h = await start();
    expect((await send(h, "PUT", "/v1/account", { label: "acme" })).status).toBe(401);

    const { cookie } = await signIn(h, privateKeyToAccount(generatePrivateKey()));
    const created = await send(
      h,
      "POST",
      "/v1/campaigns",
      { message: "ad", url: "https://example.com", bidPerBlockUsd: 2 },
      cookie,
    );
    expect(created.body.campaign.label).toBe(null); // no board name yet

    const saved = await send(h, "PUT", "/v1/account", { label: "acme corp" }, cookie);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ label: "acme corp", settingsSet: true });

    // The account label follows through: session reports it and the public
    // board shows the existing campaign under the new name.
    const session = await getJson(h, "/v1/auth/session", cookie);
    expect(session.body.settingsSet).toBe(true);
    const listing = await getJson(h, "/v1/campaigns");
    expect(listing.body.campaigns[0].advertiser).toBe("acme corp");

    // New campaigns inherit the board name without sending one.
    const next = await send(
      h,
      "POST",
      "/v1/campaigns",
      { message: "ad2", url: "https://example.com", bidPerBlockUsd: 2 },
      cookie,
    );
    expect(next.body.campaign.label).toBe("acme corp");
  });
});
