// Test buyer for index.js: pays the x402 challenge with test USDC on Base Sepolia.
//
//   npm run buy                 buys the most severe filing currently listed
//   npm run buy -- <accession>  buys a specific filing
//
// First run creates a throwaway testnet wallet (key saved to .env as
// BUYER_PRIVATE_KEY) and tells you how to fund it with free test USDC.
// Never put real money in this wallet: its key sits in a plain text file.

import { appendFileSync } from "node:fs";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const { BUYER_PRIVATE_KEY, PAY_TO_ADDRESS, PORT = "4022" } = process.env;
// Point at a hosted copy with SERVER_URL=https://….up.railway.app npm run buy
const SERVER = (process.env.SERVER_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const NETWORK = "eip155:84532"; // Base Sepolia
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC on Base Sepolia
const PRICE_UNITS = 250_000n; // 0.25 USDC (6 decimals)

// --- 1. Wallet -------------------------------------------------------------

if (!BUYER_PRIVATE_KEY) {
  const key = generatePrivateKey();
  appendFileSync(".env", `\n# Throwaway TESTNET buyer wallet created by buyer.js. Never fund with real money.\nBUYER_PRIVATE_KEY=${key}\n`);
  const { address } = privateKeyToAccount(key);
  console.log(`Created a test buyer wallet: ${address}

Fund it with free test USDC:
  1. Open https://faucet.circle.com
  2. Choose "USDC" and network "Base Sepolia"
  3. Paste the address above and request tokens
Then run this script again.`);
  process.exit(0);
}

const account = privateKeyToAccount(BUYER_PRIVATE_KEY);
const chain = createPublicClient({ chain: baseSepolia, transport: http() });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const usdcBalance = (address) => chain.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [address] });
const fmt = (units) => `${formatUnits(units, 6)} USDC`;

const buyerBefore = await usdcBalance(account.address);
console.log(`Buyer wallet : ${account.address}  balance ${fmt(buyerBefore)}`);
if (buyerBefore < PRICE_UNITS) {
  console.log(`\nNot enough test USDC (need 0.25). Get some free at https://faucet.circle.com
(choose USDC + Base Sepolia, paste the buyer address above), then run again.`);
  process.exit(1);
}
const sellerBefore = PAY_TO_ADDRESS ? await usdcBalance(PAY_TO_ADDRESS) : null;
if (PAY_TO_ADDRESS) console.log(`Seller wallet: ${PAY_TO_ADDRESS}  balance ${fmt(sellerBefore)}`);

// --- 2. Pick a filing from the free list -----------------------------------

// This buyer only holds test money. Refuse to talk to a server set to mainnet.
const health = await fetch(`${SERVER}/health`).then((r) => r.json()).catch(() => null);
if (health && health.network !== NETWORK) {
  console.error(`\nThe server is on ${health.network} (${health.networkLabel ?? "not testnet"}). This test buyer only pays on Base Sepolia.`);
  process.exit(1);
}

const list = await fetch(`${SERVER}/filings`)
  .then((r) => r.json())
  .catch(() => {
    console.error(`\nCan't reach ${SERVER}. Start the server first: npm run start:sec`);
    process.exit(1);
  });
const rank = { critical: 3, high: 2, medium: 1 };
const target =
  process.argv[2] ?? [...list.filings].sort((a, b) => rank[b.severity] - rank[a.severity])[0]?.accessionNumber;
if (!target) {
  console.log("The server has no filings listed yet. Try again in a minute.");
  process.exit(1);
}
const teaser = list.filings.find((f) => f.accessionNumber === target);
console.log(`\nBuying filing ${target}${teaser ? ` (${teaser.severity}: ${teaser.events.map((e) => e.event).join("; ")})` : ""}`);

// --- 3. Pay and fetch --------------------------------------------------------

const payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
});

// The public testnet facilitator occasionally fails to submit a settlement
// (e.g. "invalid_exact_evm_transaction_failed"). Nothing is charged when that
// happens, so it's safe to sign a fresh payment and try again.
const MAX_ATTEMPTS = 3;
let res;
let body;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`Requesting… (gets a 402, signs a 0.25 USDC payment, retries with it)${attempt > 1 ? ` [attempt ${attempt}]` : ""}`);
  res = await payingFetch(`${SERVER}/filings/${target}`);
  body = await res.json().catch(() => null);
  if (res.ok) break;

  const failedReceipt = res.headers.get("PAYMENT-RESPONSE");
  const reason = failedReceipt ? decodePaymentResponseHeader(failedReceipt).errorReason : null;
  console.error(`  HTTP ${res.status}${reason ? `: settlement failed (${reason}), no money moved` : ""}`);
  if (!reason || attempt === MAX_ATTEMPTS) {
    console.error(`\nPurchase failed: HTTP ${res.status}`, body ?? "");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

console.log(`\nHTTP ${res.status}: paid content received:\n${JSON.stringify(body, null, 2)}`);

const receiptHeader = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
if (receiptHeader) {
  const receipt = decodePaymentResponseHeader(receiptHeader);
  console.log(`\nPayment settled on-chain: ${receipt.success ? "yes" : "no"}`);
  if (receipt.transaction) console.log(`Transaction: https://sepolia.basescan.org/tx/${receipt.transaction}`);
}

// --- 4. Show the money moved ---------------------------------------------------

await new Promise((r) => setTimeout(r, 4000)); // give the RPC a moment to see the new block
const buyerAfter = await usdcBalance(account.address);
console.log(`\nBuyer  balance: ${fmt(buyerBefore)} → ${fmt(buyerAfter)}`);
if (PAY_TO_ADDRESS) console.log(`Seller balance: ${fmt(sellerBefore)} → ${fmt(await usdcBalance(PAY_TO_ADDRESS))}`);
