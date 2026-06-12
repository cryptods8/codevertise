#!/usr/bin/env node
/**
 * Detached background worker spawned by the statusline. Does everything that
 * touches the network so rendering never blocks:
 *
 *  1. Reports the impression for the current ad once it has been visibly
 *     rendered for its full slot (idempotent event key).
 *  2. Rotates to the current auction winner.
 *  3. Refreshes the withdrawable balance every minute.
 */
import {
  fetchAd,
  fetchEarnings,
  loadConfig,
  loadState,
  reportEvent,
  saveState,
} from "./common.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) return;
  const state = loadState();
  const now = Date.now();

  try {
    // 1. View-threshold impression for the ad currently on screen.
    if (state.ad && !state.reported && state.firstShownAt > 0) {
      const slotMs = state.ad.slotSeconds * 1000;
      if (now - state.firstShownAt >= slotMs) {
        const earned = await reportEvent(cfg, "impression", state.ad);
        state.sessionEarnedMicro += earned;
        state.reported = true;
      }
    }

    // 2. Rotate to the current winner (also restarts the slot after an
    //    impression so the same campaign keeps earning while it serves).
    if (!state.ad || state.reported || now - state.lastFetchAt > 30_000) {
      const ad = await fetchAd(cfg);
      const sameAd =
        ad && state.ad && ad.campaignId === state.ad.campaignId && !state.reported;
      if (!sameAd) {
        state.ad = ad;
        state.firstShownAt = 0; // statusline stamps this on first render
        state.reported = false;
      }
      state.lastFetchAt = now;
    }

    // 3. Earnings refresh.
    if (now - state.lastEarningsAt > 60_000) {
      const earnings = await fetchEarnings(cfg);
      state.withdrawableMicro = earnings.withdrawableMicro;
      state.sessionEarnedMicro = 0; // now folded into the server-side balance
      state.lastEarningsAt = now;
    }

    state.lastError = null;
  } catch (err) {
    state.lastError = (err as Error).message;
    // Drop the ad on persistent failure so we never show stale creative.
    if (now - state.lastFetchAt > 120_000) state.ad = null;
  }

  saveState(state);
}

main().catch(() => process.exit(0));
