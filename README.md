# Codevertise

**Sponsored lines on AI coding-agent surfaces, paid in USDC over HTTP 402.**

The most-watched line in a developer's day is the status line under their AI coding agent.
Codevertise is a block-auction marketplace for that line, with crypto-native payment rails:

- **Advertisers fund campaigns through [x402](https://github.com/coinbase/x402)** (Coinbase's HTTP-402
  protocol): hit the fund endpoint, get a `402 Payment Required`, retry with a signed USDC payment.
  No signup, no card — which means **an AI agent can buy its own ad slot autonomously**.
- **Publishers (developers showing the ads) earn USDC to a wallet address** — no Stripe, no KYC
  middleman; payouts are on-chain ERC-20 transfers on Base.
- **MPP-ready**: Tempo/Stripe's [Machine Payments Protocol](https://mpp.dev) is the same 402 pattern;
  the paywall is a pluggable middleware on a single route, so an `mppx` rail can be added without
  touching marketplace logic.

## Marketplace model

| Concept | Rule |
|---|---|
| Ad unit | 1 block = 1,000 five-second impressions |
| Auction | English ascending, min bid $1.00/block, min raise $0.50 |
| Admission | A campaign only **enters** the serving pool once it is funded **and** outbids the current top serving campaign (the first funded bid enters an empty pool unopposed). Funding alone is not enough; an unfunded overbid is not enough — both gates must pass. A campaign drained to zero leaves the pool and must outbid the leader again to return |
| Serving | Once admitted, a campaign keeps serving, rotating per recipient (smooth weighted round-robin); a $5 bid is served ~5× as often as a $1 bid. Bids buy share, not exclusivity — an admitted campaign leaves serving only on explicit pause/cancel or when its budget runs out, **never for being outbid by a later entrant** |
| Clicks | Billed at 50× the impression rate |
| Publisher share | 40% of spend by default (operator-set via `PUBLISHER_SHARE`), credited per event to the publisher's wallet |
| Advertiser privacy | Wallets never appear on public surfaces; advertisers pick an optional public label for the board |
| Payouts | USDC on Base, $10 minimum, full withdrawable balance |
| Idempotency | Every impression/click carries a client event key; replays are no-ops |

All money is integer **micro-USD** internally (1e6 = $1), which is exactly USDC's 6 decimals.

## Packages

| Package | What it is |
|---|---|
| `@codevertise/server` | The marketplace: Express API, SQLite ledger, block auction, x402 paywall |
| `@codevertise/sdk` | Publisher SDK: fetch the winning ad, view-threshold impressions, clicks, earnings, payout |
| `@codevertise/agent-bidder` | Example autonomous advertiser: reads the board, outbids, pays the 402 |
| `@codevertise/cli-demo` | Example publisher: a spinner whose status line is Codevertise inventory |
| `@codevertise/claude-code` | **The real publisher client**: a Claude Code status-line extension — `npm i -g @codevertise/claude-code && codevertise install --wallet 0xYou` ([docs](packages/claude-code/README.md)) |
| `@codevertise/webapp` | **Landing page** at `/` (purpose + getting-started for advertisers, developers, and agents) plus the **advertiser console** at `/console.html` (static SPA, no build step) — live auction board, create/fund/raise campaigns, per-campaign stats. Runs as a **Farcaster Mini App** (host wallet + auto network-switch) when opened inside a Farcaster client, and as a normal injected-wallet dapp otherwise |

## Quickstart (mock rail — no chain needed)

```bash
npm install
npm run dev:server                                   # marketplace on :4021, 2 house ads seeded
                                                     # landing page:       http://localhost:4021/
                                                     # advertiser console: http://localhost:4021/console.html

# in another terminal — an agent buys the top slot:
MOCK=1 npx tsx packages/agent-bidder/src/index.ts

# and a publisher earns from it:
ROUNDS=3 npx tsx packages/cli-demo/src/index.ts
```

The mock rail keeps the exact 402 control flow (request → 402 + price → retry with payment header)
but accepts `X-Mock-Payment: <address>` as settlement, so the whole marketplace is testable offline.

## Real USDC via x402 (Base Sepolia)

```bash
PAYMENTS_MODE=x402 \
PAY_TO_ADDRESS=0xYourTreasury \
X402_NETWORK=eip155:84532 \
FACILITATOR_URL=https://facilitator.x402.org \
npm run dev:server

# agent pays with a real wallet holding testnet USDC:
PRIVATE_KEY=0xAgentKey npx tsx packages/agent-bidder/src/index.ts
```

Use `X402_NETWORK=eip155:8453` for Base mainnet. Set `PAYOUT_PRIVATE_KEY` on the server to send
publisher payouts on-chain automatically; without it payouts queue for manual settlement. The
ledger debits either way; a payout is only marked `sent` once the tx receipt confirms, and only a
provably reverted tx auto-refunds.

## API

```
GET  /healthz                          liveness + payments mode
GET  /.well-known/farcaster.json       Farcaster Mini App manifest (console is a Mini App)
GET  /v1/info                          agent-readable marketplace contract
GET  /v1/auction                       ranked bid board
POST /v1/campaigns                     {advertiser, message ≤80ch, https url, bidPerBlockUsd}
                                       → returns a ONE-TIME manage key (cvk_…)
POST /v1/campaigns/:id/bid             {bidPerBlockUsd} + X-Manage-Key  raise (English auction)
POST /v1/campaigns/:id/pause|resume    X-Manage-Key (or admin token)   kill switch
GET  /v1/campaigns/:id/stats           X-Manage-Key                    impressions/clicks/spend
POST /v1/fund?campaign=&blocks=        💰 PAID — 402 until x402 settlement; credits escrow
GET  /v1/serve?surface=&pub=           next campaign in the rotation: message, url, rates
POST /v1/events                        {token, type: impression|click} — serve-token gated
GET  /v1/publishers/:wallet            earnings ledger + payout history
POST /v1/publishers/:wallet/payouts    request USDC payout (≥ $10)

# with ADMIN_TOKEN set (Bearer or X-Admin-Token):
GET  /v1/admin/payouts?status=         operator payout queue
POST /v1/admin/payouts/:id/retry       re-send a queued payout / reconcile a submitted one
POST /v1/admin/payouts/:id/fail        give up + refund (refuses if a tx is in flight)
POST /v1/campaigns/:id/pause           moderation kill switch for any campaign
```

Campaign management is credentialed by the **manage key** returned once at creation — there is no
account system to attack, and wallets are never a lookup key (an on-chain payer can't be linked to
its campaigns through the API).

The funding price is **dynamic**: `blocks × the campaign's current bid`, computed inside the x402
route config from the query string, so the 402 challenge always quotes the exact amount.

## How the agentic bid works

```
agent                          marketplace                     facilitator/chain
  │  GET /v1/info, /v1/auction     │                                │
  │───────────────────────────────▶│  (reads contract + board)      │
  │  POST /v1/campaigns            │                                │
  │───────────────────────────────▶│  campaign created, unfunded    │
  │  POST /v1/fund?blocks=2        │                                │
  │───────────────────────────────▶│                                │
  │  ◀── 402 PAYMENT-REQUIRED ─────│  price = bid × blocks          │
  │  retry + PAYMENT-SIGNATURE     │                                │
  │───────────────────────────────▶│── verify / settle USDC ───────▶│
  │  ◀── 201 funded, serving #1 ───│  escrow credited               │
```

## Tests

```bash
npm test        # 58 vitest cases: auction economics, serve-token anti-fraud,
                # manage-key auth, click-ratio caps, payout state machine,
                # x402 settlement crediting, boot-time config guards
```

## Running in production

- **Escrow is credited at x402 settlement** (`onAfterSettle`), with the facilitator's authoritative
  payer + on-chain tx hash in the ledger. A failed settlement credits nothing.
- **Payout state machine**: `queued → submitted(tx) → sent|failed`. Sends wait for the tx receipt;
  an ambiguous outcome (RPC timeout after broadcast) is never auto-refunded — reconcile it with
  `POST /v1/admin/payouts/:id/retry`. Refunds only follow a reverted receipt or an explicit
  operator decision. Treasury sends are serialized (single nonce stream).
- **Boot guards**: `mock + PAYOUT_PRIVATE_KEY` refuses to start; `x402` requires a real
  `PAY_TO_ADDRESS`; `NODE_ENV=production` refuses the mock rail unless `ALLOW_MOCK_PAYMENTS=1`.
- **Abuse controls**: serve tokens (HMAC, single-use, view-threshold + TTL), per-IP rate limits,
  per-surface pacing, click-through ratio cap (`CLICK_RATIO`), https-only creatives, billable
  tokens only for valid EVM payout wallets, `TRUST_PROXY` off by default.
- **Ops**: `GET /healthz`, graceful SIGTERM drain, JSON logs for money movements and 4xx/5xx,
  `npm run backup` (online SQLite backup — cron it off-host; the DB is the ledger), `Dockerfile`
  (volume-mount `DB_PATH`), CI in `.github/workflows/ci.yml`.

## Honest limitations

- Single process, single SQLite file: rate limits and pacing are in-memory, so run ONE instance
  (scale the serve path with a cache in front, not replicas). Fine well past MVP traffic.
- Click-fraud control is a ratio cap, not attestation — a patient publisher can still extract the
  capped ratio. Real click verification (landing-page beacon) is future work.
- Pseudonymous publishers are unlimited: a botnet across many IPs and wallets can still farm
  slowly. Economic deterrents (40% share, $10 payout floor, pacing) raise the cost, not to zero.
- Paying out USDC to anonymous wallets may be money-transmission-adjacent in your jurisdiction —
  get that checked before mainnet.
- MPP rail is designed-for but not yet wired (`mppx` middleware slot on `POST /v1/fund`).
- The x402 rail has not yet been exercised against a live facilitator end-to-end from this repo.
