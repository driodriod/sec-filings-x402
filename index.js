// SEC EDGAR 8-K watcher with an x402 paywall (USDC on Base).
//
// 1. Polls EDGAR's "latest filings" Atom feed for 8-Ks.
// 2. Keeps only 8-Ks with high-impact Items (bankruptcy, restatement, cyber, …).
// 3. Adds the stock ticker and exchange from the SEC's official CIK-to-ticker list,
//    plus a plain-English summary and key facts from the filing text (summarize.js).
// 4. Serves each filing as JSON behind an HTTP 402 challenge, priced in USDC (PRICE_USD, default 0.02).
//    NETWORK=base-sepolia (default) uses test money; NETWORK=base uses real USDC.
//    Paid: GET /filings/:id (latest, or an accession number) and GET /tickers/:ticker/latest.
//    Free: GET /filings, filterable by severity, item and since, without company identity.
// 5. Declares x402 Bazaar discovery info so facilitators can list the endpoints.
// 6. On Vercel, polls on demand (and via cron) instead of a long-lived timer.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import express from "express";
import { parseStringPromise } from "xml2js";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { analyzeFiling, plainSummary } from "./summarize.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WEB = join(ROOT, "web");

const {
  PAY_TO_ADDRESS,
  SEC_USER_AGENT,
  NETWORK: NETWORK_NAME = "base-sepolia",
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
  PRICE_USD = "0.02",
  PORT = "4022",
  POLL_INTERVAL_MS = "10000",
} = process.env;

const TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const TICKERS_REFRESH_MS = 24 * 60 * 60 * 1000;
const EDGAR_FEED_URL =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=40&output=atom";

// Price per filing in US dollars, e.g. PRICE_USD=0.01. x402 turns "$" prices into
// USDC on the chosen network. USDC has 6 decimals, so 0.000001 is the smallest step.
const priceNumber = Number(PRICE_USD);
if (!/^\d+(\.\d{1,6})?$/.test(PRICE_USD.trim()) || !(priceNumber > 0) || priceNumber > 100) {
  fail(`PRICE_USD must be a dollar amount between 0.000001 and 100, like 0.25 (got "${PRICE_USD}")`);
}
const PRICE = `$${PRICE_USD.trim()}`;
const MAX_STORED_FILINGS = 500;
const IS_VERCEL = Boolean(process.env.VERCEL);

// CAIP-2 chain IDs used by x402 v2
const NETWORKS = {
  "base-sepolia": { id: "eip155:84532", label: "Base Sepolia testnet, test money" },
  base: { id: "eip155:8453", label: "Base MAINNET, REAL money" },
};
const network = NETWORKS[NETWORK_NAME];
if (!network) fail(`NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")}`);
const NETWORK = network.id;
const IS_MAINNET = NETWORK_NAME === "base";

// No fallbacks here on purpose: a wrong payee would send buyers' money somewhere
// else, and the SEC blocks requests without a real contact.
if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO_ADDRESS ?? "")) fail("PAY_TO_ADDRESS must be a 0x… EVM address");
if (!SEC_USER_AGENT?.includes("@")) fail('SEC_USER_AGENT must include a contact email, e.g. "MyApp you@example.com"');
if (IS_MAINNET && !(CDP_API_KEY_ID && CDP_API_KEY_SECRET)) {
  fail("NETWORK=base needs CDP_API_KEY_ID and CDP_API_KEY_SECRET from https://portal.cdp.coinbase.com");
}
const payTo = PAY_TO_ADDRESS;
const userAgent = SEC_USER_AGENT;

function fail(msg) {
  throw new Error(`Config error: ${msg}`);
}

/** @type {Map<string, object>} accessionNumber -> filing, insertion-ordered (oldest first) */
const filings = new Map();
let firstPoll = true;
let lastPoll = { at: null, ok: null, entries: 0, newFilings: 0, error: null };
let pollInflight = null;

// CIK (as a number) -> [{ ticker, exchange }], primary listing first, as the SEC orders it.
let tickersByCik = new Map();

async function loadTickers() {
  try {
    const { data } = await axios.get(TICKERS_URL, { headers: { "User-Agent": userAgent }, timeout: 30_000 });
    const idx = Object.fromEntries(data.fields.map((f, i) => [f, i]));
    const next = new Map();
    for (const row of data.data) {
      const cik = Number(row[idx.cik]);
      if (!next.has(cik)) next.set(cik, []);
      next.get(cik).push({ ticker: row[idx.ticker], exchange: row[idx.exchange] ?? null });
    }
    tickersByCik = next;
    console.log(`[tickers] loaded ${data.data.length} tickers for ${next.size} companies`);
  } catch (err) {
    console.error(`[tickers] could not load SEC ticker list: ${err.message}`);
  }
}

// Adds ticker fields at response time, so filings seen before the list loaded still get them.
function withTicker(filing) {
  const listings = tickersByCik.get(Number(filing.cik)) ?? [];
  return {
    ...filing,
    ticker: listings[0]?.ticker ?? null,
    exchange: listings[0]?.exchange ?? null,
    allTickers: listings.map((l) => l.ticker),
  };
}

// accessionNumber -> Promise of { keyFacts, signals } (null if the filing text could not be read).
// One filing at a time, so EDGAR's rate limit (10 requests/second) is never close.
const analyses = new Map();
let analysisQueue = Promise.resolve();

function analyze(filing) {
  if (!analyses.has(filing.accessionNumber)) {
    const job = analysisQueue
      .then(() => analyzeFiling(filing, userAgent))
      .catch((err) => {
        console.error(`[summary] ${filing.accessionNumber}: ${err.message}`);
        analyses.delete(filing.accessionNumber); // try again on the next request
        return null;
      });
    analysisQueue = job.then(() => new Promise((r) => setTimeout(r, 200)));
    analyses.set(filing.accessionNumber, job);
  }
  return analyses.get(filing.accessionNumber);
}

// What a paying buyer gets: summary first, then the alert, then the supporting facts.
async function forBuyer(filing) {
  const analysis = await Promise.race([analyze(filing), new Promise((r) => setTimeout(r, 8000, null))]);
  const full = withTicker(filing);
  return { summary: plainSummary(filing, full.ticker, analysis), ...full, keyFacts: analysis?.keyFacts ?? [] };
}

async function fetchFeed() {
  const { data, status } = await axios.get(EDGAR_FEED_URL, {
    headers: {
      "User-Agent": userAgent,
      Accept: "application/atom+xml, application/xml, text/xml, */*",
      "Accept-Encoding": "gzip, deflate",
    },
    timeout: 15_000,
    responseType: "text",
    decompress: true,
    validateStatus: (s) => s < 500,
  });
  if (status !== 200 || (typeof data === "string" && data.includes("Undeclared Automated Tool"))) {
    const err = new Error("EDGAR blocked this host as an undeclared automated tool");
    err.response = { status: 403 };
    throw err;
  }
  const xml = await parseStringPromise(data, { explicitArray: false, mergeAttrs: true, trim: true });
  const entries = xml?.feed?.entry ?? [];
  return Array.isArray(entries) ? entries : [entries];
}

const WATCHED_ITEMS = {
  "1.03": { event: "Bankruptcy or Receivership", severity: "critical" },
  "1.05": { event: "Material Cybersecurity Incident", severity: "critical" },
  "4.02": { event: "Financial Statements No Longer Reliable (restatement)", severity: "critical" },
  "2.04": { event: "Debt Acceleration Triggered", severity: "high" },
  "2.06": { event: "Material Impairment (write-down)", severity: "high" },
  "3.01": { event: "Delisting Notice / Listing Rule Failure", severity: "high" },
  "4.01": { event: "Auditor Change", severity: "medium" },
  "5.02": { event: "Executive or Director Departure/Appointment", severity: "medium" },
};
const SEVERITY_RANK = { critical: 3, high: 2, medium: 1 };
const TITLE_RE = /^(?<form>\S+)\s+-\s+(?<company>.+?)\s+\((?<cik>\d{10})\)\s+\((?<role>[^)]+)\)$/;

function parseEntry(entry) {
  const formType = entry.category?.term;
  if (formType !== "8-K") return null;

  const summary = typeof entry.summary === "string" ? entry.summary : (entry.summary?._ ?? "");
  const events = [...summary.matchAll(/Item (\d+\.\d+):/g)]
    .map(([, item]) => (WATCHED_ITEMS[item] ? { item, ...WATCHED_ITEMS[item] } : null))
    .filter(Boolean);
  if (events.length === 0) return null;

  const title = typeof entry.title === "string" ? entry.title : entry.title?._;
  const m = TITLE_RE.exec(title ?? "");
  const accessionNumber = /accession-number=(\S+)/.exec(entry.id ?? "")?.[1];
  const filingLink = Array.isArray(entry.link) ? entry.link[0]?.href : entry.link?.href;
  if (!m || !accessionNumber || !filingLink) return null;

  const severity = events.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a)).severity;

  return {
    companyTitle: m.groups.company,
    cik: m.groups.cik,
    filingLink,
    severity,
    events,
    formType,
    accessionNumber,
    filedAt: entry.updated,
    detectedAt: new Date().toISOString(),
  };
}

async function poll() {
  const startedAt = new Date().toISOString();
  try {
    const entries = await fetchFeed();
    const parsed = entries.map(parseEntry).filter(Boolean).reverse();
    let newFilings = 0;

    for (const filing of parsed) {
      if (filings.has(filing.accessionNumber)) continue;
      filings.set(filing.accessionNumber, filing);
      analyze(filing);
      newFilings++;
      if (!firstPoll) {
        const what = filing.events.map((e) => `${e.item} ${e.event}`).join("; ");
        console.log(`[new 8-K] ${filing.severity.toUpperCase()} ${filing.companyTitle} (CIK ${filing.cik}): ${what}`);
      }
    }
    while (filings.size > MAX_STORED_FILINGS) {
      const oldest = filings.keys().next().value;
      filings.delete(oldest);
      analyses.delete(oldest);
    }

    lastPoll = { at: startedAt, ok: true, entries: entries.length, newFilings, error: null };
    console.log(
      firstPoll
        ? `[poll] baseline loaded: ${newFilings} high-impact 8-Ks among ${entries.length} recent filings`
        : `[poll] ${entries.length} entries checked, ${newFilings} new high-impact 8-Ks, ${filings.size} stored`,
    );
    firstPoll = false;
  } catch (err) {
    const reason = err.response ? `EDGAR responded ${err.response.status}` : err.message;
    lastPoll = { at: startedAt, ok: false, entries: 0, newFilings: 0, error: reason };
    console.error(`[poll] failed: ${reason}`);
  }
}

function isStale() {
  if (!lastPoll.at) return true;
  return Date.now() - Date.parse(lastPoll.at) >= Number(POLL_INTERVAL_MS);
}

async function ensureFresh() {
  if (!isStale()) return;
  if (!pollInflight) pollInflight = poll().finally(() => { pollInflight = null; });
  await pollInflight;
}

// The x402 library only keeps a short excerpt of facilitator errors. Log the
// full response body of failed facilitator calls (it holds no secrets) so a
// rejected payment says exactly which field was wrong.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (!res.ok && /x402|facilitator/.test(url)) {
    res.clone().text()
      .then((body) => console.error(`[facilitator] HTTP ${res.status} from ${url}: ${body.slice(0, 4000)}`))
      .catch(() => {});
  }
  return res;
};

// Testnet: the public x402.org facilitator (no account needed).
// Mainnet: Coinbase's CDP facilitator, which verifies and settles real USDC and
// is the one that catalogs endpoints in the x402 Bazaar.
async function createFacilitatorClient() {
  if (!IS_MAINNET) return new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
  const { createFacilitatorConfig } = await import("@coinbase/x402").catch(() =>
    fail("NETWORK=base needs the @coinbase/x402 package: npm install @coinbase/x402"),
  );
  return new HTTPFacilitatorClient(createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET));
}

const resourceServer = new x402ResourceServer(await createFacilitatorClient())
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);

// What a paid response looks like, for agents deciding whether to buy (Bazaar output schema).
const FILING_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One plain-English sentence on what happened, e.g. \"GoPro, Inc. (GPRO) says its CFO is leaving that role.\"" },
    ticker: { type: ["string", "null"], description: "Primary stock ticker, e.g. GPRO (null if not listed)" },
    exchange: { type: ["string", "null"], description: "Exchange of the primary ticker, e.g. Nasdaq, NYSE" },
    allTickers: { type: "array", items: { type: "string" }, description: "All tickers for the company" },
    companyTitle: { type: "string" },
    cik: { type: "string", description: "SEC Central Index Key, 10 digits" },
    severity: { type: "string", enum: ["critical", "high", "medium"] },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string", description: "8-K item number, e.g. 1.03" },
          event: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium"] },
        },
      },
    },
    filingLink: { type: "string", description: "SEC EDGAR filing index URL" },
    formType: { type: "string" },
    accessionNumber: { type: "string" },
    filedAt: { type: "string", description: "Filing time (ISO 8601)" },
    detectedAt: { type: "string", description: "When this service saw it (ISO 8601)" },
    keyFacts: {
      type: "array",
      description: "Opening sentences of each reported Item, quoted from the filing (who, what, when)",
      items: { type: "object", properties: { item: { type: "string" }, text: { type: "string" } } },
    },
  },
  required: ["summary", "ticker", "companyTitle", "cik", "severity", "events", "filingLink", "accessionNumber", "filedAt"],
};

const FILING_EXAMPLE = {
  summary:
    "GoPro, Inc. (GPRO) says some of its earlier financial statements can no longer be trusted and will be corrected (a restatement).",
  ticker: "GPRO",
  exchange: "Nasdaq",
  allTickers: ["GPRO"],
  companyTitle: "GoPro, Inc.",
  cik: "0001500435",
  severity: "critical",
  events: [{ item: "4.02", event: "Financial Statements No Longer Reliable (restatement)", severity: "critical" }],
  filingLink: "https://www.sec.gov/Archives/edgar/data/1500435/000150043526000064/0001500435-26-000064-index.htm",
  formType: "8-K",
  accessionNumber: "0001500435-26-000064",
  filedAt: "2026-10-16T17:30:16-04:00",
  detectedAt: "2026-10-16T21:30:24.457Z",
  keyFacts: [
    {
      item: "4.02",
      text: "On October 9, 2026, the Audit Committee of the Board of Directors of GoPro, Inc. concluded that the Company's previously issued financial statements should no longer be relied upon.",
    },
  ],
};

const SEVERITY_QUERY = {
  severity: { type: "string", enum: ["medium", "high", "critical"], description: "Minimum severity" },
  item: { type: "string", description: "Only this 8-K item, e.g. 1.03 (bankruptcy)" },
  since: { type: "string", description: "Only filings after this ISO 8601 time" },
};

// Kept short: Coinbase's facilitator rejects payments whose resource description
// is longer than about 500 characters ("'paymentPayload' is invalid").
const COVERAGE =
  "Items: 1.03 bankruptcy, 1.05 cyber incident, 4.02 restatement, 2.04 debt acceleration, " +
  "2.06 impairment, 3.01 delisting, 4.01 auditor change, 5.02 exec departure. " +
  `Checked every ${Math.round(Number(POLL_INTERVAL_MS) / 1000)}s.`;

const paidRoute = (description, discovery) => ({
  accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo, maxTimeoutSeconds: 120 }],
  description,
  mimeType: "application/json",
  // Shown in the x402 Bazaar catalog (max 5 tags, 32 chars each).
  serviceName: "SEC 8-K Alerts",
  tags: ["sec", "8-k", "stocks", "alerts", "real-time"],
  extensions: declareDiscoveryExtension({ ...discovery, output: { example: FILING_EXAMPLE, schema: FILING_SCHEMA } }),
});

const routes = {
  "GET /filings/:id": paidRoute(
    "Real-time SEC 8-K material-event alert with stock ticker and plain-English summary: ticker, company, CIK, " +
      "event, severity, key facts from the filing, EDGAR link. id=latest (optional ?severity=critical) or an accession number from free GET /filings. " +
      "Not charged if no match. " + COVERAGE,
    {
      pathParams: { id: "latest" },
      pathParamsSchema: {
        properties: { id: { type: "string", description: '"latest" or an SEC accession number like 0001500435-26-000064' } },
        required: ["id"],
      },
      input: { severity: "critical" },
      inputSchema: { properties: SEVERITY_QUERY },
    },
  ),
  "GET /tickers/:ticker/latest": paidRoute(
    "Latest SEC 8-K material-event alert for one stock ticker (e.g. TSLA): plain-English summary, event, " +
      "severity, company, CIK, key facts, EDGAR link. Not charged if no recent alert. " + COVERAGE,
    {
      pathParams: { ticker: "GPRO" },
      pathParamsSchema: {
        properties: { ticker: { type: "string", description: "Stock ticker, e.g. TSLA" } },
        required: ["ticker"],
      },
      input: { severity: "high" },
      inputSchema: { properties: SEVERITY_QUERY },
    },
  ),
};

for (const [route, cfg] of Object.entries(routes)) {
  if (cfg.description.length > 480) fail(`${route} description is ${cfg.description.length} chars; keep it under 480 (Coinbase limit ~500)`);
}

function printChallenge(headerValue, label) {
  const challenge = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
  const lines = [`\n──── x402 payment challenge (${label}) ────`, `resource : ${challenge.resource?.url}`];
  for (const a of challenge.accepts ?? []) {
    lines.push(
      `network  : ${a.network}${a.network === NETWORK ? ` (${network.label})` : ""}`,
      `amount   : ${a.amount} atomic units = ${Number(a.amount) / 1e6} ${a.extra?.name ?? ""}`,
      `asset    : ${a.asset}`,
      `payTo    : ${a.payTo}`,
      `scheme   : ${a.scheme}, expires after ${a.maxTimeoutSeconds}s`,
    );
  }
  const { extensions, ...core } = challenge;
  if (extensions?.bazaar) lines.push("bazaar   : discovery info included");
  lines.push(`raw JSON : ${JSON.stringify(core)}`, "─".repeat(48));
  console.log(lines.join("\n"));
}

const app = express();
// Behind a hosting provider's proxy, use the public https:// URL in payment challenges.
app.set("trust proxy", true);

app.get("/", (_req, res) => res.sendFile(join(WEB, "index.html")));
app.get("/styles.css", (_req, res) => res.sendFile(join(WEB, "styles.css")));
app.get("/app.js", (_req, res) => res.sendFile(join(WEB, "app.js")));

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, Payment-Required, PAYMENT-RESPONSE");
  next();
});

app.use((req, res, next) => {
  res.on("finish", () => {
    const header = res.getHeader("payment-required");
    if (res.statusCode === 402 && header) printChallenge(header, `${req.method} ${req.originalUrl}`);
  });
  next();
});

app.use(async (_req, _res, next) => {
  try {
    await ensureFresh();
  } catch (err) {
    console.error(`[ensureFresh] ${err.message}`);
  }
  next();
});

app.use(paymentMiddleware(routes, resourceServer));

app.get("/health", (_req, res) => {
  res.json({
    status: lastPoll.ok === false && filings.size === 0 ? "degraded" : "ok",
    network: NETWORK,
    networkLabel: network.label,
    price: PRICE,
    payTo,
    storedFilings: filings.size,
    lastPoll,
    watchedItems: WATCHED_ITEMS,
  });
});

// ---------------------------------------------------------------------------
// Discovery documents for crawlers, directories and agents. All generated from
// the live config, so they always match the real prices and payee.
// ---------------------------------------------------------------------------

const USDC_ASSET = { "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
const SERVICE_NAME = "SEC 8-K Alerts";
const SERVICE_SUMMARY =
  "Real-time material-event alerts from SEC 8-K filings (bankruptcy, restatement, cybersecurity incident, " +
  "delisting, debt acceleration, impairment, auditor change, executive departure) with stock ticker, sold per " +
  `alert over x402 for ${PRICE} USDC on Base. Free index shows event type and severity; the paid call reveals the company ` +
  "and adds a plain-English summary with key facts from the filing.";

const baseUrl = (req) => `${req.protocol}://${req.get("host")}`;
const paidEndpoints = (req) =>
  Object.entries(routes).map(([key, cfg]) => {
    const [method, path] = key.split(" ");
    const example = path.replace(":id", "latest").replace(":ticker", "AAPL");
    return {
      method,
      path,
      url: baseUrl(req) + example,
      description: cfg.description,
      price: { amount: PRICE_USD.trim(), currency: "USDC" },
      network: NETWORK,
      asset: USDC_ASSET[NETWORK],
      payTo,
      scheme: "exact",
      protocol: "x402",
      x402Version: 2,
    };
  });

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    `User-agent: *\nAllow: /\n\n# Machine-readable descriptions\n# ${baseUrl(req)}/openapi.json\n` +
      `# ${baseUrl(req)}/.well-known/x402\n# ${baseUrl(req)}/.well-known/agent-card.json\n`,
  );
});

app.get("/.well-known/x402", (req, res) => {
  const endpoints = paidEndpoints(req);
  res.json({
    version: 1,
    x402Version: 2,
    name: SERVICE_NAME,
    description: SERVICE_SUMMARY,
    resources: endpoints.map((e) => e.url),
    endpoints,
    free: [
      { method: "GET", path: "/filings", url: `${baseUrl(req)}/filings`, description: "Index of current alerts without company identity. Filters: severity, item, since, limit." },
      { method: "GET", path: "/health", url: `${baseUrl(req)}/health`, description: "Service status, last SEC check, price and payee." },
    ],
    docs: { openapi: `${baseUrl(req)}/openapi.json`, agentCard: `${baseUrl(req)}/.well-known/agent-card.json` },
  });
});

app.get("/.well-known/agent-card.json", (req, res) => {
  res.json({
    name: SERVICE_NAME,
    description: SERVICE_SUMMARY,
    url: baseUrl(req),
    version: "1.0.0",
    provider: { organization: "sec-filings-x402", url: baseUrl(req) },
    documentationUrl: `${baseUrl(req)}/openapi.json`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    payments: { protocol: "x402", x402Version: 2, network: NETWORK, asset: USDC_ASSET[NETWORK], payTo, price: `${PRICE_USD.trim()} USDC per alert` },
    skills: [
      {
        id: "latest-material-event",
        name: "Latest material-event 8-K",
        description: "Newest high-impact SEC 8-K with plain-English summary, ticker, company, event, severity, key facts and EDGAR link. Optional ?severity=critical.",
        tags: ["sec", "8-k", "stocks", "alerts", "real-time"],
        examples: [`GET ${baseUrl(req)}/filings/latest?severity=critical`],
      },
      {
        id: "ticker-material-event",
        name: "Material-event 8-K for a ticker",
        description: "Latest high-impact SEC 8-K for one stock ticker, with plain-English summary. Not charged if there is none.",
        tags: ["sec", "8-k", "ticker", "stocks", "alerts"],
        examples: [`GET ${baseUrl(req)}/tickers/TSLA/latest`],
      },
    ],
  });
});

app.get("/openapi.json", (req, res) => {
  const filterParams = [
    { name: "severity", in: "query", schema: { type: "string", enum: ["medium", "high", "critical"] }, description: "Minimum severity" },
    { name: "item", in: "query", schema: { type: "string" }, description: "Only this 8-K item, e.g. 1.03" },
    { name: "since", in: "query", schema: { type: "string", format: "date-time" }, description: "Only filings after this time" },
  ];
  const paywall = {
    402: { description: `Payment required: ${PRICE_USD.trim()} USDC on ${NETWORK} via x402 (see PAYMENT-REQUIRED header).` },
    404: { description: "No matching alert. The payment is not settled, so you are not charged." },
  };
  const paidInfo = { protocol: "x402", x402Version: 2, price: PRICE_USD.trim(), currency: "USDC", network: NETWORK, asset: USDC_ASSET[NETWORK], payTo };
  res.json({
    openapi: "3.1.0",
    info: { title: SERVICE_NAME, version: "1.0.0", description: SERVICE_SUMMARY },
    servers: [{ url: baseUrl(req) }],
    components: { schemas: { Filing: FILING_SCHEMA } },
    paths: {
      "/filings": {
        get: {
          summary: "Free index of current alerts (no company identity)",
          parameters: [...filterParams, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: MAX_STORED_FILINGS } }],
          responses: { 200: { description: "Alert index", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/filings/{id}": {
        get: {
          summary: `Paid (${PRICE_USD.trim()} USDC): full alert with ticker`,
          description: routes["GET /filings/:id"].description,
          "x-payment-info": paidInfo,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: '"latest" or an SEC accession number' }, ...filterParams],
          responses: { 200: { description: "Alert", content: { "application/json": { schema: { $ref: "#/components/schemas/Filing" } } } }, ...paywall },
        },
      },
      "/tickers/{ticker}/latest": {
        get: {
          summary: `Paid (${PRICE_USD.trim()} USDC): latest alert for one ticker`,
          description: routes["GET /tickers/:ticker/latest"].description,
          "x-payment-info": paidInfo,
          parameters: [{ name: "ticker", in: "path", required: true, schema: { type: "string" }, description: "Stock ticker, e.g. TSLA" }, ...filterParams],
          responses: { 200: { description: "Alert", content: { "application/json": { schema: { $ref: "#/components/schemas/Filing" } } } }, 400: { description: "Placeholder instead of a ticker; not charged." }, ...paywall },
        },
      },
      "/health": { get: { summary: "Service status", responses: { 200: { description: "Status" } } } },
    },
  });
});

// Shared filters: ?severity= (minimum: medium|high|critical), ?item= (e.g. 1.03), ?since= (ISO time)
function filterFilings(query) {
  const minRank = SEVERITY_RANK[String(query.severity ?? "").toLowerCase()] ?? 0;
  const item = query.item ? String(query.item) : null;
  const since = query.since ? Date.parse(String(query.since)) : NaN;
  return [...filings.values()]
    .reverse()
    .filter((f) => SEVERITY_RANK[f.severity] >= minRank)
    .filter((f) => !item || f.events.some((e) => e.item === item))
    .filter((f) => Number.isNaN(since) || Date.parse(f.filedAt) > since);
}

// Free: what happened and how serious, but not which company (that's the paid part).
app.get("/filings", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_STORED_FILINGS);
  const index = filterFilings(req.query).slice(0, limit).map((f) => ({
    accessionNumber: f.accessionNumber,
    severity: f.severity,
    events: f.events,
    formType: f.formType,
    filedAt: f.filedAt,
    price: PRICE,
    url: `/filings/${f.accessionNumber}`,
  }));
  res.json({ count: index.length, filings: index });
});

// Paid. Responses >= 400 are never settled, so "not found" costs the buyer nothing.
// Directories list the route templates (/filings/:id, /tickers/:ticker/latest). Agents
// that call those literally get something useful instead of an error.
const isPlaceholder = (value) => /^(:|\{).+/.test(value) || /^\[.+\]$/.test(value);

app.get("/filings/:id", async (req, res) => {
  const wantsLatest = req.params.id === "latest" || isPlaceholder(req.params.id);
  const filing = wantsLatest ? filterFilings(req.query)[0] : filings.get(req.params.id);
  if (!filing) return res.status(404).json({ error: "No matching filing (you were not charged)" });
  res.json(await forBuyer(filing));
});

app.get("/tickers/:ticker/latest", async (req, res) => {
  if (isPlaceholder(req.params.ticker)) {
    return res.status(400).json({
      error: "Replace :ticker with a stock ticker, e.g. /tickers/TSLA/latest (you were not charged)",
    });
  }
  const ticker = req.params.ticker.toUpperCase();
  const filing = filterFilings(req.query).find((f) => withTicker(f).allTickers.includes(ticker));
  if (!filing) return res.status(404).json({ error: `No recent high-impact 8-K for ${ticker} (you were not charged)` });
  res.json(await forBuyer(filing));
});

export default app;

if (!IS_VERCEL) {
  app.listen(Number(PORT), async () => {
    console.log(`EDGAR 8-K service on http://localhost:${PORT}`);
    console.log(`Price ${PRICE} USDC per filing on ${network.label} (${NETWORK}), paid to ${payTo}`);
    if (IS_MAINNET) console.log("!!! MAINNET: buyers pay real USDC to the address above. Double-check it is yours. !!!");
    console.log(`Polling EDGAR every ${Number(POLL_INTERVAL_MS) / 1000}s`);
    try {
      await axios.get(`http://localhost:${PORT}/filings/latest`, { validateStatus: () => true });
    } catch (err) {
      console.error(`[self-check] could not reach own paid route: ${err.message}`);
    }
  });
  await loadTickers();
  setInterval(loadTickers, TICKERS_REFRESH_MS);
  await poll();
  setInterval(poll, Number(POLL_INTERVAL_MS));
} else {
  await loadTickers();
}
