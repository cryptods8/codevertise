/**
 * Autonomous advertiser agent.
 *
 * Reads the marketplace contract, inspects the auction board, creates a
 * campaign that outbids the current leader, and funds it by paying the HTTP
 * 402 — no signup, no card, no human. This is the x402 "agentic commerce"
 * loop end to end.
 *
 * Env:
 *   ENDPOINT          marketplace URL          (default http://localhost:4021)
 *   MOCK=1            use the mock rail        (default when no PRIVATE_KEY)
 *   PRIVATE_KEY=0x..  EVM key holding USDC     (enables the real x402 rail)
 *   MESSAGE / URL     the ad creative
 *   BLOCKS            blocks to buy            (default 2)
 */

const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:4021";
const BLOCKS = Number(process.env.BLOCKS ?? 2);
const MESSAGE = process.env.MESSAGE ?? "ShipFast CI — your agent already pays for this slot in USDC";
const AD_URL = process.env.URL ?? "https://example.com/shipfast";
const MOCK = process.env.MOCK === "1" || !process.env.PRIVATE_KEY;

async function payingFetch(): Promise<typeof fetch> {
  if (MOCK) {
    // The mock rail accepts X-Mock-Payment as a settled payment. Same control
    // flow as x402: try, get 402, attach payment, retry.
    return async (input, init) => {
      const first = await fetch(input, init);
      if (first.status !== 402) return first;
      const challenge = await first.json();
      console.log(`  ← 402 Payment Required: ${challenge.accepts?.[0]?.amount} micro-USDC to ${challenge.accepts?.[0]?.payTo}`);
      console.log(`  → retrying with payment attached (mock rail)`);
      return fetch(input, {
        ...init,
        headers: { ...(init?.headers ?? {}), "x-mock-payment": "0xA9enT00000000000000000000000000000000Bid" },
      });
    };
  }

  const [{ wrapFetchWithPaymentFromConfig }, { ExactEvmScheme }, { privateKeyToAccount }] =
    await Promise.all([
      import("@x402/fetch"),
      import("@x402/evm/exact/client"),
      import("viem/accounts"),
    ]);
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  console.log(`  paying as ${account.address} via x402`);
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:*" as never, client: new ExactEvmScheme(account) as never }],
  });
}

async function main() {
  console.log(`codevertise agent-bidder → ${ENDPOINT} (${MOCK ? "mock" : "x402"} rail)\n`);

  // 1. Read the marketplace contract.
  const info = await (await fetch(`${ENDPOINT}/v1/info`)).json();
  console.log(`market: ${info.tagline}`);
  console.log(`ad unit: ${info.adUnit.block}, min bid $${info.adUnit.minBidUsd}/block\n`);

  // 2. Study the board and decide a bid that takes the top slot.
  const board = (await (await fetch(`${ENDPOINT}/v1/auction`)).json()).board as Array<{
    bidPerBlockMicro: number;
    serving: boolean;
  }>;
  const topMicro = board[0]?.bidPerBlockMicro ?? 0;
  const myBidUsd = Math.max(info.adUnit.minBidUsd, topMicro / 1_000_000 + info.adUnit.minBidIncrementUsd);
  console.log(`auction board has ${board.length} campaigns; top bid $${(topMicro / 1e6).toFixed(2)}/block`);
  console.log(`bidding $${myBidUsd.toFixed(2)}/block × ${BLOCKS} blocks\n`);

  // 3. Create the campaign.
  const created = await (
    await fetch(`${ENDPOINT}/v1/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        advertiser: "agent-bidder",
        message: MESSAGE,
        url: AD_URL,
        bidPerBlockUsd: myBidUsd,
      }),
    })
  ).json();
  const campaignId = created.campaign.id;
  console.log(`campaign ${campaignId} created`);
  // The manage key is shown exactly once — it's the only credential that can
  // raise this campaign's bid or pause it later.
  if (created.manageKey) console.log(`  manage key (save it): ${created.manageKey}`);

  // 4. Fund it through the 402.
  const pay = await payingFetch();
  const fundRes = await pay(`${ENDPOINT}/v1/fund?campaign=${campaignId}&blocks=${BLOCKS}`, {
    method: "POST",
  });
  const funded = await fundRes.json();
  if (!fundRes.ok) throw new Error(`funding failed: ${JSON.stringify(funded)}`);
  // Mock rail returns the ledger payment row; the x402 rail settles on
  // response release and reports the tx in the PAYMENT-RESPONSE header.
  const settledTx = fundRes.headers.get("payment-response") ? " (settled on-chain)" : "";
  console.log(
    `  ✓ funded ${funded.funded} (rail ${funded.payment.rail}${funded.payment.id ? `, payment ${funded.payment.id}` : ""})${settledTx}\n`,
  );

  // 5. Confirm position.
  const after = (await (await fetch(`${ENDPOINT}/v1/auction`)).json()).board as Array<{
    campaignId: string;
    rank: number;
    serving: boolean;
  }>;
  const mine = after.find((b) => b.campaignId === campaignId);
  console.log(`now rank #${mine?.rank}${mine?.serving ? " — SERVING" : ""} on the board`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
