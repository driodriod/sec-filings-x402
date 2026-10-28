// Emergency financial-news watcher with an x402 paywall.
//
// 1. Polls Finnhub's market-news feed every POLL_INTERVAL_MS (default 60s).
// 2. Scans headline + summary for emergency keywords.
// 3. Stores each hit as a structured JSON "alert packet".
// 4. Serves packets behind an HTTP 402 challenge: $0.10 USDC on Base, via x402.

import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const {
  FINNHUB_API_KEY,
  PAY_TO_ADDRESS,
  NETWORK = "base-sepolia",
  PORT = "4021",
  POLL_INTERVAL_MS = "60000",
  NEWS_CATEGORY = "general",
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
} = process.env;

const PRICE = "$0.10"; // x402 resolves "$" prices to USDC on the chosen network
const MAX_STORED_ALERTS = 500;

// CAIP-2 chain IDs used by x402 v2
const NETWORKS = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};

if (!FINNHUB_API_KEY) fail("FINNHUB_API_KEY is required (free key at https://finnhub.io/register)");
if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO_ADDRESS ?? "")) fail("PAY_TO_ADDRESS must be a 0x… EVM address");
if (!NETWORKS[NETWORK]) fail(`NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")}`);

const CHAIN_ID = NETWORKS[NETWORK];

// Each keyword maps to a pattern that also catches common headline phrasings
// ("files for bankruptcy", "recalls 2M vehicles", "CEO steps down").
const KEYWORDS = [
  { keyword: "Bankruptcy", severity: "critical", pattern: /\bbankrupt(cy|cies)?\b|\bchapter\s+(7|11)\b/i },
  { keyword: "Product Recall", severity: "high", pattern: /\bproduct\s+recalls?\b|\brecall(s|ed|ing)?\b/i },
  { keyword: "Lawsuit", severity: "high", pattern: /\blawsuits?\b|\bclass[-\s]action\b|\bsued\b|\bsues\b/i },
  {
    keyword: "CEO Resignation",
    severity: "critical",
    pattern: /\bCEO\b[^.]{0,40}\b(resign(s|ed|ation)?|steps?\s+down|stepping\s+down|ousted|departs?)\b/i,
  },
];

// ---------------------------------------------------------------------------
// News polling + keyword detection
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} alertId -> packet, insertion-ordered */
const alerts = new Map();
let lastSeenArticleId = 0;
let lastPoll = { at: null, ok: null, articles: 0, newAlerts: 0, error: null };

async function fetchNews() {
  const url = new URL("https://finnhub.io/api/v1/news");
  url.searchParams.set("category", NEWS_CATEGORY);
  if (lastSeenArticleId) url.searchParams.set("minId", String(lastSeenArticleId));

  const res = await fetch(url, {
    headers: { "X-Finnhub-Token": FINNHUB_API_KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Finnhub responded ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected Finnhub payload: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

function scanArticle(article) {
  const text = `${article.headline ?? ""}\n${article.summary ?? ""}`;
  return KEYWORDS.filter(({ pattern }) => pattern.test(text)).map(({ keyword, severity, pattern }) => ({
    keyword,
    severity,
    matchedText: text.match(pattern)[0],
  }));
}

function buildPacket(article, matches) {
  const severityRank = { critical: 2, high: 1 };
  const top = matches.reduce((a, b) => (severityRank[b.severity] > severityRank[a.severity] ? b : a));

  return {
    alertId: `fh-${article.id}`,
    detectedAt: new Date().toISOString(),
    severity: top.severity,
    keywords: matches.map((m) => m.keyword),
    matches,
    tickers: (article.related ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    article: {
      id: article.id,
      headline: article.headline,
      summary: article.summary,
      source: article.source,
      url: article.url,
      image: article.image || null,
      category: article.category,
      publishedAt: new Date(article.datetime * 1000).toISOString(),
    },
    provider: "finnhub",
  };
}

async function poll() {
  const startedAt = new Date().toISOString();
  try {
    const articles = await fetchNews();
    let newAlerts = 0;

    for (const article of articles) {
      if (article.id > lastSeenArticleId) lastSeenArticleId = article.id;
      const alertId = `fh-${article.id}`;
      if (alerts.has(alertId)) continue;

      const matches = scanArticle(article);
      if (matches.length === 0) continue;

      const packet = buildPacket(article, matches);
      alerts.set(alertId, packet);
      newAlerts++;
      console.log(`[alert] ${packet.severity.toUpperCase()} ${packet.keywords.join(", ")} — ${packet.article.headline}`);
    }

    // Keep memory bounded: drop oldest packets first.
    while (alerts.size > MAX_STORED_ALERTS) alerts.delete(alerts.keys().next().value);

    lastPoll = { at: startedAt, ok: true, articles: articles.length, newAlerts, error: null };
    console.log(`[poll] ${articles.length} articles scanned, ${newAlerts} new alerts, ${alerts.size} stored`);
  } catch (err) {
    lastPoll = { at: startedAt, ok: false, articles: 0, newAlerts: 0, error: err.message };
    console.error(`[poll] failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// x402 payment setup
// ---------------------------------------------------------------------------

async function createFacilitatorClient() {
  if (NETWORK === "base-sepolia") {
    // Public facilitator, testnet only, no auth needed.
    return new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
  }

  // Mainnet: Coinbase's CDP facilitator verifies and settles real USDC payments.
  if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
    fail("NETWORK=base needs CDP_API_KEY_ID and CDP_API_KEY_SECRET (https://portal.cdp.coinbase.com)");
  }
  const { createFacilitatorConfig } = await import("@coinbase/x402").catch(() =>
    fail("NETWORK=base needs the @coinbase/x402 package: npm install @coinbase/x402"),
  );
  return new HTTPFacilitatorClient(createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET));
}

const resourceServer = new x402ResourceServer(await createFacilitatorClient()).register(
  CHAIN_ID,
  new ExactEvmScheme(),
);

const paidRoute = (description) => ({
  accepts: [{ scheme: "exact", price: PRICE, network: CHAIN_ID, payTo: PAY_TO_ADDRESS, maxTimeoutSeconds: 120 }],
  description,
  mimeType: "application/json",
});

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const app = express();

app.use(
  paymentMiddleware(
    {
      // ":alertId" matches one path segment, so this covers /alerts/latest and
      // /alerts/fh-123 but leaves the free /alerts index alone. (A trailing
      // "/*" would also match bare /alerts.)
      "GET /alerts/:alertId": paidRoute("Full emergency financial-news alert packet"),
    },
    resourceServer,
  ),
);

// Free: service status.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", network: CHAIN_ID, price: PRICE, storedAlerts: alerts.size, lastPoll });
});

// Free: teaser index so buyers know what exists before paying.
app.get("/alerts", (_req, res) => {
  const index = [...alerts.values()].reverse().map((p) => ({
    alertId: p.alertId,
    detectedAt: p.detectedAt,
    severity: p.severity,
    keywords: p.keywords,
    tickers: p.tickers,
    price: PRICE,
    url: `/alerts/${p.alertId}`,
  }));
  res.json({ count: index.length, alerts: index });
});

// Paid. Error responses (>= 400) are not settled by the middleware, so a
// buyer is never charged for a 404.
app.get("/alerts/latest", (_req, res) => {
  const latest = [...alerts.values()].at(-1);
  if (!latest) return res.status(404).json({ error: "No alerts detected yet" });
  res.json(latest);
});

app.get("/alerts/:alertId", (req, res) => {
  const packet = alerts.get(req.params.alertId);
  if (!packet) return res.status(404).json({ error: "Unknown alertId" });
  res.json(packet);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`Config error: ${msg}`);
  process.exit(1);
}

app.listen(Number(PORT), () => {
  console.log(`News alert service on http://localhost:${PORT} — ${PRICE} USDC per packet on ${NETWORK} (${CHAIN_ID})`);
  console.log(`Paying to ${PAY_TO_ADDRESS}; polling Finnhub every ${Number(POLL_INTERVAL_MS) / 1000}s`);
});

await poll();
setInterval(poll, Number(POLL_INTERVAL_MS));
