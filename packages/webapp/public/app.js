/* Codevertise advertiser console — vanilla JS, talks to the marketplace API on the same origin. */

import {
  createPaymentSignatureHeader,
  parsePaymentRequired,
  parsePaymentResponse,
} from "./x402-pay.js";
import { initWallet, provider, ensureChain } from "./wallet.js";

const $ = (sel) => document.querySelector(sel);
const USD = 1_000_000;
const fmt = (micro, dp = 2) => `$${(micro / USD).toFixed(dp)}`;
const shortWallet = (w) => `${w.slice(0, 6)}…${w.slice(-4)}`;

let info = null;
let board = [];

// ---- bid-to-top economics (shared by the my-campaigns header and the
// full-screen "outbid" button) -------------------------------------------
const minBidMicro = () => (info?.adUnit?.minBidUsd ?? 1) * USD;
const incrementMicro = () => (info?.adUnit?.minBidIncrementUsd ?? 0.5) * USD;

// The micro-USD bid required to claim rank #1, ignoring `excludeId` (the
// caller's own campaign when it may already lead). Empty board → the floor.
function bidToTopMicro(excludeId = null) {
  const top = board.find((b) => b.campaignId !== excludeId);
  return top ? top.bidPerBlockMicro + incrementMicro() : minBidMicro();
}
// As a whole-cent USD number, rounded up so it always clears the threshold.
const bidToTopUsd = (excludeId = null) => Math.ceil((bidToTopMicro(excludeId) / USD) * 100) / 100;

// ---- SIWE session (server-side, cookie-backed — works from any browser) ----

let session = null; // { wallet, label, settingsSet } or null

// The active wallet: the Farcaster Mini App host wallet when the console runs
// inside a Farcaster client, otherwise the injected browser wallet.
const eth = () => provider();

// The marketplace's settlement network (CAIP-2), once /v1/info has loaded.
const payNetwork = () => info?.paymentRails?.primary?.network;

// Put the connected wallet on the marketplace's network before we ask it to
// sign. Best-effort: a failure here is surfaced but never silently wrong — the
// signed authorization carries the chainId regardless.
async function ensurePayChain() {
  const network = payNetwork();
  if (!network) return;
  await ensureChain(eth(), network, {
    onSwitching: (name) => toast(`switch your wallet to ${name} — confirm the prompt`),
  });
}

async function loadSession() {
  try {
    const { body } = await api("/v1/auth/session");
    session = body.signedIn ? body : null;
  } catch {
    session = null;
  }
  renderSession();
  if (session && !session.settingsSet) openSettings({ forced: true });
}

async function signIn() {
  if (!eth()) {
    toast("no browser wallet found — install MetaMask or Coinbase Wallet", "err");
    return;
  }
  const btn = $("#sign-in");
  btn.disabled = true;
  btn.textContent = "check your wallet…";
  try {
    const [account] = await eth().request({ method: "eth_requestAccounts" });
    if (!account) return;
    // Land on the marketplace's chain so the SIWE chain id matches and the
    // wallet is ready to pay without a second switch.
    await ensurePayChain().catch(() => {});
    const { nonce, message } = (await api(`/v1/auth/nonce?address=${account}`)).body;
    // personal_sign takes the message hex-encoded; the wallet shows it as text.
    const hex =
      "0x" + [...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const signature = await eth().request({ method: "personal_sign", params: [hex, account] });
    const { status, body } = await api("/v1/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce, signature }),
    });
    if (status !== 200) throw new Error(body?.error ?? `${status}`);
    setSessionToken(body.token); // survives webviews that drop the session cookie
    session = body;
    renderSession();
    toast(`✓ signed in as ${shortWallet(session.wallet)}`);
    await refreshAll();
    // First run: the board name must be picked before anything else.
    if (!session.settingsSet) openSettings({ forced: true });
  } catch (err) {
    toast(`sign-in failed: ${err.message ?? err}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "sign in with wallet";
  }
}

async function signOut() {
  try {
    await api("/v1/auth/logout", { method: "POST" });
  } catch {}
  setSessionToken(null);
  session = null;
  renderSession();
  toast("signed out");
  await refreshAll().catch(() => {});
}

function renderSession() {
  const signedIn = !!session;
  $("#signed-out").hidden = signedIn;
  $("#signed-in").hidden = !signedIn;
  if (signedIn) {
    $("#acct-label").textContent = session.label ?? "unnamed board";
    $("#acct-wallet").textContent = shortWallet(session.wallet);
  }
  // The gate: creating campaigns needs a signed-in wallet.
  $("#open-create").disabled = !signedIn;
  $("#create-gate").hidden = signedIn;
}

$("#sign-in").addEventListener("click", signIn);
$("#create-gate-signin").addEventListener("click", signIn);
$("#sign-out").addEventListener("click", signOut);

// ---- account settings modal ----

const settingsDialog = $("#settings-dialog");
let settingsForced = false; // first run: no escape until the board name is saved

function openSettings({ forced = false } = {}) {
  if (!session) return;
  settingsForced = forced;
  $("#settings-welcome").hidden = !forced;
  for (const b of settingsDialog.querySelectorAll(".settings-close-btn")) b.hidden = forced;
  $("#settings-wallet").value = session.wallet;
  $("#settings-label").value = session.label ?? "";
  if (!settingsDialog.open) settingsDialog.showModal();
  $("#settings-label").focus();
}

settingsDialog.addEventListener("cancel", (e) => {
  if (settingsForced) e.preventDefault(); // Esc doesn't skip the first-run setup
});

$("#open-settings").addEventListener("click", () => openSettings());

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = $("#settings-label").value.trim();
  if (!label) return;
  try {
    const { body } = await api("/v1/account", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    session = body;
    settingsForced = false;
    settingsDialog.close();
    renderSession();
    toast("✓ settings saved");
    await refreshAll();
  } catch (err) {
    toast(`save failed: ${err.message}`, "err");
  }
});

// The x402 payment signer must be the session wallet if the provider has it
// unlocked; any unlocked account still works (funding is open to anyone).
async function signingAccount() {
  if (!eth()) {
    toast("no browser wallet found to sign the payment", "err");
    return null;
  }
  const unlocked = (await eth().request({ method: "eth_accounts" })) ?? [];
  const target = session?.wallet;
  const match = target && unlocked.find((a) => a.toLowerCase() === target);
  if (match) return match;
  const requested = (await eth().request({ method: "eth_requestAccounts" }).catch(() => [])) ?? [];
  return (target && requested.find((a) => a.toLowerCase() === target)) ?? requested[0] ?? null;
}

// Legacy manage keys: campaigns created before wallet sign-in (or over the
// bare API) are still reachable through the key this browser holds.
function manageKeys() {
  try {
    return JSON.parse(localStorage.getItem("cv_keys") ?? "{}");
  } catch {
    return {};
  }
}
function saveManageKey(id, key) {
  const keys = manageKeys();
  keys[id] = key;
  localStorage.setItem("cv_keys", JSON.stringify(keys));
}
function dropManageKey(id) {
  const keys = manageKeys();
  delete keys[id];
  localStorage.setItem("cv_keys", JSON.stringify(keys));
}
const keyFor = (id) => manageKeys()[id];

/** Auth headers for managing one campaign: the session cookie rides along
 *  automatically; a locally-held manage key covers legacy campaigns. */
function manageHeaders(id, extra = {}) {
  const key = keyFor(id);
  return key ? { ...extra, "x-manage-key": key } : extra;
}

let mine = [];
let mineIds = new Set();

async function loadMine() {
  let rows = [];
  if (session) {
    try {
      rows = (await api("/v1/me/campaigns")).body.campaigns ?? [];
    } catch {
      rows = [];
    }
  }
  const owned = new Set(rows.map((c) => c.id));
  const keys = manageKeys();
  const legacy = await Promise.all(
    Object.keys(keys)
      .filter((id) => !owned.has(id))
      .map(async (id) => {
        const res = await fetch(`/v1/campaigns/${encodeURIComponent(id)}`, {
          headers: { "x-manage-key": keys[id] },
        });
        if (res.status === 404) {
          dropManageKey(id);
          return null;
        }
        return res.ok ? res.json() : null;
      }),
  );
  mine = [...rows, ...legacy.filter(Boolean)];
  mineIds = new Set(mine.map((c) => c.id));
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

let toastTimer;
function toast(msg, kind = "ok") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `show ${kind}`;
  // Popover puts the toast in the top layer, above any open modal dialog
  // (z-index alone can't — showModal() dialogs sit in the top layer too).
  try {
    el.showPopover?.();
  } catch {}
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "";
    try {
      el.hidePopover?.();
    } catch {}
  }, 3500);
}

// The session token is mirrored client-side so it can ride an X-Session-Token
// header: inside a Farcaster Mini App webview the page is cross-site to the
// host, so the session cookie is third-party and frequently dropped.
const SESSION_TOKEN_KEY = "cv_session_token";
function getSessionToken() {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY) || undefined;
  } catch {
    return undefined;
  }
}
function setSessionToken(token) {
  try {
    if (token) localStorage.setItem(SESSION_TOKEN_KEY, token);
    else localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {}
}

async function api(path, opts = {}) {
  const token = getSessionToken();
  // credentials:"include" keeps the cookie path working where 3p cookies are
  // allowed; the header is the fallback where they aren't.
  const headers = token ? { ...(opts.headers ?? {}), "x-session-token": token } : opts.headers;
  const res = await fetch(path, { credentials: "include", ...opts, ...(headers ? { headers } : {}) });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok && res.status !== 402 && res.status !== 401)
    throw new Error(body?.error ? JSON.stringify(body.error) : `${res.status}`);
  return { status: res.status, body };
}

// ---- dialogs ----

const createDialog = $("#create-dialog");
const manageDialog = $("#manage-dialog");

// In-app replacement for window.confirm(): the Farcaster Mini App webview is
// sandboxed without "allow-modals", so confirm()/alert() are silently ignored.
// Resolves true on confirm, false on cancel/backdrop/Escape.
const confirmDialog = $("#confirm-dialog");
function confirmModal(message, { title = "confirm", okLabel = "confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    const okBtn = $("#confirm-ok");
    okBtn.textContent = okLabel;
    // danger → red outline (just .danger); otherwise the accent-filled .primary.
    okBtn.classList.toggle("danger", danger);
    okBtn.classList.toggle("primary", !danger);
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      okBtn.removeEventListener("click", onOk);
      $("#confirm-cancel").removeEventListener("click", onCancel);
      confirmDialog.removeEventListener("close", onCancel);
      if (confirmDialog.open) confirmDialog.close();
      resolve(val);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    okBtn.addEventListener("click", onOk);
    $("#confirm-cancel").addEventListener("click", onCancel);
    // Fires on Escape and backdrop click (handled by the shared dialog listener).
    confirmDialog.addEventListener("close", onCancel);
    confirmDialog.showModal();
  });
}

// A click on the backdrop (the dialog element itself, not its content) closes —
// except the forced first-run settings pass, which only "save" dismisses.
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", (e) => {
    if (e.target !== d) return;
    if (d === settingsDialog && settingsForced) return;
    d.close();
  });
}
document.addEventListener("click", (e) => {
  const closer = e.target.closest("[data-close]");
  if (closer) closer.closest("dialog")?.close();
});

function openCreate({ bidUsd } = {}) {
  if (info) {
    $("#bid").min = info.adUnit.minBidUsd;
    $("#bid-hint").textContent = `min bid $${info.adUnit.minBidUsd.toFixed(2)} / block · 1 block = ${info.adUnit.block}`;
  }
  if (bidUsd != null) $("#bid").value = bidUsd.toFixed(2);
  createDialog.showModal();
  $("#message").focus();
}

$("#open-create").addEventListener("click", () => openCreate());

// ---- market facts ----

async function loadInfo() {
  info = (await api("/v1/info")).body;
  const rail = info.paymentRails.primary;
  $("#market-facts").innerHTML = `
    <div class="fact">payment rail <b><span class="rail-badge">${esc(rail.rail)} · ${esc(rail.asset)} · ${esc(rail.mode)}</span></b></div>
    <div class="fact">ad unit <b>${esc(info.adUnit.block)}</b></div>
    <div class="fact">min bid <b>$${info.adUnit.minBidUsd.toFixed(2)} / block</b></div>
    <div class="fact">min raise <b>$${info.adUnit.minBidIncrementUsd.toFixed(2)}</b></div>
    <div class="fact">click rate <b>${info.adUnit.clickMultiplier}× impression</b></div>
    <div class="fact">publisher share <b>${Math.round(info.publisherShare * 100)}%</b></div>`;
}

// ---- auction board ----

function boardRowsHtml() {
  return board
    .map((b) => {
      const isMine = mineIds.has(b.campaignId);
      return `<tr class="${isMine ? "row-mine" : ""}">
        <td data-l="#">${b.rank}</td>
        <td data-l="campaign" class="mono cell-msg" title="${esc(b.campaignId)}">${esc(b.message)}</td>
        <td data-l="advertiser" class="mono">${esc(b.advertiser)}${isMine ? " (you)" : ""}</td>
        <td data-l="bid / block" class="mono">${fmt(b.bidPerBlockMicro)}</td>
        <td data-l="remaining" class="mono">${fmt(b.remainingMicro)}</td>
        <td data-l="" class="cell-serving">${b.serving ? '<span class="serving">● SERVING</span>' : ""}</td>
      </tr>`;
    })
    .join("");
}

async function refreshBoard() {
  board = (await api("/v1/auction")).body.board;
  const rows = boardRowsHtml();
  $("#board-empty").hidden = board.length > 0;
  $("#board").style.display = board.length ? "" : "none";
  $("#board tbody").innerHTML = rows;
  renderBidToTop();
  if (fullboardDialog.open) renderFullboard(rows);
}

// The "what's the bid to top" condition above my campaigns. It frames every
// other action — create or raise — around one number.
function renderBidToTop() {
  const el = $("#bid-to-top");
  if (!el) return;
  const toTop = `$${bidToTopUsd().toFixed(2)}/block`;
  if (!board.length) {
    el.innerHTML = `the board is open — bid <b>${toTop}</b> to claim <b>#1</b> and serve under every agent.`;
    return;
  }
  const leader = board[0];
  if (mineIds.has(leader.campaignId)) {
    el.innerHTML = `your campaign <b>leads</b> at ${fmt(leader.bidPerBlockMicro)}/block — bid <b>${toTop}</b> to extend your lead.`;
    return;
  }
  el.innerHTML = `top bid is <b>${fmt(leader.bidPerBlockMicro)}/block</b> — bid <b>${toTop}</b> to take <b>#1</b>.`;
}

// ---- full-screen auction board (spectator view + one-click outbid) ----

const fullboardDialog = $("#fullboard-dialog");

function renderFullboard(rows = boardRowsHtml()) {
  $("#fullboard-empty").hidden = board.length > 0;
  $("#fullboard-table").style.display = board.length ? "" : "none";
  $("#fullboard-table tbody").innerHTML = rows;
  const toTop = `$${bidToTopUsd().toFixed(2)}/block`;
  const btn = $("#fullboard-outbid");
  if (board.length) {
    $("#fullboard-sub").textContent = `${board.length} campaign${board.length === 1 ? "" : "s"} bidding · top line serves under every AI coding agent`;
    btn.textContent = `outbid the top line — ${toTop}`;
  } else {
    $("#fullboard-sub").textContent = "no one is bidding yet — the first funded line serves under every agent";
    btn.textContent = `claim the board — ${toTop}`;
  }
  $("#fullboard-foot").textContent = session
    ? `signed in as ${session.label ?? shortWallet(session.wallet)}`
    : "sign in with your wallet to outbid — it's a free signature, no gas";
}

function openFullboard() {
  renderFullboard();
  if (!fullboardDialog.open) fullboardDialog.showModal();
}

$("#open-fullboard").addEventListener("click", openFullboard);

// The headline action: outbid whoever is on top. Branches on how many
// campaigns the bidder owns — none (create one, bid prefilled), one (raise
// it), or several (pick which one to raise).
$("#fullboard-outbid").addEventListener("click", async () => {
  if (!session) {
    toast("sign in with your wallet to outbid", "err");
    await signIn();
    if (!session) return;
  }
  const targetUsd = bidToTopUsd();
  const owned = mine.filter((c) => c.status !== "cancelled");
  if (owned.length === 0) {
    fullboardDialog.close();
    openCreate({ bidUsd: targetUsd });
  } else if (owned.length === 1) {
    await raiseToTop(owned[0], targetUsd);
  } else {
    openPicker(targetUsd);
  }
});

// Raise one campaign to (at least) the bid-to-top price. The server requires a
// raise of >= current + increment, so a campaign already on top still nudges up.
async function raiseToTop(c, targetUsd) {
  const floorUsd = c.bid_per_block_micro / USD + (info?.adUnit?.minBidIncrementUsd ?? 0.5);
  const newBid = Math.ceil(Math.max(targetUsd, floorUsd) * 100) / 100;
  try {
    await api(`/v1/campaigns/${c.id}/bid`, {
      method: "POST",
      headers: manageHeaders(c.id, { "content-type": "application/json" }),
      body: JSON.stringify({ bidPerBlockUsd: newBid }),
    });
    toast(`✓ "${c.message}" now bids $${newBid.toFixed(2)}/block`);
    await refreshAll();
    if (needsFunding(c)) toast("bid raised — fund the campaign to actually serve", "err");
  } catch (err) {
    toast(`outbid failed: ${err.message}`, "err");
  }
}

// Case (c): more than one campaign — let the bidder choose which one outbids.
const pickDialog = $("#pick-dialog");
let pickTargetUsd = 0;

function openPicker(targetUsd) {
  pickTargetUsd = targetUsd;
  $("#pick-sub").textContent = `raise the chosen campaign to $${targetUsd.toFixed(2)}/block to take #1.`;
  $("#pick-list").innerHTML = mine
    .filter((c) => c.status !== "cancelled")
    .map((c) => {
      const onBoard = board.find((b) => b.campaignId === c.id);
      const at = onBoard ? `#${onBoard.rank} · ` : "";
      return `<button class="pick-row" type="button" data-id="${c.id}">
        <span class="pick-msg mono">${esc(c.message)}</span>
        <span class="pick-meta">${at}${fmt(c.bid_per_block_micro)}/block</span>
      </button>`;
    })
    .join("");
  if (!pickDialog.open) pickDialog.showModal();
}

$("#pick-list").addEventListener("click", async (e) => {
  const row = e.target.closest(".pick-row");
  if (!row) return;
  const c = mine.find((m) => m.id === row.dataset.id);
  pickDialog.close();
  if (c) await raiseToTop(c, pickTargetUsd);
});

// ---- create campaign (modal) ----

$("#message").addEventListener("input", () => {
  $("#charcount").textContent = `${$("#message").value.length}/80`;
  $("#preview-msg").textContent = $("#message").value || "your message here";
});

$("#create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!session) {
    createDialog.close();
    toast("sign in with your wallet first", "err");
    return;
  }
  try {
    // The session carries advertiser wallet and board name — only the creative goes up.
    const { body } = await api("/v1/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: $("#message").value,
        url: $("#url").value,
        bidPerBlockUsd: Number($("#bid").value),
      }),
    });
    if (body.manageKey) saveManageKey(body.campaign.id, body.manageKey); // API credential, kept as a local backup
    createDialog.close();
    $("#create-form").reset();
    $("#charcount").textContent = "0/80";
    $("#preview-msg").textContent = "your message here";
    toast(`✓ campaign created — fund it to start serving`);
    await refreshAll();
    openManage(body.campaign.id, { focusFund: true });
  } catch (err) {
    toast(`create failed: ${err.message}`, "err");
  }
});

// ---- my campaigns (compact list; tap to manage) ----

function statusBadge(c) {
  if (c.status === "cancelled") return '<span class="badge badge-dead">cancelled</span>';
  if (needsFunding(c)) return '<span class="badge badge-unfunded">⚠ not funded</span>';
  if (c.status === "paused") return '<span class="badge badge-warn">paused</span>';
  const onBoard = board.find((b) => b.campaignId === c.id);
  if (onBoard?.serving) return '<span class="badge badge-live">● serving</span>';
  if (onBoard) return `<span class="badge">rank #${onBoard.rank}</span>`;
  return '<span class="badge badge-warn">off board — fund it</span>';
}

const remainingOf = (c) => c.budget_micro - c.spent_micro - (c.refunded_micro ?? 0);
const needsFunding = (c) => c.status !== "cancelled" && remainingOf(c) <= 0;
const unfundedReason = (c) =>
  c.budget_micro === 0 ? "no budget yet" : "budget fully spent";

function renderMine() {
  if (!mine.length) {
    $("#mine-hint").style.display = "";
    $("#mine").innerHTML = session
      ? '<p class="empty">no campaigns yet — hit <b>+ new campaign</b> above to put your line on the board.</p>'
      : '<p class="empty"><b>sign in with your wallet</b> (top right) to create campaigns and manage them from any browser.</p>';
    return;
  }
  $("#mine-hint").style.display = "none";
  $("#mine").innerHTML = mine
    .map((c) => {
      const pct = c.budget_micro ? Math.min(100, (c.spent_micro / c.budget_micro) * 100) : 0;
      const unfunded = needsFunding(c);
      return `<div class="campaign ${c.status === "cancelled" ? "cancelled" : ""} ${unfunded ? "unfunded" : ""}" data-id="${c.id}" role="button" tabindex="0" aria-label="manage campaign">
        <div class="top">
          <span class="msg">${esc(c.message)}</span>
          ${statusBadge(c)}
        </div>
        <div class="stats">
          <span>bid <b>${fmt(c.bid_per_block_micro)}/block</b></span>
          <span>spent <b>${fmt(c.spent_micro, 4)}</b></span>
          <span>budget <b>${fmt(c.budget_micro)}</b></span>
        </div>
        <div class="budgetbar"><div style="width:${pct}%"></div></div>
        ${unfunded ? `<p class="unfunded-note">${unfundedReason(c)} — this campaign is off the board and not serving.</p>` : ""}
        <div class="card-foot">
          <span class="meta">${esc(c.id)}</span>
          ${
            unfunded
              ? `<button class="primary fund-cta" type="button">fund campaign ›</button>`
              : `<button class="ghost manage-btn" type="button">manage ›</button>`
          }
        </div>
      </div>`;
    })
    .join("");
}

$("#mine").addEventListener("click", (e) => {
  const card = e.target.closest(".campaign");
  if (card) openManage(card.dataset.id, { focusFund: !!e.target.closest(".fund-cta") });
});
$("#mine").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest(".campaign");
  if (card) {
    e.preventDefault();
    openManage(card.dataset.id);
  }
});

// ---- manage dialog ----

let managedId = null;

function openManage(id, { focusFund = false } = {}) {
  managedId = id;
  renderManage()
    .then(() => {
      if (!focusFund) return;
      const fund = $("#manage-body .fund-section");
      fund?.scrollIntoView({ block: "nearest" });
      fund?.querySelector(".blocks-input")?.focus();
    })
    .catch((err) => toast(`load failed: ${err.message}`, "err"));
  if (!manageDialog.open) manageDialog.showModal();
}

manageDialog.addEventListener("close", () => {
  managedId = null;
  $("#manage-body").innerHTML = "";
});

async function renderManage() {
  const c = mine.find((m) => m.id === managedId);
  if (!c) {
    manageDialog.close();
    return;
  }
  const remaining = remainingOf(c);

  if (c.status === "cancelled") {
    // Terminal: show the refund trail, a retry if escrow is stranded, and
    // the local remove that hides it from this list.
    const refunds = (c.refunds ?? [])
      .map(
        (r) =>
          `<span>refund <b>${fmt(r.amount_micro)}</b> → ${esc(r.wallet.slice(0, 6))}…${esc(r.wallet.slice(-4))} <b class="${r.status === "sent" ? "ok-text" : ""}">${esc(r.status)}</b>${r.tx ? ` · tx ${esc(r.tx.slice(0, 10))}…` : ""}</span>`,
      )
      .join("");
    $("#manage-body").innerHTML = `
      <div class="dialog-head">
        <h3>manage campaign</h3>
        <button class="icon-btn" type="button" data-close aria-label="close">✕</button>
      </div>
      <p class="manage-msg">${esc(c.message)}</p>
      <p class="meta">${statusBadge(c)} · ${esc(c.id)}</p>
      <div class="stat-grid">
        <div class="stat"><span>budget</span><b>${fmt(c.budget_micro)}</b></div>
        <div class="stat"><span>spent</span><b>${fmt(c.spent_micro, 4)}</b></div>
        <div class="stat"><span>withdrawn</span><b>${fmt(c.refunded_micro ?? 0)}</b></div>
        ${remaining > 0 ? `<div class="stat"><span>still in escrow</span><b>${fmt(remaining, 4)}</b></div>` : ""}
      </div>
      ${refunds ? `<div class="refunds">${refunds}</div>` : ""}
      <div class="manage-section">
        ${remaining > 0 ? `<button class="primary withdraw-btn" type="button">withdraw ${fmt(remaining, 4)}</button>` : ""}
        ${keyFor(c.id) ? `<button class="ghost remove-btn" type="button">remove from this browser</button>` : ""}
      </div>`;
    return;
  }

  const stats = (
    await api(`/v1/campaigns/${c.id}/stats`, { headers: manageHeaders(c.id) })
  ).body;
  if (managedId !== c.id) return; // dialog moved on while stats loaded
  const pct = c.budget_micro ? Math.min(100, (c.spent_micro / c.budget_micro) * 100) : 0;
  const minRaise = ((c.bid_per_block_micro + (info?.adUnit.minBidIncrementUsd ?? 0.5) * USD) / USD).toFixed(2);
  $("#manage-body").innerHTML = `
    <div class="dialog-head">
      <h3>manage campaign</h3>
      <button class="icon-btn" type="button" data-close aria-label="close">✕</button>
    </div>
    <p class="manage-msg">${esc(c.message)}</p>
    <p class="meta">${statusBadge(c)} · ${esc(c.id)}</p>
    ${
      needsFunding(c)
        ? `<div class="notice notice-unfunded"><b>⚠ not funded</b> — ${unfundedReason(c)}. this campaign is off the board and not serving. fund at least 1 block below to go live${c.status === "paused" ? " (then resume it)" : ""}.</div>`
        : ""
    }
    <div class="stat-grid">
      <div class="stat"><span>bid / block</span><b>${fmt(c.bid_per_block_micro)}</b></div>
      <div class="stat"><span>budget</span><b>${fmt(c.budget_micro)}</b></div>
      <div class="stat"><span>spent</span><b>${fmt(c.spent_micro, 4)}</b></div>
      <div class="stat"><span>impressions</span><b>${stats.impressions}</b></div>
      <div class="stat"><span>clicks</span><b>${stats.clicks}</b></div>
      <div class="stat"><span>publishers</span><b>${stats.publishers}</b></div>
    </div>
    <div class="budgetbar"><div style="width:${pct}%"></div></div>
    <div class="manage-section fund-section">
      <h4>fund budget</h4>
      <div class="control-row">
        <div class="field"><label for="manage-blocks">blocks</label><input id="manage-blocks" name="blocks" type="number" min="1" value="1" class="blocks-input" inputmode="numeric" autocomplete="off" /></div>
        <button class="primary fund-btn" type="button">fund <span class="fund-cost">${fmt(c.bid_per_block_micro)}</span> via 402</button>
      </div>
      <p class="hint">1 block = 1,000 impressions at your current bid</p>
    </div>
    <div class="manage-section">
      <h4>raise bid</h4>
      <div class="control-row">
        <div class="field"><label for="manage-bid">new bid $ / block</label><input id="manage-bid" name="newBid" type="number" step="0.5" class="bid-input" value="${minRaise}" inputmode="decimal" autocomplete="off" /></div>
        <button class="ghost raise-btn" type="button">raise bid</button>
      </div>
    </div>
    <div class="manage-section danger-zone">
      <button class="ghost pause-btn" type="button">${c.status === "paused" ? "▶ resume" : "⏸ pause"}</button>
      <button class="ghost danger cancel-btn" type="button">cancel campaign${remaining > 0 ? ` + withdraw ${fmt(remaining, 4)}` : ""}</button>
    </div>`;
}

// Live cost estimate next to the fund button (price is bid × blocks).
$("#manage-body").addEventListener("input", (e) => {
  if (!e.target.classList.contains("blocks-input")) return;
  const c = mine.find((m) => m.id === managedId);
  const cost = $("#manage-body .fund-cost");
  if (c && cost) cost.textContent = fmt(c.bid_per_block_micro * Math.max(1, Number(e.target.value) || 1));
});

$("#manage-body").addEventListener("click", async (e) => {
  const id = managedId;
  if (!id) return;
  if (e.target.closest(".fund-btn")) {
    await fund(id, Number($("#manage-body .blocks-input").value));
  } else if (e.target.closest(".raise-btn")) {
    try {
      await api(`/v1/campaigns/${id}/bid`, {
        method: "POST",
        headers: manageHeaders(id, { "content-type": "application/json" }),
        body: JSON.stringify({ bidPerBlockUsd: Number($("#manage-body .bid-input").value) }),
      });
      toast("bid raised");
      await refreshAll();
    } catch (err) {
      toast(`raise failed: ${err.message}`, "err");
    }
  } else if (e.target.closest(".pause-btn")) {
    try {
      const c = mine.find((m) => m.id === id);
      const action = c?.status === "paused" ? "resume" : "pause";
      await api(`/v1/campaigns/${id}/${action}`, {
        method: "POST",
        headers: manageHeaders(id),
      });
      toast(`campaign ${action}d`);
      await refreshAll();
    } catch (err) {
      toast(`pause failed: ${err.message}`, "err");
    }
  } else if (e.target.closest(".cancel-btn")) {
    await cancelCampaign(id);
  } else if (e.target.closest(".withdraw-btn")) {
    await withdrawCampaign(id);
  } else if (e.target.closest(".remove-btn")) {
    if (
      await confirmModal(
        "You will no longer see this campaign (or its refunds) in this browser.",
        { title: "Forget manage key?", okLabel: "forget", danger: true },
      )
    ) {
      dropManageKey(id);
      manageDialog.close();
      toast("campaign removed from this browser");
      await refreshAll();
    }
  }
});

// ---- cancel & withdraw ----

// Where the unspent budget goes back to: the signed-in wallet. The server
// falls back to the campaign's own wallet, so signed-in owners can omit it —
// legacy manage-key campaigns must sign in to receive a refund.
function refundDestination(remaining) {
  if (remaining <= 0) return undefined;
  if (!session) {
    toast("sign in with your wallet to receive the unspent budget", "err");
    return null;
  }
  return session.wallet;
}

async function cancelCampaign(id) {
  const c = mine.find((m) => m.id === id);
  if (!c) return;
  const remaining = remainingOf(c);
  const to = refundDestination(remaining);
  if (to === null) return;
  const note =
    remaining > 0
      ? `The remaining ${fmt(remaining, 4)} will be withdrawn to ${to}.`
      : "It has no unspent budget.";
  if (
    !(await confirmModal(`It stops serving immediately and cannot be resumed. ${note}`, {
      title: "Cancel this campaign for good?",
      okLabel: "cancel campaign",
      danger: true,
    }))
  )
    return;
  try {
    const { body } = await api(`/v1/campaigns/${id}/cancel`, {
      method: "POST",
      headers: manageHeaders(id, { "content-type": "application/json" }),
      body: JSON.stringify(to ? { refundTo: to } : {}),
    });
    const r = body.refund;
    toast(
      r
        ? `✓ campaign cancelled — ${fmt(r.amount_micro)} refund ${r.status}${r.tx ? ` (tx ${r.tx.slice(0, 10)}…)` : ""}`
        : "✓ campaign cancelled",
    );
    await refreshAll();
  } catch (err) {
    toast(`cancel failed: ${err.message}`, "err");
  }
}

async function withdrawCampaign(id) {
  const c = mine.find((m) => m.id === id);
  if (!c) return;
  const remaining = remainingOf(c);
  const to = refundDestination(remaining);
  if (!to) return;
  try {
    const { body } = await api(`/v1/campaigns/${id}/withdraw`, {
      method: "POST",
      headers: manageHeaders(id, { "content-type": "application/json" }),
      body: JSON.stringify({ refundTo: to }),
    });
    const p = body.payout;
    toast(`✓ withdrawal of ${fmt(p.amount_micro)} ${p.status}${p.tx ? ` (tx ${p.tx.slice(0, 10)}…)` : ""}`);
    await refreshAll();
  } catch (err) {
    toast(`withdraw failed: ${err.message}`, "err");
  }
}

// ---- funding through the 402 ----

async function fund(id, blocks) {
  const url = `/v1/fund?campaign=${encodeURIComponent(id)}&blocks=${blocks}`;
  const mock = info?.paymentRails.primary.mode === "mock";
  try {
    // First request carries no payment: surface the 402 like any x402 client.
    const first = await fetch(url, { method: "POST" });
    const firstBody = await first.json().catch(() => null);
    if (first.status !== 402) {
      if (!first.ok) return toast(`funding failed: ${firstBody?.error ?? first.status}`, "err");
      toast(`funded ${firstBody?.funded ?? ""}`);
      return refreshAll();
    }
    if (mock) {
      // The mock rail settles via header — same retry-with-payment control flow.
      const paid = await api(url, {
        method: "POST",
        headers: { "x-mock-payment": session?.wallet ?? "anon" },
      });
      if (paid.status === 201) {
        toast(`✓ funded ${paid.body.funded} (payment ${paid.body.payment.id})`);
        return refreshAll();
      }
      return toast(`funding failed: ${JSON.stringify(paid.body)}`, "err");
    }
    // Real x402 rail. v2 servers put the challenge in the PAYMENT-REQUIRED
    // header (the JSON body is empty); fall back to the body for older rails.
    const paymentRequired = parsePaymentRequired(
      first.headers.get("PAYMENT-REQUIRED"),
      firstBody,
    );
    if (!eth()) return showPayFallback(paymentRequired, url, blocks);

    // Pay right here: sign the EIP-3009 transfer authorization with the
    // connected wallet (gasless — the facilitator submits it on-chain).
    const account = await signingAccount();
    if (!account) return;
    // The wallet must be on the settlement chain before signing.
    await ensurePayChain();
    const { header, accept } = await createPaymentSignatureHeader({
      paymentRequired,
      from: account,
      signTypedData: (typedData) =>
        eth().request({
          method: "eth_signTypedData_v4",
          params: [account, JSON.stringify(typedData)],
        }),
    });
    toast(`payment signed — settling ${fmt(Number(accept.amount))} USDC on-chain…`);
    const paid = await fetch(url, { method: "POST", headers: { "PAYMENT-SIGNATURE": header } });
    const paidBody = await paid.json().catch(() => null);
    if (!paid.ok) {
      return toast(`settlement failed: ${paidBody?.error ?? paid.status}`, "err");
    }
    const settle = parsePaymentResponse(paid.headers.get("PAYMENT-RESPONSE"));
    const tx = settle?.transaction ? ` — tx ${settle.transaction.slice(0, 10)}…` : "";
    toast(`✓ funded ${paidBody?.funded ?? ""}${tx}`);
    return refreshAll();
  } catch (err) {
    toast(`funding failed: ${err.message}`, "err");
  }
}

// No injected wallet: show the challenge and how to pay it programmatically.
function showPayFallback(paymentRequired, url, blocks) {
  const accept = paymentRequired.accepts?.[0] ?? {};
  $("#pay-summary").textContent = `This marketplace wants ${accept.amount ?? "?"} (micro)USDC on ${accept.network ?? "?"} to fund ${blocks} block(s).`;
  $("#pay-challenge").textContent = JSON.stringify(paymentRequired, null, 2);
  $("#pay-snippet").textContent = [
    `import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";`,
    `import { ExactEvmScheme } from "@x402/evm/exact/client";`,
    `import { privateKeyToAccount } from "viem/accounts";`,
    ``,
    `const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{`,
    `  network: "${accept.network ?? "eip155:8453"}",`,
    `  client: new ExactEvmScheme(privateKeyToAccount(PRIVATE_KEY)) }] });`,
    `await pay("${location.origin}${url}", { method: "POST" });`,
  ].join("\n");
  $("#pay-dialog").showModal();
}

$("#pay-close").addEventListener("click", () => $("#pay-dialog").close());

// ---- boot ----

async function refreshAll() {
  await loadMine(); // first: the board marks "(you)" rows by my campaign ids
  await refreshBoard();
  renderMine();
  // Keep an open manage dialog live, but never clobber a field mid-edit
  // (focused buttons are fine to replace — only typing must be preserved).
  const active = document.activeElement;
  const editing = active?.tagName === "INPUT" && $("#manage-body").contains(active);
  if (managedId && !editing) {
    await renderManage();
  }
}

// Resolve the Farcaster Mini App host wallet (and dismiss its splash) before
// the first render; never blocks boot if the SDK is unreachable.
initWallet()
  .then(({ inMiniApp }) => {
    if (inMiniApp) document.documentElement.classList.add("in-miniapp");
  })
  .catch(() => {})
  .then(loadSession)
  .then(loadInfo)
  .then(refreshAll)
  // Deep link from the landing page: /console.html#board lands straight in the
  // full-screen spectator board.
  .then(() => {
    if (location.hash === "#board") openFullboard();
  })
  .catch((err) => toast(`marketplace unreachable: ${err.message}`, "err"));
// Also respond to in-page hash changes (e.g. clicking a #board link).
window.addEventListener("hashchange", () => {
  if (location.hash === "#board") openFullboard();
});
setInterval(() => refreshAll().catch(() => {}), 3000);
