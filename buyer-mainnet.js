// REAL-MONEY buyer for the live server: pays the server's price (e.g. $0.02) in USDC on Base mainnet.
// Meant for a handful of purchases you make yourself (e.g. the first sale that
// gets the endpoint listed in the x402 Bazaar).
//
//   npm run buy:mainnet                 dry run: shows exactly what would be paid, pays nothing
//   npm run buy:mainnet -- --confirm    actually pays and fetches the latest filing
//   npm run buy:mainnet -- --confirm --ticker MBX   buys the latest filing for one ticker
//
// Safety limits (the script refuses to pay otherwise):
//   - network must be Base mainnet and the asset must be official USDC
//   - amount must be at most MAX_PRICE_USDC (0.25), a safety cap above the real price
//   - payee must equal PAY_TO_ADDRESS from .env (your own wallet)
//
// First run creates a separate wallet (key saved to .env as
// MAINNET_BUYER_PRIVATE_KEY). Its key sits in a plain text file: only ever put a
// few dollars in it.

import { appendFileSync } from "node:fs";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const {
  MAINNET_BUYER_PRIVATE_KEY,
  PAY_TO_ADDRESS,
  SERVER_URL = "https://sec-filings-x402-production.up.railway.app",
} = process.env;
const SERVER = SERVER_URL.replace(/\/$/, "");
const CONFIRM = process.argv.includes("--confirm");
const tickerArg = process.argv[process.argv.indexOf("--ticker") + 1];
const TICKER = process.argv.includes("--ticker") && tickerArg && !tickerArg.startsWith("--") ? tickerArg.toUpperCase() : null;

const NETWORK = "eip155:8453"; // Base mainnet
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // official USDC on Base
const MAX_PRICE_USDC = "0.25";
const MAX_UNITS = 250_000n; // 0.25 USDC (6 decimals)

// --- 1. Wallet -------------------------------------------------------------

if (!MAINNET_BUYER_PRIVATE_KEY) {
  const key = generatePrivateKey();
  appendFileSync(
    ".env",
    `\n# Separate REAL-MONEY buyer wallet (Base mainnet) created by buyer-mainnet.js.\n# Keep only a few dollars in it. Never share this key.\nMAINNET_BUYER_PRIVATE_KEY=${key}\n`,
  );
  const { address } = privateKeyToAccount(key);
  console.log(`Created a separate real-money buyer wallet:

  ${address}

Fund it with about $1 of USDC on the BASE network, then run: npm run buy:mainnet`);
  process.exit(0);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO_ADDRESS ?? "")) {
  console.error("PAY_TO_ADDRESS in .env must be your own wallet address; the buyer refuses to pay anyone else.");
  process.exit(1);
}

const account = privateKeyToAccount(MAINNET_BUYER_PRIVATE_KEY);
const chain = createPublicClient({ chain: base, transport: http() });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const usdcBalance = (address) => chain.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [address] });
const fmt = (units) => `${formatUnits(units, 6)} USDC`;

const buyerBefore = await usdcBalance(account.address);
console.log(`Buyer wallet : ${account.address}  balance ${fmt(buyerBefore)} (Base mainnet)`);
const sellerBefore = await usdcBalance(PAY_TO_ADDRESS);
console.log(`Seller wallet: ${PAY_TO_ADDRESS}  balance ${fmt(sellerBefore)}`);

// --- 2. Get and check the payment challenge ----------------------------------

const url = TICKER ? `${SERVER}/tickers/${encodeURIComponent(TICKER)}/latest` : `${SERVER}/filings/latest`;
const first = await fetch(url).catch((err) => {
  console.error(`\nCan't reach ${SERVER}: ${err.message}`);
  process.exit(1);
});
if (first.status !== 402) {
  console.error(`\nExpected a 402 payment challenge from ${url}, got HTTP ${first.status}.`);
  process.exit(1);
}

const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
const httpClient = new x402HTTPClient(client);
const paymentRequired = httpClient.getPaymentRequiredResponse(
  (name) => first.headers.get(name),
  await first.json().catch(() => ({})),
);

const option = paymentRequired.accepts.find((a) => a.network === NETWORK);
const problems = [];
if (!option) problems.push(`server does not offer payment on Base mainnet (${NETWORK})`);
else {
  if (option.asset.toLowerCase() !== USDC.toLowerCase()) problems.push(`asset ${option.asset} is not official USDC`);
  if (BigInt(option.amount) > MAX_UNITS) problems.push(`price ${fmt(BigInt(option.amount))} is above the ${MAX_PRICE_USDC} USDC limit`);
  if (option.payTo.toLowerCase() !== PAY_TO_ADDRESS.toLowerCase()) problems.push(`payee ${option.payTo} is not your PAY_TO_ADDRESS`);
}
if (problems.length) {
  console.error(`\nRefusing to pay:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

console.log(`
Payment the server asks for:
  amount : ${fmt(BigInt(option.amount))}
  network: Base mainnet (${option.network})
  payee  : ${option.payTo}  (matches your PAY_TO_ADDRESS)
  for    : ${paymentRequired.resource?.url}`);

if (BigInt(option.amount) > buyerBefore) {
  console.log(`\nNot enough USDC in the buyer wallet. Send about $1 of USDC on the BASE network to ${account.address}.`);
  process.exit(1);
}

if (!CONFIRM) {
  console.log(`\nDry run: nothing was paid. To pay for real, run:  npm run buy:mainnet -- --confirm${TICKER ? ` --ticker ${TICKER}` : ""}`);
  process.exit(0);
}

// --- 3. Pay ---------------------------------------------------------------------

console.log("\nPaying for real…");
const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: [option] });
const paid = await fetch(url, { headers: httpClient.encodePaymentSignatureHeader(payload) });
const body = await paid.json().catch(() => null);
const receiptHeader = paid.headers.get("PAYMENT-RESPONSE");
const receipt = receiptHeader ? decodePaymentResponseHeader(receiptHeader) : null;

if (!paid.ok) {
  console.error(`\nPurchase failed: HTTP ${paid.status}${receipt?.errorReason ? ` (${receipt.errorReason}); no money moved` : ""}`);
  process.exit(1);
}

console.log(`\nHTTP ${paid.status}: paid content received:\n${JSON.stringify(body, null, 2)}`);
if (receipt?.transaction) console.log(`\nTransaction: https://basescan.org/tx/${receipt.transaction}`);

await new Promise((r) => setTimeout(r, 4000));
console.log(`\nBuyer  balance: ${fmt(buyerBefore)} → ${fmt(await usdcBalance(account.address))}`);
console.log(`Seller balance: ${fmt(sellerBefore)} → ${fmt(await usdcBalance(PAY_TO_ADDRESS))}`);
