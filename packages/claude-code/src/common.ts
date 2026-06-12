import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shared config/state plumbing and a minimal marketplace API client. */

export interface Config {
  endpoint: string;
  /** Publisher payout wallet — your identity on the marketplace. */
  wallet: string;
  surface: string;
  /** A pre-existing statusLine command we replaced; we run it and append the ad. */
  passthrough?: string;
}

export interface Ad {
  campaignId: string;
  message: string;
  url: string;
  slotSeconds: number;
  impressionMicro: number;
  clickMicro: number;
  publisherShare: number;
  /** Single-use serve authorization from the marketplace; required to bill. */
  token?: string;
}

export interface State {
  ad: Ad | null;
  /** When the statusline first actually rendered the current ad (0 = not yet). */
  firstShownAt: number;
  reported: boolean;
  lastFetchAt: number;
  lastTickAt: number;
  lastEarningsAt: number;
  withdrawableMicro: number;
  sessionEarnedMicro: number;
  lastError: string | null;
}

export function cvHome(): string {
  return process.env.CODEVERTISE_HOME ?? join(homedir(), ".codevertise");
}

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

const configPath = () => join(cvHome(), "config.json");
const statePath = () => join(cvHome(), "state.json");

export function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as Config;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: Config): void {
  atomicWriteJson(configPath(), cfg);
}

export function defaultState(): State {
  return {
    ad: null,
    firstShownAt: 0,
    reported: false,
    lastFetchAt: 0,
    lastTickAt: 0,
    lastEarningsAt: 0,
    withdrawableMicro: 0,
    sessionEarnedMicro: 0,
    lastError: null,
  };
}

export function loadState(): State {
  try {
    return { ...defaultState(), ...JSON.parse(readFileSync(statePath(), "utf8")) } as State;
  } catch {
    return defaultState();
  }
}

export function saveState(state: State): void {
  atomicWriteJson(statePath(), state);
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.codevertise-backup-${Date.now()}`;
  copyFileSync(path, backup);
  return backup;
}

// ---- marketplace client (kept dependency-free; mirrors @codevertise/sdk) ----

const TIMEOUT_MS = 1500;

async function api<T>(cfg: Config, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.endpoint.replace(/\/$/, "")}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 204) return null as T;
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body as T;
}

export function fetchAd(cfg: Config): Promise<Ad | null> {
  return api<Ad | null>(
    cfg,
    `/v1/serve?surface=${encodeURIComponent(cfg.surface)}&pub=${encodeURIComponent(cfg.wallet)}`,
  );
}

export async function reportEvent(
  cfg: Config,
  type: "impression" | "click",
  ad: Ad,
): Promise<number> {
  // The serve token authorizes (and identifies) the billable event; an ad
  // served without one isn't billable.
  if (!ad.token) return 0;
  const body = await api<{ recorded: boolean; earnedMicro?: number }>(cfg, "/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ad.token, type }),
  });
  return body.recorded ? (body.earnedMicro ?? 0) : 0;
}

export interface Earnings {
  wallet: string;
  earnedMicro: number;
  paidMicro: number;
  withdrawableMicro: number;
  minPayoutMicro: number;
  payouts: unknown[];
}

export function fetchEarnings(cfg: Config): Promise<Earnings> {
  return api<Earnings>(cfg, `/v1/publishers/${encodeURIComponent(cfg.wallet)}`);
}

export function requestPayout(cfg: Config): Promise<unknown> {
  return api(cfg, `/v1/publishers/${encodeURIComponent(cfg.wallet)}/payouts`, { method: "POST" });
}

export function formatMicroUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(4)}`;
}
