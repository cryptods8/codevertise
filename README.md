# Codevertise

**Sponsored lines on AI coding-agent surfaces, paid in USDC over HTTP 402.**

The most-watched line in a developer's day is the agent's "thinking…" spinner. Codevertise is a
[kickbacks.ai](https://kickbacks.ai)-style marketplace for that line — same block-auction economics,
but the payment rails are crypto-native:

- **Advertisers fund campaigns through [x402](https://github.com/coinbase/x402)** (Coinbase's HTTP-402
  protocol): hit the fund endpoint, get a `402 Payment Required`, retry with a signed USDC payment.
  No signup, no card — which means **an AI agent can buy its own ad slot autonomously**.
- **Publishers (developers showing the ads) earn USDC to a wallet address** — no Stripe, no KYC
  middleman; payouts are on-chain ERC-20 transfers on Base.
- **MPP-ready**: Tempo/Stripe's [Machine Payments Protocol](https://mpp.dev) is the same 402 pattern;
  the paywall is a pluggable middleware on a single route, so an `mppx` rail can be added without
  touching marketplace logic.

## Marketplace model (kickbacks.ai economics)

| Concept | Rule |
|---|---|
| Ad unit | 1 block = 1,000 five-second impressions |
| Auction | English ascending, min bid $1.00/block, min raise $0.50 |
| Serving | Highest funded bid serves; ties broken by age; unfunded bids never serve |
| Clicks | Billed at 50× the impression rate |
| Publisher share | 50% of spend, credited per event to the publisher's wallet |
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
| `@codevertise/claude-code` | **The real publisher client**: a Claude Code status-line extension — `npm i -g ./packages/claude-code && codevertise install --wallet 0xYou` ([docs](packages/claude-code/README.md)) |

## Quickstart (mock rail — no chain needed)

```bash
npm install
npm run dev:server                                   # marketplace on :4021, 2 house ads seeded

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
publisher payouts on-chain automatically; without it payouts queue for manual settlement (the
ledger debits either way, and failed sends refund).

## API

```
GET  /v1/info                          agent-readable marketplace contract
GET  /v1/auction                       ranked bid board
POST /v1/campaigns                     {advertiser, message ≤80ch, url, bidPerBlockUsd}
POST /v1/campaigns/:id/bid             {bidPerBlockUsd}  raise (English auction)
POST /v1/fund?campaign=&blocks=        💰 PAID — 402 until x402 settlement; credits escrow
GET  /v1/serve?surface=&pub=           current winner: message, url, rates
POST /v1/events                        {key, type: impression|click, campaignId, publisher, surface}
GET  /v1/publishers/:wallet            earnings ledger + payout history
POST /v1/publishers/:wallet/payouts    request USDC payout (≥ $10)
```

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
npm test        # 13 vitest cases: auction ranking, raises, idempotent events,
                # budget clamping, 50/50 splits, payout threshold/refund
```

## Honest limitations (MVP)

- Payer identity on the x402 rail is parsed best-effort from the payment header; production should
  use the middleware's settle hooks for an authoritative payer + tx hash.
- No advertiser auth: anyone who pays can fund any campaign (that's also a feature).
- Mock rail is for development; don't expose it publicly.
- MPP rail is designed-for but not yet wired (`mppx` middleware slot on `POST /v1/fund`).
