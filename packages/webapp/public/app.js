/* Codevertise advertiser console — vanilla JS, talks to the marketplace API on the same origin. */

const $ = (sel) => document.querySelector(sel);
const USD = 1_000_000;
const fmt = (micro, dp = 2) => `$${(micro / USD).toFixed(dp)}`;

let info = null;
let board = [];

const wallet = () => $("#wallet").value.trim();
const advLabel = () => $("#adv-label").value.trim();

// My campaigns = campaigns whose manage key this browser holds. The key is
// issued once at creation and stored in localStorage; the API never lists
// campaigns by wallet (that would let anyone enumerate an advertiser).
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

let mine = [];
let mineIds = new Set();

async function loadMine() {
  const keys = manageKeys();
  const rows = await Promise.all(
    Object.keys(keys).map(async (id) => {
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
  mine = rows.filter(Boolean);
  mineIds = new Set(mine.map((c) => c.id));
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function toast(msg, kind = "ok") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `show ${kind}`;
  setTimeout(() => (el.className = ""), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok && res.status !== 402) throw new Error(body?.error ? JSON.stringify(body.error) : `${res.status}`);
  return { status: res.status, body };
}

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

async function refreshBoard() {
  board = (await api("/v1/auction")).body.board;
  $("#board tbody").innerHTML = board
    .map((b) => {
      const isMine = mineIds.has(b.campaignId);
      return `<tr class="${isMine ? "row-mine" : ""}">
        <td>${b.rank}</td>
        <td class="mono" title="${esc(b.campaignId)}">${esc(b.message)}</td>
        <td class="mono">${esc(b.advertiser)}${isMine ? " (you)" : ""}</td>
        <td class="mono">${fmt(b.bidPerBlockMicro)}</td>
        <td class="mono">${fmt(b.remainingMicro)}</td>
        <td>${b.serving ? '<span class="serving">● SERVING</span>' : ""}</td>
      </tr>`;
    })
    .join("");
}

// ---- create campaign ----

$("#message").addEventListener("input", () => {
  $("#charcount").textContent = `${$("#message").value.length}/80`;
  $("#preview-msg").textContent = $("#message").value || "your message here";
});

$("#create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!wallet()) return toast("enter your advertiser wallet first", "err");
  try {
    const { body } = await api("/v1/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        advertiser: wallet(),
        label: advLabel() || undefined,
        message: $("#message").value,
        url: $("#url").value,
        bidPerBlockUsd: Number($("#bid").value),
      }),
    });
    saveManageKey(body.campaign.id, body.manageKey);
    toast(`campaign ${body.campaign.id} created — manage key saved in this browser; fund it to start serving`);
    $("#create-form").reset();
    $("#charcount").textContent = "0/80";
    $("#preview-msg").textContent = "your message here";
    await refreshAll();
  } catch (err) {
    toast(`create failed: ${err.message}`, "err");
  }
});

// ---- my campaigns ----

async function renderMine() {
  if (!mine.length) {
    $("#mine-hint").style.display = "";
    $("#mine").innerHTML = "";
    return;
  }
  $("#mine-hint").style.display = "none";
  const cards = await Promise.all(
    mine.map(async (c) => {
      const stats = (
        await api(`/v1/campaigns/${c.id}/stats`, { headers: { "x-manage-key": keyFor(c.id) } })
      ).body;
      const pct = c.budget_micro ? Math.min(100, (c.spent_micro / c.budget_micro) * 100) : 0;
      const onBoard = board.find((b) => b.campaignId === c.id);
      return `<div class="campaign" data-id="${c.id}">
        <div class="top">
          <span class="msg">${esc(c.message)}</span>
          <span class="meta">${onBoard?.serving ? '<span class="serving">● SERVING</span>' : onBoard ? `rank #${onBoard.rank}` : "off board"} · ${esc(c.id)}</span>
        </div>
        <div class="stats">
          <span>bid <b>${fmt(c.bid_per_block_micro)}/block</b></span>
          <span>budget <b>${fmt(c.budget_micro)}</b></span>
          <span>spent <b>${fmt(c.spent_micro, 4)}</b></span>
          <span>impressions <b>${stats.impressions}</b></span>
          <span>clicks <b>${stats.clicks}</b></span>
          <span>publishers <b>${stats.publishers}</b></span>
        </div>
        <div class="budgetbar"><div style="width:${pct}%"></div></div>
        <div class="actions">
          <label>blocks</label><input type="number" min="1" value="1" class="blocks-input" />
          <button class="fund-btn">fund via 402</button>
          <label>new bid $</label><input type="number" step="0.5" class="bid-input"
            value="${((c.bid_per_block_micro + (info?.adUnit.minBidIncrementUsd ?? 0.5) * USD) / USD).toFixed(2)}" />
          <button class="ghost raise-btn">raise bid</button>
          <button class="ghost pause-btn">${c.status === "paused" ? "resume" : "pause"}</button>
        </div>
      </div>`;
    }),
  );
  $("#mine").innerHTML = cards.join("");
}

document.addEventListener("click", async (e) => {
  const card = e.target.closest(".campaign");
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.classList.contains("fund-btn")) {
    await fund(id, Number(card.querySelector(".blocks-input").value));
  } else if (e.target.classList.contains("raise-btn")) {
    try {
      await api(`/v1/campaigns/${id}/bid`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-manage-key": keyFor(id) },
        body: JSON.stringify({ bidPerBlockUsd: Number(card.querySelector(".bid-input").value) }),
      });
      toast("bid raised");
      await refreshAll();
    } catch (err) {
      toast(`raise failed: ${err.message}`, "err");
    }
  } else if (e.target.classList.contains("pause-btn")) {
    try {
      const c = mine.find((m) => m.id === id);
      const action = c?.status === "paused" ? "resume" : "pause";
      await api(`/v1/campaigns/${id}/${action}`, {
        method: "POST",
        headers: { "x-manage-key": keyFor(id) },
      });
      toast(`campaign ${action}d`);
      await refreshAll();
    } catch (err) {
      toast(`pause failed: ${err.message}`, "err");
    }
  }
});

// ---- funding through the 402 ----

async function fund(id, blocks) {
  const url = `/v1/fund?campaign=${encodeURIComponent(id)}&blocks=${blocks}`;
  const mock = info?.paymentRails.primary.mode === "mock";
  try {
    // First request carries no payment: surface the 402 like any x402 client.
    const first = await api(url, { method: "POST" });
    if (first.status !== 402) {
      toast(`funded ${first.body.funded ?? ""}`);
      return refreshAll();
    }
    if (mock) {
      // The mock rail settles via header — same retry-with-payment control flow.
      const paid = await api(url, { method: "POST", headers: { "x-mock-payment": wallet() } });
      if (paid.status === 201) {
        toast(`✓ funded ${paid.body.funded} (payment ${paid.body.payment.id})`);
        return refreshAll();
      }
      return toast(`funding failed: ${JSON.stringify(paid.body)}`, "err");
    }
    // Real x402 rail: show the challenge and how to pay it programmatically.
    const accept = first.body.accepts?.[0] ?? first.body;
    $("#pay-summary").textContent = `This marketplace wants ${accept.amount ?? "?"} (micro)USDC on ${accept.network ?? "?"} to fund ${blocks} block(s).`;
    $("#pay-challenge").textContent = JSON.stringify(first.body, null, 2);
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
  } catch (err) {
    toast(`funding failed: ${err.message}`, "err");
  }
}

$("#pay-close").addEventListener("click", () => $("#pay-dialog").close());

// ---- boot ----

$("#wallet").value = localStorage.getItem("cv_wallet") ?? "";
$("#adv-label").value = localStorage.getItem("cv_label") ?? "";
$("#wallet").addEventListener("input", () => {
  localStorage.setItem("cv_wallet", wallet());
  refreshAll().catch(() => {});
});
$("#adv-label").addEventListener("input", () => {
  localStorage.setItem("cv_label", advLabel());
});

async function refreshAll() {
  await loadMine(); // first: the board marks "(you)" rows by my campaign ids
  await refreshBoard();
  await renderMine();
}

loadInfo()
  .then(refreshAll)
  .catch((err) => toast(`marketplace unreachable: ${err.message}`, "err"));
setInterval(() => refreshAll().catch(() => {}), 3000);
