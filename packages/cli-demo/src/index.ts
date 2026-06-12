/**
 * Publisher demo: a fake AI-coding-agent spinner whose status line is
 * Codevertise inventory. Run the server, optionally run the agent-bidder,
 * then watch the winning ad rotate through the spinner while your wallet
 * accrues micro-USD.
 *
 * Env: ENDPOINT (default http://localhost:4021), WALLET (your payout address),
 *      ROUNDS (impressions to show, default 4)
 */
import { Codevertise, formatMicroUsd } from "@codevertise/sdk";

const cv = new Codevertise({
  endpoint: process.env.ENDPOINT ?? "http://localhost:4021",
  // Must be a real EVM address shape — the marketplace only issues billable
  // serve tokens to a valid payout wallet.
  publisher: process.env.WALLET ?? "0xDe00000000000000000000000000000000000001",
  surface: "cli-spinner",
});

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ROUNDS = Number(process.env.ROUNDS ?? 4);

async function main() {
  let frame = 0;
  let line = "Thinking…";
  const spinner = setInterval(() => {
    process.stdout.write(`\r\x1b[2K${FRAMES[(frame = (frame + 1) % FRAMES.length)]} ${line}`);
  }, 80);

  let totalMicro = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const ad = await cv.fetchAd();
    if (!ad) {
      line = "Thinking… (no fill)";
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const earned = await cv.showAd(ad, (message) => {
      line = `Thinking…  \x1b[2m[ad]\x1b[0m \x1b[36m${message}\x1b[0m`;
    });
    totalMicro += earned;
    line = `Thinking…  \x1b[32m+${formatMicroUsd(earned)} earned\x1b[0m`;
    await new Promise((r) => setTimeout(r, 800));
  }

  clearInterval(spinner);
  process.stdout.write("\r\x1b[2K");
  const earnings = await cv.earnings();
  console.log(`session earnings: ${formatMicroUsd(totalMicro)}`);
  console.log(
    `wallet ${earnings.wallet}: withdrawable ${formatMicroUsd(earnings.withdrawableMicro)} (payout threshold ${formatMicroUsd(earnings.minPayoutMicro)})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
