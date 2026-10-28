const listEl = document.getElementById("list");
const hintEl = document.getElementById("hint");
const panel = document.getElementById("unlock-panel");
const unlockMeta = document.getElementById("unlock-meta");
const unlockBody = document.getElementById("unlock-body");

function fmtTime(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function loadHealth() {
  const res = await fetch("/health");
  const data = await res.json();
  document.getElementById("stat-status").textContent = data.status ?? "unknown";
  document.getElementById("stat-count").textContent = String(data.storedFilings ?? "—");
  document.getElementById("stat-poll").textContent = data.lastPoll?.ok === false
    ? `failed: ${data.lastPoll.error}`
    : fmtTime(data.lastPoll?.at);
  document.getElementById("stat-payto").textContent = data.payTo ?? "—";
  if (data.price) document.getElementById("lede-price").textContent = `${data.price.replace(/^\$/, "")} USDC`;
  if (data.networkLabel) {
    document.getElementById("kicker-network").textContent = data.networkLabel.split(",")[0];
    document.getElementById("lede-network").textContent = ` (${data.networkLabel})`;
  }
}

function card(filing) {
  const li = document.createElement("li");
  li.className = "card";
  const events = filing.events.map((e) => `<li>Item ${e.item}: ${e.event}</li>`).join("");
  li.innerHTML = `
    <div class="card-top">
      <span class="severity ${filing.severity}">${filing.severity}</span>
      <span class="meta">${filing.formType} · ${fmtTime(filing.filedAt)}</span>
    </div>
    <ul class="events">${events}</ul>
    <p class="meta">${filing.accessionNumber} · ${filing.price}</p>
    <button type="button" class="ghost" data-id="${filing.accessionNumber}">Try unlock (shows 402)</button>
  `;
  li.querySelector("button").addEventListener("click", () => unlock(filing.accessionNumber));
  return li;
}

async function loadFilings() {
  hintEl.textContent = "Loading EDGAR feed…";
  const res = await fetch("/filings");
  const data = await res.json();
  listEl.replaceChildren();
  if (!data.filings?.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No high-impact 8-Ks in the current EDGAR window. Routine filings are filtered out.";
    listEl.append(empty);
    hintEl.textContent = `${data.count ?? 0} packets.`;
    return;
  }
  for (const filing of data.filings) listEl.append(card(filing));
  hintEl.textContent = `${data.count} packets. Company identity is behind the paywall.`;
}

async function unlock(id) {
  panel.classList.remove("hidden");
  unlockMeta.textContent = `GET /filings/${id}`;
  unlockBody.textContent = "Requesting…";
  const res = await fetch(`/filings/${id}`);
  const paymentHeader = res.headers.get("payment-required") ?? res.headers.get("PAYMENT-REQUIRED");
  const body = await res.json().catch(() => ({}));
  if (res.status === 402) {
    let challenge = body;
    if (paymentHeader) {
      try {
        challenge = JSON.parse(atob(paymentHeader));
      } catch {
        challenge = { paymentRequired: paymentHeader, body };
      }
    }
    unlockMeta.textContent = `HTTP 402 Payment Required · ${id}`;
    unlockBody.textContent = JSON.stringify(challenge, null, 2);
    return;
  }
  unlockMeta.textContent = `HTTP ${res.status} · ${id}`;
  unlockBody.textContent = JSON.stringify(body, null, 2);
}

document.getElementById("refresh").addEventListener("click", () => {
  loadHealth().catch(console.error);
  loadFilings().catch((err) => {
    hintEl.textContent = err.message;
  });
});

loadHealth().catch(console.error);
loadFilings().catch((err) => {
  hintEl.textContent = err.message;
});
