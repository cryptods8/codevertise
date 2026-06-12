#!/usr/bin/env node
/**
 * codevertise — install and manage the Claude Code status-line extension.
 *
 *   codevertise install --wallet 0xYou [--endpoint URL]   wire up ~/.claude/settings.json
 *   codevertise uninstall                                 restore the previous status line
 *   codevertise status                                    config, current ad, last error
 *   codevertise earnings                                  ledger from the marketplace
 *   codevertise payout                                    request a USDC payout (≥ $10)
 *   codevertise open                                      open the sponsor link (counts a 50× click)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteJson,
  backupFile,
  claudeDir,
  cvHome,
  fetchEarnings,
  formatMicroUsd,
  loadConfig,
  loadState,
  reportEvent,
  requestPayout,
  saveConfig,
  saveState,
  defaultState,
  type Config,
} from "./common.js";

const STATUSLINE_CMD = "codevertise-statusline";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function settingsPath(): string {
  return join(claudeDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function install(): void {
  const wallet = arg("wallet");
  if (!wallet) {
    console.error("usage: codevertise install --wallet 0xYourPayoutAddress [--endpoint URL]");
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    console.warn(`warning: ${wallet} doesn't look like an EVM address; payouts are sent in USDC on Base`);
  }
  const cfg: Config = {
    endpoint: arg("endpoint") ?? loadConfig()?.endpoint ?? "http://localhost:4021",
    wallet,
    surface: arg("surface") ?? "claude-code-statusline",
    passthrough: loadConfig()?.passthrough,
  };

  const settings = readSettings();
  const existing = settings.statusLine as { type?: string; command?: string } | undefined;
  if (existing?.type === "command" && existing.command && existing.command !== STATUSLINE_CMD) {
    cfg.passthrough = existing.command;
    console.log(`preserving your existing status line; the ad is appended to its output:\n  ${existing.command}`);
  }
  saveConfig(cfg);
  saveState(defaultState());

  const backup = backupFile(settingsPath());
  settings.statusLine = { type: "command", command: STATUSLINE_CMD, refreshInterval: 1 };
  atomicWriteJson(settingsPath(), settings);

  console.log(`✓ statusLine wired in ${settingsPath()}${backup ? ` (backup: ${backup})` : ""}`);
  console.log(`✓ publisher wallet ${wallet} → ${cfg.endpoint}`);
  console.log("restart Claude Code (or open a new session) and the sponsored line appears while Claude thinks.");
  console.log("earnings accrue per 5s impression; check with: codevertise earnings");
}

function uninstall(): void {
  const cfg = loadConfig();
  const settings = readSettings();
  const backup = backupFile(settingsPath());
  if (cfg?.passthrough) {
    settings.statusLine = { type: "command", command: cfg.passthrough };
    console.log(`restored previous status line: ${cfg.passthrough}`);
  } else {
    delete settings.statusLine;
    console.log("statusLine removed from settings");
  }
  atomicWriteJson(settingsPath(), settings);
  console.log(`✓ updated ${settingsPath()}${backup ? ` (backup: ${backup})` : ""}`);
  console.log(`config and earnings state kept in ${cvHome()} (your balance lives on the marketplace)`);
}

async function status(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    console.log("not configured — run: codevertise install --wallet 0xYou");
    return;
  }
  const state = loadState();
  console.log(`endpoint   ${cfg.endpoint}`);
  console.log(`wallet     ${cfg.wallet}`);
  console.log(`surface    ${cfg.surface}`);
  if (cfg.passthrough) console.log(`chained    ${cfg.passthrough}`);
  console.log(`installed  ${existsSync(settingsPath()) && readFileSync(settingsPath(), "utf8").includes(STATUSLINE_CMD) ? "yes" : "no"}`);
  console.log(`current ad ${state.ad ? `"${state.ad.message}" (${state.ad.campaignId})` : "none"}`);
  console.log(`last error ${state.lastError ?? "none"}`);
  try {
    const e = await fetchEarnings(cfg);
    console.log(`withdrawable ${formatMicroUsd(e.withdrawableMicro)} (threshold ${formatMicroUsd(e.minPayoutMicro)})`);
  } catch {
    console.log(`withdrawable (marketplace unreachable)`);
  }
}

async function earnings(): Promise<void> {
  const cfg = mustConfig();
  const e = await fetchEarnings(cfg);
  console.log(`wallet        ${e.wallet}`);
  console.log(`earned        ${formatMicroUsd(e.earnedMicro)}`);
  console.log(`paid out      ${formatMicroUsd(e.paidMicro)}`);
  console.log(`withdrawable  ${formatMicroUsd(e.withdrawableMicro)} (payout at ${formatMicroUsd(e.minPayoutMicro)})`);
  if (e.payouts.length) console.log(`payouts       ${JSON.stringify(e.payouts, null, 2)}`);
}

async function payout(): Promise<void> {
  const cfg = mustConfig();
  const res = await requestPayout(cfg);
  console.log(JSON.stringify(res, null, 2));
}

async function open(): Promise<void> {
  const cfg = mustConfig();
  const state = loadState();
  if (!state.ad) {
    console.log("no ad currently serving");
    return;
  }
  const earned = await reportEvent(
    cfg,
    "click",
    state.ad.campaignId,
    `cc-click-${state.ad.campaignId}-${Date.now()}`,
  );
  console.log(`opening ${state.ad.url} (+${formatMicroUsd(earned)} for the click)`);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [state.ad.url], { detached: true, stdio: "ignore" }).unref();
}

function mustConfig(): Config {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("not configured — run: codevertise install --wallet 0xYou");
    process.exit(1);
  }
  return cfg;
}

const commands: Record<string, () => void | Promise<void>> = {
  install,
  uninstall,
  status,
  earnings,
  payout,
  open,
};

const cmd = process.argv[2];
const run = commands[cmd ?? ""];
if (!run) {
  console.log("codevertise — rent out your Claude Code status line, get paid in USDC\n");
  console.log("commands: install --wallet 0x… [--endpoint URL] | uninstall | status | earnings | payout | open");
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(run()).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
