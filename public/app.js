const ACCOUNTS = ["regular", "IKE", "IKZE", "OKI"];
const $ = (s) => document.querySelector(s);
const state = { rows: [], account: "all", net: false, portfolio: {}, open: new Set() };

const pln = (x) => (x == null ? "–" : x.toLocaleString("pl-PL", { style: "currency", currency: "PLN" }));
const pct = (x) => (x == null || !isFinite(x) ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
const cls = (x) => (x == null ? "" : x >= 0 ? "up" : "down");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

try { state.net = localStorage.getItem("net") === "1"; } catch {}
$("#net").checked = state.net;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function load(refresh = false) {
  $("#asof").textContent = "Loading prices…";
  try {
    const [report, portfolio] = await Promise.all([api(`/api/report${refresh ? "?refresh" : ""}`), api("/api/portfolio")]);
    state.rows = report.rows;
    state.portfolio = portfolio;
    $("#asof").textContent = `As of ${report.asOf}${report.offline ? " · offline, manual prices" : ""}`;
    $("#warnings").innerHTML = report.warnings.map((w) => `<p>${esc(w)}</p>`).join("");
  } catch (e) {
    $("#asof").textContent = "";
    $("#warnings").innerHTML = `<p>${esc(e.message)}</p>`;
  }
  render();
}

function render() {
  const rows = state.rows.filter((r) => state.account === "all" || r.account === state.account);
  const gainOf = (r) => (state.net ? r.netIncome : r.income);
  const sum = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const cost = sum((r) => r.cost), value = sum((r) => r.value), gain = sum(gainOf);

  $("#tValue").textContent = pln(value);
  $("#tCost").textContent = pln(cost);
  $("#tGain").textContent = pln(gain);
  $("#tGain").className = cls(gain);
  $("#tGainLabel").textContent = state.net ? "Gain after Belka" : "Gain before tax";
  $("#gainHead").textContent = state.net ? "Gain after Belka" : "Gain";
  $("#tReturn").textContent = pct(cost ? (gain / cost) * 100 : null);
  $("#tReturn").className = cls(gain);

  const present = ["all", ...ACCOUNTS.filter((a) => state.rows.some((r) => r.account === a))];
  $("#accounts").innerHTML = present
    .map((a) => `<button data-account="${a}" class="${a === state.account ? "active" : ""}">${a === "all" ? "All" : a === "regular" ? "Regular" : a}</button>`)
    .join("");

  $("#empty").hidden = state.rows.length > 0;
  $("#holdings tbody").innerHTML = rows
    .map((r, i) => {
      const g = gainOf(r);
      const key = `${r.kind}|${r.name}|${r.account}|${i}`;
      const extra = Object.entries(r.breakdown)
        .map(([k, v]) => `<span>${esc(k)}: ${pln(v)}</span>`)
        .concat(r.ifSoldNow != null ? [`<span>If redeemed today (after fee & Belka): ${pln(r.ifSoldNow)}</span>`] : [])
        .join("");
      return `<tr class="main" data-key="${esc(key)}">
          <td><strong>${esc(r.name)}</strong><span class="sub">${esc(r.detail)}</span></td>
          <td><span class="badge">${r.account === "regular" ? "Regular" : r.account}</span></td>
          <td class="num">${r.quantity}</td>
          <td class="num">${pln(r.cost)}</td>
          <td class="num">${pln(r.value)}</td>
          <td class="num ${cls(g)}">${pln(g)}</td>
          <td class="num ${cls(g)}">${pct(g != null && r.cost ? (g / r.cost) * 100 : null)}</td>
        </tr>
        <tr class="details" ${state.open.has(key) ? "" : "hidden"}><td colspan="7">${extra}</td></tr>`;
    })
    .join("");

  renderEntries();
}

// ----- entries list -----

function entryLines() {
  const p = state.portfolio;
  const lines = [];
  (p.bonds ?? []).forEach((b, i) => lines.push({ list: "bonds", i, date: b.purchaseDate, text: `${b.series} × ${b.quantity} bought ${b.purchaseDate} (${b.account})` }));
  (p.trades ?? []).forEach((t, i) => lines.push({ list: "trades", i, date: t.date, text: `${t.type === "buy" ? "Buy" : "Sell"} ${t.quantity} ${t.symbol} @ ${t.price} on ${t.date} (${t.account})` }));
  (p.dividends ?? []).forEach((d, i) => lines.push({ list: "dividends", i, date: d.date, text: `Dividend ${d.symbol} ${d.gross} on ${d.date} (${d.account})` }));
  return lines.sort((a, b) => b.date.localeCompare(a.date));
}

function renderEntries() {
  const lines = entryLines();
  $("#form-list").innerHTML = lines.length
    ? lines.map((l) => `<div class="entry"><span>${esc(l.text)}</span><button data-del="${l.list}:${l.i}">Delete</button></div>`).join("")
    : `<p class="muted">Nothing recorded yet.</p>`;
  $("#symbols").innerHTML = (state.portfolio.instruments ?? []).map((i) => `<option value="${esc(i.symbol)}">${esc(i.name ?? "")}</option>`).join("");
}

async function save(next, msg) {
  try {
    await api("/api/portfolio", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    $("#formMsg").textContent = msg;
    await load();
    return true;
  } catch (e) {
    $("#formMsg").textContent = `Not saved: ${e.message}`;
    return false;
  }
}

// ----- forms -----

const num = (v) => (v === "" || v == null ? undefined : Number(v));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

document.querySelectorAll("select[name=account]").forEach((s) => {
  s.innerHTML = ACCOUNTS.map((a) => `<option value="${a}">${a === "regular" ? "Regular" : a}</option>`).join("");
});

$("#form-bond").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const terms = f.firstYearRate ? { firstYearRate: num(f.firstYearRate), margin: num(f.margin) ?? 0, earlyFee: num(f.earlyFee) ?? 0 } : undefined;
  const bond = clean({ series: f.series.toUpperCase(), purchaseDate: f.purchaseDate, quantity: num(f.quantity), pricePerBond: num(f.pricePerBond), account: f.account, terms });
  const next = { ...state.portfolio, bonds: [...(state.portfolio.bonds ?? []), bond] };
  if (await save(next, `Added ${bond.series}.`)) e.target.reset();
});

$("#form-trade").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const symbol = f.symbol.trim().toUpperCase();
  const instruments = [...(state.portfolio.instruments ?? [])];
  if (!instruments.some((i) => i.symbol === symbol)) {
    instruments.push(clean({ symbol, name: f.name, currency: (f.currency || "PLN").toUpperCase(), stooq: f.stooq, yahoo: f.yahoo, analizy: f.analizy }));
  }
  const trade = clean({ symbol, account: f.account, type: f.type, date: f.date, quantity: num(f.quantity), price: num(f.price), commission: num(f.commission) });
  const next = { ...state.portfolio, instruments, trades: [...(state.portfolio.trades ?? []), trade] };
  if (await save(next, `Added ${trade.type} of ${symbol}.`)) e.target.reset();
});

$("#form-dividend").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const symbol = f.symbol.trim().toUpperCase();
  const dividend = clean({ symbol, account: f.account, date: f.date, gross: num(f.gross), withheldTax: num(f.withheldTax) });
  const next = { ...state.portfolio, dividends: [...(state.portfolio.dividends ?? []), dividend] };
  if (await save(next, `Added dividend for ${symbol}.`)) e.target.reset();
});

// ----- events -----

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, tr.main");
  if (!t) return;
  if (t.dataset.account) { state.account = t.dataset.account; render(); }
  else if (t.dataset.form) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === t));
    ["bond", "trade", "dividend", "list"].forEach((f) => ($(`#form-${f}`).hidden = f !== t.dataset.form));
    $("#formMsg").textContent = "";
  } else if (t.dataset.del) {
    const [list, i] = t.dataset.del.split(":");
    const next = { ...state.portfolio, [list]: state.portfolio[list].filter((_, j) => j !== Number(i)) };
    await save(next, "Deleted.");
  } else if (t.id === "refresh") load(true);
  else if (t.id === "sample") {
    const sample = await api("/api/sample");
    await save(sample, "Loaded sample data.");
  } else if (t.matches("tr.main")) {
    const key = t.dataset.key;
    state.open.has(key) ? state.open.delete(key) : state.open.add(key);
    t.nextElementSibling.hidden = !state.open.has(key);
  }
});

$("#net").addEventListener("change", (e) => {
  state.net = e.target.checked;
  try { localStorage.setItem("net", state.net ? "1" : "0"); } catch {}
  render();
});

load();
