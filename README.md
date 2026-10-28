# SEC Filings x402

**Real-time alerts on high-impact SEC 8-K filings, sold per filing to AI agents and developers through x402 micropayments (USDC on Base).**

When a US-listed company goes bankrupt, discovers a cyberattack, restates its accounts or loses its CEO, it must file an 8-K with the SEC, which is often the first official word of it. This service picks up those filings shortly after EDGAR publishes them. It turns each one into a short, structured alert and sells it over HTTP for a few cents, with no account, API key or subscription.

## How it works

1. **Watch.** It polls the SEC EDGAR "latest filings" feed for new 8-Ks (every 10 seconds by default).
2. **Filter.** It keeps only filings that contain high-impact Items and gives each one a severity:

   | Severity | 8-K Item | Event |
   |---|---|---|
   | critical | 1.03 | Bankruptcy or receivership |
   | critical | 1.05 | Material cybersecurity incident |
   | critical | 4.02 | Financial statements no longer reliable (restatement) |
   | high | 2.04 | Debt acceleration triggered |
   | high | 2.06 | Material impairment (write-down) |
   | high | 3.01 | Delisting notice / listing rule failure |
   | medium | 4.01 | Auditor change |
   | medium | 5.02 | Executive or director departure / appointment |

3. **Enrich.** It adds the stock ticker and exchange from the SEC's official company list. It downloads the filing text, pulls out the key facts and writes a one-sentence summary in plain English.
4. **Sell.** It serves each alert behind an HTTP `402 Payment Required` challenge using the [x402](https://x402.org) protocol. A buyer (a person or an AI agent) pays in USDC on Base and gets the alert back in the same request.

## The business model

The free endpoint tells you **what** happened and **how serious** it is. The paid endpoint tells you **which company** it was, along with the ticker, the summary and the key facts. Buyers only pay for alerts they actually want, and a request that finds nothing costs nothing.

Because payment happens over plain HTTP, AI agents can discover the service and pay for data on their own, with no human signing up. The service publishes discovery documents (`/.well-known/x402`, `/.well-known/agent-card.json`, `/openapi.json`) so that agent directories such as the x402 Bazaar can list it.

## API

| Endpoint | Price | Returns |
|---|---|---|
| `GET /filings` | Free | Recent alerts: severity, event and filing time, but no company name. Filter with `?severity=`, `?item=`, `?since=`, `?limit=` |
| `GET /filings/latest` | Paid | The most recent alert (optionally `?severity=critical`) |
| `GET /filings/:accessionNumber` | Paid | A specific alert from the free list |
| `GET /tickers/:ticker/latest` | Paid | The latest high-impact 8-K for a ticker, e.g. `/tickers/TSLA/latest` |
| `GET /health` | Free | Service status and configuration |

The price is set with `PRICE_USD` (default $0.02 per filing).

Example of a paid response:

```json
{
  "summary": "GoPro, Inc. (GPRO) says some of its earlier financial statements can no longer be trusted and will be corrected (a restatement).",
  "ticker": "GPRO",
  "exchange": "Nasdaq",
  "companyTitle": "GoPro, Inc.",
  "severity": "critical",
  "events": [{ "item": "4.02", "event": "Financial Statements No Longer Reliable (restatement)", "severity": "critical" }],
  "filingLink": "https://www.sec.gov/Archives/edgar/data/1500435/000150043526000064/0001500435-26-000064-index.htm",
  "filedAt": "2026-10-16T17:30:16-04:00",
  "keyFacts": [{ "item": "4.02", "text": "On October 9, 2026, the Audit Committee of the Board of Directors of GoPro, Inc. concluded that the Company's previously issued financial statements should no longer be relied upon." }]
}
```

## Running it

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env      # set PAY_TO_ADDRESS and SEC_USER_AGENT
npm start                 # service on http://localhost:4022
```

By default it runs on **Base Sepolia**, a test network that uses free test USDC. To try a purchase:

```bash
npm run buy               # creates a test wallet, then buys the most severe current filing
```

Setting `NETWORK=base` switches to real USDC on Base mainnet. That mode requires Coinbase Developer Platform keys (see `.env.example`).

The service can be deployed to Railway (`railway.json`) or Vercel (`vercel.json`).

## Project structure

| File | Purpose |
|---|---|
| `index.js` | EDGAR watcher, filtering, x402 paywall and API |
| `summarize.js` | Turns the filing text into key facts and a plain-English summary (rule-based, no paid AI service) |
| `buyer.js`, `buyer-mainnet.js` | Example buyers that pay the x402 challenge (testnet and mainnet) |
| `news-server.js` | Optional sister service: emergency financial-news alerts from Finnhub, sold the same way |
| `web/` | Simple web page that shows the live alert feed |

## Built with

Node.js · Express · x402 (Coinbase) · viem · SEC EDGAR
