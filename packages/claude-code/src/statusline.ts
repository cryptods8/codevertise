#!/usr/bin/env node
/**
 * Claude Code statusLine command. Renders from cached state only — never
 * blocks on the network — and spawns the detached tick worker when ad
 * rotation, impression reporting, or earnings refresh is due.
 *
 * Claude Code pipes session JSON on stdin and shows our stdout as the
 * status line (ANSI supported).
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatMicroUsd, loadConfig, loadState, saveState, type State } from "./common.js";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const SEP = ` ${DIM}│${RESET} `;

interface StdinCtx {
  model?: { display_name?: string };
  workspace?: { current_dir?: string };
  cwd?: string;
}

function readStdin(): { raw: string; ctx: StdinCtx } {
  if (process.stdin.isTTY) return { raw: "{}", ctx: {} };
  try {
    const raw = readFileSync(0, "utf8");
    return { raw, ctx: raw.trim() ? (JSON.parse(raw) as StdinCtx) : {} };
  } catch {
    return { raw: "{}", ctx: {} };
  }
}

function leftSegment(ctx: StdinCtx, passthrough?: string, raw?: string): string {
  if (passthrough) {
    try {
      const out = execFileSync("/bin/sh", ["-c", passthrough], {
        input: raw ?? "{}",
        timeout: 400,
        encoding: "utf8",
      });
      const line = out.split("\n").find((l) => l.trim());
      if (line) return line.trimEnd();
    } catch {
      // fall through to the default segment
    }
  }
  const model = ctx.model?.display_name ?? "Claude";
  const dir = basename(ctx.workspace?.current_dir ?? ctx.cwd ?? process.cwd());
  return `${model} · ${dir}`;
}

function maybeSpawnTick(state: State): void {
  const now = Date.now();
  const slotMs = (state.ad?.slotSeconds ?? 5) * 1000;
  const due =
    !state.ad ||
    (!state.reported && state.firstShownAt > 0 && now - state.firstShownAt >= slotMs) ||
    now - state.lastFetchAt > 30_000 ||
    now - state.lastEarningsAt > 60_000;
  if (!due || now - state.lastTickAt < 2_000) return;
  state.lastTickAt = now;
  saveState(state);
  const tickPath = join(fileURLToPath(new URL(".", import.meta.url)), "tick.js");
  spawn(process.execPath, [tickPath], { detached: true, stdio: "ignore" }).unref();
}

function main(): void {
  const { raw, ctx } = readStdin();
  const cfg = loadConfig();
  if (!cfg) {
    console.log(
      `${leftSegment(ctx)}${SEP}${DIM}codevertise: not configured — codevertise install --wallet 0x…${RESET}`,
    );
    return;
  }

  const state = loadState();

  // The view threshold starts when the ad is actually rendered, not fetched.
  if (state.ad && state.firstShownAt === 0) {
    state.firstShownAt = Date.now();
    saveState(state);
  }
  maybeSpawnTick(state);

  const parts = [leftSegment(ctx, cfg.passthrough, raw)];
  const earnedMicro = state.withdrawableMicro + state.sessionEarnedMicro;
  parts.push(`${GREEN}⛁ ${formatMicroUsd(earnedMicro)}${RESET}`);
  if (state.ad) {
    // OSC 8 hyperlink where the terminal supports it; plain text elsewhere.
    const link = `\x1b]8;;${state.ad.url}\x1b\\${state.ad.message}\x1b]8;;\x1b\\`;
    parts.push(`${DIM}[sponsored]${RESET} ${CYAN}${link}${RESET}`);
  } else {
    parts.push(`${DIM}codevertise: no fill${RESET}`);
  }
  console.log(parts.join(SEP));
}

main();
