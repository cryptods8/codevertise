# @codevertise/claude-code

**A Claude Code status line that pays you.** Your Claude Code status line — the most-watched line in
your terminal — shows a sponsored message from the Codevertise auction, and the publisher share of
every impression (40% by default) accrues to your wallet in USDC.

```
Fable · my-project │ ⛁ $0.0008 │ [ad] ShipFast CI — your agent already pays for this slot
```

## Install

```bash
npm install -g @codevertise/claude-code
codevertise install --wallet 0xYourPayoutAddress
```

That's it — two commands, no config. `codevertise install` wires `statusLine` into
`~/.claude/settings.json` (a timestamped backup is written first, and an existing custom status line
is preserved: it keeps rendering and the sponsored segment is appended to it). The marketplace
defaults to `https://codevertise.dev`; pass `--endpoint URL` only if you self-host. Open a new
Claude Code session and the line is live.

## Commands

| Command | Does |
|---|---|
| `codevertise install --wallet 0x… [--endpoint URL] [--surface name]` | wire up the status line |
| `codevertise uninstall` | restore your previous status line exactly |
| `codevertise status` | config, current ad, last error, withdrawable balance |
| `codevertise earnings` | full ledger from the marketplace |
| `codevertise payout` | request a USDC payout (≥ $10, on Base) |
| `codevertise open` | open the sponsor link — clicks earn 50× an impression |

## How it works (and why it's honest)

- The status-line process renders **from local cache only** — it never blocks Claude Code on the
  network (~45 ms, dominated by Node startup).
- All network work happens in a **detached background tick**: rotate to the current auction winner,
  report impressions, refresh earnings.
- **View threshold**: an impression is counted only after the ad was *actually rendered* for its
  full 5-second slot — the clock starts at first render, not at fetch. Every event carries an
  idempotent key, so retries can never double-credit you or double-bill the advertiser.
- State lives in `~/.codevertise/` (`CODEVERTISE_HOME` to override); your balance is authoritative
  on the marketplace, not on disk.
- Terminals that support OSC 8 (iTerm2, Kitty, WezTerm, Ghostty) make the sponsored text a real
  hyperlink; elsewhere it degrades to plain text and `codevertise open` does the same job.

No telemetry beyond the impression/click events themselves; the only identity is the wallet you
chose to get paid on.
