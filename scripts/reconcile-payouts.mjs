#!/usr/bin/env node
/**
 * Drain stuck payouts through the admin API.
 *
 *   ADMIN_TOKEN=… node scripts/reconcile-payouts.mjs
 *   ADMIN_TOKEN=… BASE_URL=https://codevertise.dev node scripts/reconcile-payouts.mjs
 *
 * The server sends payouts inline in the request handler; nothing drains the
 * ones left behind. Two states get stranded (see packages/server/src/payouts.ts):
 *
 *   - submitted  broadcast but the receipt wait was lost (RPC timeout, restart).
 *                Retry RECONCILES against the recorded tx — it never re-sends.
 *   - queued     the send threw before broadcast, or no treasury key was set.
 *                Retry RE-SENDS.
 *
 * Cron this (e.g. every 10 min) on the SAME host/instance as the server: the
 * treasury nonce lock is per-process, and retry runs the send through that same
 * process, so a single reconciler co-located with a single server is safe.
 *
 * The race we guard against: a just-created payout is `queued` for the brief
 * window between its DB commit and the inline broadcast. retryPayout reads the
 * status OUTSIDE the send lock, so retrying it then would broadcast a second
 * time = double-send. MIN_AGE_SECONDS skips anything young enough to still have
 * an inline send in flight. Reconciling `submitted` is re-send-safe regardless,
 * but the same age guard keeps us from racing a receipt wait that's still live.
 */

const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4021}`).replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const MIN_AGE_SECONDS = Number(process.env.MIN_AGE_SECONDS ?? 120);
const DRY_RUN = process.env.DRY_RUN === "1";

if (!ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN is required (the server exposes /v1/admin/* only when it is set)");
  process.exit(2);
}
if (!(MIN_AGE_SECONDS >= 0)) {
  console.error(`MIN_AGE_SECONDS must be a non-negative number, got ${process.env.MIN_AGE_SECONDS}`);
  process.exit(2);
}

const headers = { "x-admin-token": ADMIN_TOKEN };

async function api(method, path) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function list(status) {
  const { payouts } = await api("GET", `/v1/admin/payouts?status=${status}`);
  return payouts ?? [];
}

// We can't use Date.now() in some sandboxes, but this is a plain node script.
const nowMs = Date.now();
const ageSeconds = (p) => (nowMs - p.created_at) / 1000;

// Both stuck states. retry reconciles `submitted` by its tx (never re-sends)
// and re-sends `queued`. Oldest-first so the longest-stuck money clears soonest.
const stuck = [...(await list("submitted")), ...(await list("queued"))];
const candidates = stuck
  .filter((p) => ageSeconds(p) >= MIN_AGE_SECONDS)
  .sort((a, b) => a.created_at - b.created_at);
const skipped = stuck.length - candidates.length;

console.log(
  `reconcile-payouts: ${candidates.length} stuck payout(s) at ${BASE_URL}` +
    ` (min age ${MIN_AGE_SECONDS}s${skipped > 0 ? `, ${skipped} too young to touch` : ""})` +
    (DRY_RUN ? " [DRY RUN]" : ""),
);

let resolved = 0;
let stillPending = 0;
let failed = 0;

// Sequential: one nonce, one send lock — no reason to fan out, and it keeps the
// log readable. retry re-sends `queued` and reconciles `submitted` by its tx.
for (const p of candidates) {
  const tag = `${p.id} ${p.kind} ${p.status} $${(p.amount_micro / 1_000_000).toFixed(2)} aged ${Math.round(ageSeconds(p))}s`;
  if (DRY_RUN) {
    console.log(`would retry ${tag}`);
    continue;
  }
  try {
    const { result } = await api("POST", `/v1/admin/payouts/${p.id}/retry`);
    const status = result?.status ?? "unknown";
    console.log(`retried ${tag} → ${status}${result?.tx ? ` tx=${result.tx}` : ""}${result?.error ? ` (${result.error})` : ""}`);
    if (status === "sent" || status === "failed") resolved++;
    else stillPending++; // queued (no key / send still failing) or submitted (receipt still unknown)
  } catch (err) {
    failed++;
    console.error(`ERROR retrying ${p.id}: ${err.message}`);
  }
}

console.log(`reconcile-payouts: resolved=${resolved} stillPending=${stillPending} failed=${failed}`);

// Non-zero exit when a retry call errored, so cron/monitoring notices. Payouts
// that simply remain queued/submitted are an expected steady state, not an error.
process.exit(failed > 0 ? 1 : 0);
