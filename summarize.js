// Plain-English summaries of 8-K filings, built without any paid AI service:
// 1. Download the filing's main document from EDGAR and turn its HTML into text.
// 2. For each watched Item, take the opening sentences of that Item's section (the facts).
// 3. Look for a few telling words (resigned, CEO, voluntary transfer, …) and write a
//    one-sentence headline from a template.

import axios from "axios";

const ITEM_TITLES = {
  "1.03": "Bankruptcy or Receivership",
  "1.05": "Material Cybersecurity Incidents",
  "2.04": "Triggering Events That Accelerate or Increase a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement",
  "2.06": "Material Impairments",
  "3.01": "Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing",
  "4.01": "Changes in Registrant's Certifying Accountant",
  "4.02": "Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review",
  "5.02": "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers",
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", sect: "§", bull: "•", hellip: "…" };

function htmlToText(html) {
  return html
    .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d|table)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t ​]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .replace(/([“(]) +/g, "$1")
    .replace(/ +([”),.;:])/g, "$1")
    .trim();
}

// "Inc." or "Mr." or an initial like "R." does not end a sentence.
const ABBREVIATION = /\b(?:Inc|Corp|Co|Ltd|LLC|Mr|Ms|Mrs|Messrs|Dr|Jr|Sr|No|Nos|St|vs|[A-Z])\.$/;

function openingSentences(text, max = 420) {
  let out = "";
  let start = 0;
  for (const m of text.matchAll(/[.!?](?=\s+[“"(]?[A-Z])/g)) {
    const end = m.index + 1;
    if (ABBREVIATION.test(text.slice(Math.max(0, end - 8), end))) continue;
    const sentence = text.slice(start, end).trim();
    if (out && out.length + sentence.length > max) break;
    out = `${out} ${sentence}`.trim();
    start = end;
    if (out.length >= 200) break;
  }
  if (!out) out = text;
  return out.length <= max ? out : `${out.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

// The section's own heading, sub-labels like "(d)" and short sub-headings come before the facts.
function stripHeading(body, item) {
  const title = ITEM_TITLES[item].split(/\W+/).filter(Boolean).join("\\W+");
  const titled = body.replace(new RegExp(`^\\W*${title}\\W*`, "i"), "");
  // Companies sometimes shorten or reword the heading; then look a bit further for the first fact.
  const window = titled === body ? 250 : 100;
  body = titled.replace(/^(?:\([a-z]\)\s*[.:]?\s*)+/i, "");
  const lead = /\b(?:On|Effective|As previously|The Company|The Board|We)\b/.exec(body.slice(0, window));
  return lead ? body.slice(lead.index) : body;
}

function itemSections(text, items) {
  const heads = [...text.matchAll(/(?:^|\n)\s*Item\s*(\d+\.\d{2})\.?/gi)];
  const signatures = text.search(/\nSIGNATURES?\b/i);
  const sections = {};
  for (const item of items) {
    // The last heading for an Item is the real section; earlier ones are the cover-page checklist.
    const i = heads.findLastIndex((h) => h[1] === item);
    if (i < 0) continue;
    const start = heads[i].index + heads[i][0].length;
    let end = heads[i + 1]?.index ?? signatures;
    if (end <= start) end = start + 4000;
    sections[item] = stripHeading(text.slice(start, end).replace(/\s+/g, " ").trim(), item);
  }
  return sections;
}

// The filing index page lists the documents; the main one has type "8-K".
async function fetchMainDocument(filingLink, userAgent) {
  const get = (url) => axios.get(url, { headers: { "User-Agent": userAgent }, responseType: "text", timeout: 20_000 }).then((r) => r.data);
  const index = await get(filingLink);
  const href = /<td scope="row"><a href="(?:\/ix\?doc=)?([^"]+\.html?)"[^]*?<\/td>\s*<td scope="row">8-K<\/td>/i.exec(index)?.[1];
  if (!href) throw new Error("no 8-K document in filing index");
  return htmlToText(await get(new URL(href, "https://www.sec.gov").href));
}

/** Facts and signals from the filing text: { keyFacts: [{ item, text }], signals: {...} } */
export async function analyzeFiling(filing, userAgent) {
  const text = await fetchMainDocument(filing.filingLink, userAgent);
  const sections = itemSections(text, filing.events.map((e) => e.item));
  const keyFacts = filing.events
    .filter((e) => sections[e.item])
    .map((e) => ({ item: e.item, text: openingSentences(sections[e.item]) }));

  // Signals come from the opening facts only: later text is full of boilerplate
  // ("until her earlier death, resignation or removal") and biographies.
  const fact = (item) => keyFacts.find((k) => k.item === item)?.text ?? "";
  const people = fact("5.02").replace(/\b(?:death|resignation|removal|disqualification)(?:,? (?:or |and )?(?:death|resignation|removal|disqualification))+/gi, "");
  const listing = sections["3.01"]?.slice(0, 2500) ?? "";
  const ROLE = /(Chief Executive Officer|\bCEO\b)|(Chief Financial Officer|\bCFO\b)/;
  const departure = /\b(resign|retire|step(?:s|ped)? down|cease[sd]? to serve|terminat|depart|separat|transition|will not stand for re-?election)/i.test(people);
  const roleOf = (m) => (m?.[1] ? "CEO" : m?.[2] ? "CFO" : null);
  const signals = {
    departure,
    departingRole: departure ? roleOf(ROLE.exec(people)) : null,
    newBoardMember: /\b(appoint|elect|name)\w*[\s\S]{0,200}?\b(to (?:the|its) Board|as an? (?:\w+ ){0,3}director|director of the Company)/i.test(people),
    newRole: roleOf(
      /\b(?:appoint|elect|name|promot)\w*[\s\S]{0,160}?\b(?:as|to serve as|to the (?:role|position) of)\s+(?:the Company’s |the Company's |its |the )?(?:Co-)?(?:(Chief Executive Officer|CEO)|(Chief Financial Officer|CFO))/.exec(people),
    ),
    appointment: /\b(appoint|elect|named|hired|promot)/i.test(people),
    voluntaryTransfer:
      /\btransfer (?:the |its )?(?:listing|common stock)|voluntar/i.test(listing) && !/deficien|non-?compliance|not in compliance|notif/i.test(listing),
  };
  return { keyFacts, signals };
}

/** One plain-English sentence about the most important event. */
export function plainSummary(filing, ticker, analysis) {
  const co = ticker ? `${filing.companyTitle} (${ticker})` : filing.companyTitle;
  const s = analysis?.signals ?? {};
  const sentences = {
    "1.03": `${co} has filed for bankruptcy or been placed in receivership.`,
    "1.05": `${co} reports a material cybersecurity incident (for example a hack or data breach).`,
    "4.02": `${co} says some of its earlier financial statements can no longer be trusted and will be corrected (a restatement).`,
    "2.04": `Something has happened that makes ${co} repay debt sooner or owe more than planned.`,
    "2.06": `${co} is writing down the value of some of its assets (an impairment), which usually means a loss.`,
    "3.01": s.voluntaryTransfer
      ? `${co} is moving its stock listing to another exchange by choice (usually not a warning sign).`
      : `${co} was told by its stock exchange that it fails a listing rule and could be delisted if it does not fix it.`,
    "4.01": `${co} has changed or lost its outside auditor.`,
    "5.02": s.departingRole
      ? `${co} says its ${s.departingRole} is leaving that role.`
      : s.departure
        ? `${co} says an executive or board member is leaving.`
        : s.newBoardMember
          ? `${co} added a new member to its board of directors.`
          : s.newRole
            ? `${co} named a new ${s.newRole}.`
            : s.appointment
              ? `${co} appointed a new executive.`
              : `${co} announced a change involving its executives, board, or their pay.`,
  };
  const SEVERITY_RANK = { critical: 3, high: 2, medium: 1 };
  const top = [...filing.events].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
  return sentences[top.item] ?? `${co} filed an 8-K reporting: ${top.event}.`;
}
