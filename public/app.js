const ACCOUNTS = ["regular", "IKE", "IKZE", "OKI"];
const CLASSES = ["Bonds", "Shares & ETFs", "Funds"];
const PAGES = { overview: "Overview", holdings: "Holdings", income: "Income & tax", bonds: "Bond outlook", entries: "Entries" };
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
const CLASS_COLOR = { Bonds: SERIES[0], "Shares & ETFs": SERIES[1], Funds: SERIES[2] };
const ACCOUNT_COLOR = { regular: SERIES[0], IKE: SERIES[1], IKZE: SERIES[2], OKI: SERIES[3] };

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  data: null,
  portfolio: {},
  page: "overview",
  net: store.get("net", false),
  account: "all",
  assetClass: "all",
  search: "",
  sort: store.get("sort", { key: "value", asc: false }),
  open: new Set(),
  allocMode: "assetClass",
  projection: [],
  editing: null, // { list, index }
};

// ---------------------------------------------------------------- formatting

const pln = (x, digits = 2) =>
  x == null ? "–" : x.toLocaleString("pl-PL", { style: "currency", currency: "PLN", minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (x) => (x == null ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${pln(Math.abs(x))}`);
const pct = (x) => (x == null || !isFinite(x) ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(2).replace(".", ",")}%`);
const cls = (x) => (x == null || x === 0 ? "" : x > 0 ? "up" : "down");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dateFmt = (d, opts = { day: "numeric", month: "short", year: "numeric" }) => new Date(d).toLocaleDateString("en-GB", opts);
const accountName = (a) => (a === "regular" ? "Regular" : a);
const gainOf = (r) => (state.net ? r.netIncome : r.income);

// ---------------------------------------------------------------- data

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function load(refresh = false) {
  $("#asof").textContent = "Updating prices…";
  $("#refresh").disabled = true;
  try {
    const [data, portfolio] = await Promise.all([api(`/api/report${refresh ? "?refresh" : ""}`), api("/api/portfolio")]);
    state.data = data;
    state.portfolio = portfolio;
    $("#asof").textContent = `Valued ${dateFmt(data.asOf, { weekday: "long", day: "numeric", month: "long" })}${data.offline ? " · offline, manual prices" : ""}`;
    renderWarnings(data.warnings);
    if (state.page === "bonds") await loadProjection();
  } catch (e) {
    $("#asof").textContent = "";
    renderWarnings([e.message]);
  } finally {
    $("#refresh").disabled = false;
  }
  render();
}

async function save(next, message) {
  await api("/api/portfolio", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
  toast(message);
  await load();
}

function renderWarnings(list) {
  const box = $("#warnings");
  if (!list?.length) return (box.innerHTML = "");
  box.innerHTML = list.length === 1
    ? `<div class="warn">⚠ ${esc(list[0])}</div>`
    : `<div class="warn"><details><summary>⚠ ${list.length} things need attention</summary><ul>${list.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details></div>`;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}

// ---------------------------------------------------------------- routing

function go(page) {
  state.page = PAGES[page] ? page : "overview";
  $$(".page").forEach((p) => (p.hidden = p.id !== `page-${state.page}`));
  $$("#nav a, #bottomNav a").forEach((a) => a.classList.toggle("on", a.dataset.page === state.page));
  $("#pageTitle").textContent = PAGES[state.page];
  Charts.hideTip();
  if (state.page === "bonds" && state.data) loadProjection().then(render);
  else render();
}
window.addEventListener("hashchange", () => go(location.hash.slice(1)));
$("#bottomNav").innerHTML = $("#nav").innerHTML;

function render() {
  if (!state.data) return;
  ({ overview: renderOverview, holdings: renderHoldings, income: renderIncome, bonds: renderBonds, entries: renderEntries })[state.page]();
  $("#symbols").innerHTML = (state.portfolio.instruments ?? []).map((i) => `<option value="${esc(i.symbol)}">${esc(i.name ?? "")}</option>`).join("");
}

// ---------------------------------------------------------------- overview

function totals(rows) {
  const sum = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const cost = sum((r) => r.cost), value = sum((r) => r.value), gain = sum(gainOf);
  return { cost, value, gain, ret: cost ? (gain / cost) * 100 : null };
}

function emptyState(target) {
  target.innerHTML = `<div class="empty"><p>Nothing here yet. Add your first bond or trade, or explore with sample data.</p>
    <button class="btn primary" data-action="add">Add a holding</button> <button class="btn ghost" data-action="sample">Load sample data</button></div>`;
}

function renderOverview() {
  const rows = state.data.rows;
  const t = totals(rows);
  $("#hValue").textContent = pln(t.value);
  const g = $("#hGain");
  g.textContent = `${signed(t.gain)}  ${pct(t.ret)}`;
  g.className = `pill ${cls(t.gain)}`;
  $("#hGainLabel").textContent = state.net ? "total gain after Belka" : "total gain before tax";
  $("#hCost").textContent = pln(t.cost);
  $("#hReturn").textContent = pct(t.ret);
  $("#hReturn").className = cls(t.gain);
  $("#hCount").textContent = rows.length;

  // value over time
  const hist = state.data.history;
  const hc = $("#historyChart");
  if (!rows.length) emptyState(hc);
  else if (hist.length < 2) {
    hc.innerHTML = `<div class="empty-msg">The chart starts filling in from tomorrow: the app saves one snapshot of your portfolio each day you open it.</div>`;
  } else {
    Charts.line(hc, [
      { key: "Value", points: hist.map((h) => ({ x: h.date, y: h.value })) },
      { key: "Invested", points: hist.map((h) => ({ x: h.date, y: h.cost })), className: "cost" },
    ], { format: (v) => pln(v), xLabel: (d) => dateFmt(d, { day: "numeric", month: "short" }), tipTitle: (d) => dateFmt(d) });
    hc.insertAdjacentHTML("beforeend", `<div class="legend-inline"><span><i></i>Value</span><span><i class="dash"></i>Invested</span></div>`);
  }

  // allocation
  const key = state.allocMode;
  const groups = key === "assetClass" ? CLASSES : ACCOUNTS;
  const items = groups
    .map((gname) => ({
      label: key === "account" ? accountName(gname) : gname,
      value: rows.filter((r) => r[key] === gname).reduce((a, r) => a + (r.value ?? 0), 0),
      color: (key === "assetClass" ? CLASS_COLOR : ACCOUNT_COLOR)[gname],
    }))
    .filter((i) => i.value > 0);
  if (items.length) Charts.donut($("#allocChart"), items, { format: (v) => pln(v, 0), center: pln(t.value, 0) });
  else $("#allocChart").innerHTML = `<p class="muted">No holdings yet.</p>`;

  // events
  const ev = state.data.events.slice(0, 6);
  $("#events").innerHTML = ev.length
    ? ev.map((e) => {
        const d = new Date(e.date);
        return `<li><div class="date-badge"><b>${d.getDate()}</b><span>${d.toLocaleDateString("en-GB", { month: "short" })}</span></div>
          <div><div class="t">${esc(e.title)}</div><div class="d">${esc(e.detail)}</div></div>
          <div class="a">${e.amount != null ? `${e.kind === "maturity" ? "" : "+"}${pln(e.amount)}` : ""}</div></li>`;
      }).join("")
    : `<li class="empty-list">No bond payouts, rate changes or maturities in the next four months.</li>`;

  // movers
  const ranked = rows.filter((r) => gainOf(r) != null && r.cost).map((r) => ({ r, ret: (gainOf(r) / r.cost) * 100 })).sort((a, b) => b.ret - a.ret);
  const pick = ranked.length > 4 ? [...ranked.slice(0, 3), ranked.at(-1)] : ranked;
  $("#movers").innerHTML = pick.length
    ? pick.map(({ r, ret }) => `<li><div class="name" style="display:flex;gap:12px;align-items:center">${avatar(r)}
        <div><b>${esc(r.name)}</b><div class="d">${accountName(r.account)} · ${esc(r.assetClass)}</div></div></div>
        <div class="r ${cls(ret)}">${pct(ret)}<div class="d">${signed(gainOf(r))}</div></div></li>`).join("")
    : `<li class="empty-list">Add holdings to see how they're doing.</li>`;
}

function priceText(p) {
  const v = p.value.toLocaleString("pl-PL", { maximumFractionDigits: 4 });
  return `${v} ${p.currency === "PLN" ? "zł" : p.currency} on ${dateFmt(p.date, { day: "numeric", month: "short" })}`;
}

function avatar(r) {
  const label = r.name.slice(0, 3);
  return `<span class="avatar" style="background:${CLASS_COLOR[r.assetClass]}">${esc(label)}</span>`;
}

// ---------------------------------------------------------------- holdings

function filteredRows() {
  const q = state.search.trim().toLowerCase();
  return state.data.rows.filter(
    (r) =>
      (state.account === "all" || r.account === state.account) &&
      (state.assetClass === "all" || r.assetClass === state.assetClass) &&
      (!q || `${r.name} ${r.detail}`.toLowerCase().includes(q)),
  );
}

function renderHoldings() {
  const rows = state.data.rows;
  const chip = (group, value, label, on) => `<button data-${group}="${value}" class="${on ? "on" : ""}">${label}</button>`;
  $("#accountChips").innerHTML = ["all", ...ACCOUNTS.filter((a) => rows.some((r) => r.account === a))]
    .map((a) => chip("account", a, a === "all" ? "All accounts" : accountName(a), state.account === a)).join("");
  $("#classChips").innerHTML = ["all", ...CLASSES.filter((c) => rows.some((r) => r.assetClass === c))]
    .map((c) => chip("class", c, c === "all" ? "All types" : c, state.assetClass === c)).join("");
  $("#gainHead").textContent = state.net ? "Gain after Belka" : "Gain";

  const { key, asc } = state.sort;
  const val = (r) => ({ name: r.name, account: r.account, quantity: r.quantity, cost: r.cost, value: r.value ?? -Infinity,
    gain: gainOf(r) ?? -Infinity, ret: r.cost ? (gainOf(r) ?? 0) / r.cost : 0 })[key];
  const list = filteredRows().sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return asc ? c : -c;
  });
  $$("#holdingsTable th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === key);
    th.classList.toggle("asc", th.dataset.sort === key && asc);
  });

  const empty = $("#holdingsEmpty");
  empty.hidden = list.length > 0;
  if (!rows.length) emptyState(empty);
  else empty.innerHTML = `<p>No holdings match these filters.</p>`;

  $("#holdingsTable tbody").innerHTML = list.map((r) => {
    const g = gainOf(r);
    const id = `${r.kind}|${r.name}|${r.account}|${r.detail}`;
    const parts = Object.entries(r.breakdown).map(([k, v]) => `<div><span>${esc(k)}</span><strong class="${k.includes("tax") || k === "Belka" ? "" : cls(v)}">${pln(v)}</strong></div>`);
    if (r.ifSoldNow != null) parts.push(`<div><span>If redeemed today, after fee and Belka</span><strong class="${cls(r.ifSoldNow)}">${signed(r.ifSoldNow)}</strong></div>`);
    return `<tr class="main" data-id="${esc(id)}">
        <td><div class="name">${avatar(r)}<div><b>${esc(r.name)} <span class="badge m ${r.account === "regular" ? "" : "tax-free"}">${accountName(r.account)}</span></b><small title="${esc(r.detail)}">${esc(r.detail)}${r.price ? ` · ${priceText(r.price)}` : r.kind === "stock" ? " · no price" : ""}</small></div></div></td>
        <td><span class="badge ${r.account === "regular" ? "" : "tax-free"}">${accountName(r.account)}</span></td>
        <td class="num">${r.quantity.toLocaleString("pl-PL")}</td>
        <td class="num">${pln(r.cost)}</td>
        <td class="num">${pln(r.value)}</td>
        <td class="num ${cls(g)}">${signed(g)}</td>
        <td class="num ${cls(g)}">${pct(g != null && r.cost ? (g / r.cost) * 100 : null)}</td>
      </tr>
      <tr class="details" ${state.open.has(id) ? "" : "hidden"}><td colspan="7"><div class="breakdown">${parts.join("")}</div></td></tr>`;
  }).join("");
}

// ---------------------------------------------------------------- income & tax

function renderIncome() {
  const { contributions, income } = state.data;
  $("#selfEmployed").checked = !!state.portfolio.settings?.ikzeSelfEmployed;
  $("#limitsTitle").textContent = `Tax-free accounts in ${contributions[0]?.year ?? ""}`;
  $("#limits").innerHTML = contributions.map((c) => {
    const share = c.limit ? Math.min(100, (c.paidIn / c.limit) * 100) : 0;
    const left = c.limit ? Math.max(0, c.limit - c.paidIn) : null;
    return `<div class="limit"><div class="top"><b>${c.account}</b><span>${pln(c.paidIn)} of ${c.limit ? pln(c.limit) : "–"}</span></div>
      <div class="bar-track" role="progressbar" aria-valuenow="${share.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><div class="bar-fill" style="width:${share}%"></div></div>
      <div class="left">${left == null ? "No limit known for this year" : left > 0 ? `${pln(left)} left to use this year` : "Limit reached"}${c.account === "IKZE" ? " · contributions lower your PIT" : ""}</div></div>`;
  }).join("");

  const chart = $("#incomeChart");
  if (income.length) {
    const items = [...income].reverse().map((y) => ({
      label: String(y.year),
      value: y.totalNet,
      tip: `<div class="tt-row"><span>Bond interest</span><span>${pln(y.bondInterest - y.bondTax)}</span></div>
        <div class="tt-row"><span>Dividends</span><span>${pln(y.dividends - y.dividendTax)}</span></div>
        <div class="tt-row"><span>Realised gains</span><span>${pln(y.realizedRegular - y.pit38Tax + y.realizedTaxFree)}</span></div>`,
    }));
    Charts.bars(chart, items, { format: (v) => pln(v) });
  } else chart.innerHTML = `<div class="empty-msg">Interest payouts, dividends and sales will show up here, year by year.</div>`;

  const kv = (label, v, kind = "") => (v ? `<div class="kv ${kind}"><span>${label}</span><span class="${kind ? "" : cls(v)}">${kind === "tax" ? `−${pln(v)}` : kind === "plain" ? pln(v) : signed(v)}</span></div>` : "");
  $("#incomeYears").innerHTML = income.map((y) => `
    <div class="card">
      <div class="year-head"><h2>${y.year}</h2><strong class="${cls(y.totalNet)}">${signed(y.totalNet)}</strong></div>
      ${kv("Bond interest received", y.bondInterest, "plain")}
      ${kv("Belka withheld on bonds", y.bondTax, "tax")}
      ${kv("Dividends (gross)", y.dividends, "plain")}
      ${kv("Dividend tax", y.dividendTax, "tax")}
      ${kv("Realised gains, regular account", y.realizedRegular)}
      ${kv("PIT-38 tax due (19%)", y.pit38Tax, "tax")}
      ${kv("Realised in IKE/IKZE/OKI (no Belka)", y.realizedTaxFree)}
      <div class="kv total"><span>Net income</span><span>${signed(y.totalNet)}</span></div>
      ${y.realizedRegular ? `<p class="note">PIT-38 for ${y.year} is due by 30 April ${y.year + 1}. Losses offset gains within the same year.</p>` : ""}
    </div>`).join("");
}

// ---------------------------------------------------------------- bonds

let projTimer;
async function loadProjection() {
  const d = state.data.defaults;
  const infl = $("#infl"), nbp = $("#nbp");
  if (!infl.dataset.ready) {
    infl.value = store.get("assumeInfl", d.inflation);
    nbp.value = store.get("assumeNbp", d.nbpRate);
    infl.dataset.ready = "1";
  }
  $("#inflOut").textContent = `${Number(infl.value).toFixed(1)}%`;
  $("#nbpOut").textContent = `${Number(nbp.value).toFixed(2)}%`;
  state.projection = await api(`/api/projection?inflation=${infl.value}&nbp=${nbp.value}`).catch(() => []);
}

function renderBonds() {
  const proj = state.projection;
  const sum = (f) => proj.reduce((a, p) => a + f(p), 0);
  const last = proj.reduce((a, p) => (p.maturity > a ? p.maturity : a), "");
  $("#projTotals").innerHTML = proj.length ? `
    <div><span class="label">Invested</span><strong>${pln(sum((p) => p.cost), 0)}</strong></div>
    <div><span class="label">Paid out at maturity</span><strong>${pln(sum((p) => p.valueAtMaturity), 0)}</strong></div>
    <div><span class="label">Interest, before tax</span><strong class="up">${signed(sum((p) => p.gain))}</strong></div>
    <div><span class="label">Interest after Belka</span><strong class="up">${signed(sum((p) => p.netGain))}</strong></div>`
    : `<p class="muted">Add a bond to see what it will be worth at maturity.</p>`;

  const pick = $("#projPick");
  const options = proj.map((p, i) => `<option value="${i}">${p.series} · ${accountName(p.account)} · ${p.quantity} bonds</option>`).join("");
  if (pick.innerHTML !== options) pick.innerHTML = options;
  const chosen = proj[Number(pick.value) || 0];
  const chart = $("#projChart");
  if (chosen) {
    Charts.line(chart, [
      { key: "Projected value", points: chosen.points.map((p) => ({ x: p.date, y: p.value })) },
      { key: "Invested", points: chosen.points.map((p) => ({ x: p.date, y: chosen.cost })), className: "cost" },
    ], { format: (v) => pln(v), xLabel: (d) => new Date(d).getFullYear(), tipTitle: (d) => dateFmt(d), baseline: chosen.cost });
    chart.insertAdjacentHTML("beforeend", `<div class="legend-inline"><span><i></i>Value incl. interest paid out</span><span><i class="dash"></i>Invested</span></div>`);
  } else chart.innerHTML = `<div class="empty-msg">No bonds yet.</div>`;

  $("#projTable tbody").innerHTML = proj.map((p) => `<tr>
      <td><b>${p.series}</b> <span class="muted small">× ${p.quantity}</span></td>
      <td><span class="badge ${p.account === "regular" ? "" : "tax-free"}">${accountName(p.account)}</span></td>
      <td class="num">${dateFmt(p.maturity)}</td>
      <td class="num">${pln(p.cost)}</td>
      <td class="num">${pln(p.valueAtMaturity)}</td>
      <td class="num up">${signed(p.gain)}</td>
      <td class="num up">${signed(p.netGain)}</td></tr>`).join("");
  if (last) $("#projTotals").title = `Last bond matures ${dateFmt(last)}`;
}

// ---------------------------------------------------------------- entries

function entryList() {
  const p = state.portfolio;
  const out = [];
  (p.bonds ?? []).forEach((b, i) => out.push({ list: "bonds", i, date: b.purchaseDate, icon: "🏛",
    main: `${b.series} × ${b.quantity}`, sub: `Bond bought ${dateFmt(b.purchaseDate)} · ${accountName(b.account)}` }));
  (p.trades ?? []).forEach((t, i) => out.push({ list: "trades", i, date: t.date, icon: t.type === "buy" ? "↗" : "↘",
    main: `${t.type === "buy" ? "Bought" : "Sold"} ${t.quantity} ${t.symbol} at ${t.price}`, sub: `${dateFmt(t.date)} · ${accountName(t.account)}${t.commission ? ` · commission ${t.commission}` : ""}` }));
  (p.dividends ?? []).forEach((d, i) => out.push({ list: "dividends", i, date: d.date, icon: "💰",
    main: `Dividend ${d.symbol}: ${d.gross}`, sub: `${dateFmt(d.date)} · ${accountName(d.account)}${d.withheldTax != null ? ` · tax withheld ${d.withheldTax}` : ""}` }));
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function renderEntries() {
  const q = $("#entrySearch").value.trim().toLowerCase();
  const list = entryList().filter((e) => !q || `${e.main} ${e.sub}`.toLowerCase().includes(q));
  const box = $("#entries");
  if (!entryList().length) {
    box.innerHTML = "<li style='display:block'></li>";
    emptyState(box.firstChild);
    return;
  }
  box.innerHTML = list.map((e) => `<li><span class="kind">${e.icon}</span>
      <div><div class="main-t">${esc(e.main)}</div><div class="sub-t">${esc(e.sub)}</div></div>
      <div class="btns"><button class="btn small" data-edit="${e.list}:${e.i}">Edit</button><button class="btn small danger" data-del="${e.list}:${e.i}">Delete</button></div></li>`).join("")
    || `<li class="empty-list" style="display:block">No entries match.</li>`;
}

// ---------------------------------------------------------------- dialog

const FORMS = { bonds: "bond", trades: "trade", dividends: "dividend" };
$$("select[name=account]").forEach((s) => (s.innerHTML = ACCOUNTS.map((a) => `<option value="${a}">${accountName(a)}</option>`).join("")));

function showForm(name) {
  $$("#formTabs button").forEach((b) => b.classList.toggle("on", b.dataset.form === name));
  ["bond", "trade", "dividend"].forEach((f) => ($(`#form-${f}`).hidden = f !== name));
  $("#formError").textContent = "";
}

function setTradeType(type) {
  $("#form-trade [name=type]").value = type;
  $$("#tradeType button").forEach((b) => b.classList.toggle("on", b.dataset.type === type));
}

function openDialog(edit) {
  state.editing = edit ?? null;
  ["bond", "trade", "dividend"].forEach((f) => $(`#form-${f}`).reset());
  setTradeType("buy");
  $("#formTabs").hidden = !!edit;
  const todayStr = new Date().toISOString().slice(0, 10);
  $$("#dialog input[type=date]").forEach((i) => (i.value = todayStr));
  if (edit) {
    const entry = state.portfolio[edit.list][edit.index];
    const form = $(`#form-${FORMS[edit.list]}`);
    for (const [k, v] of Object.entries({ ...entry, ...(entry.terms ?? {}) })) {
      const input = form.elements[k];
      if (input && typeof v !== "object") input.value = v;
    }
    if (edit.list === "trades") setTradeType(entry.type);
    $("#dialogTitle").textContent = "Edit entry";
    showForm(FORMS[edit.list]);
  } else {
    $("#dialogTitle").textContent = "Add to portfolio";
    showForm(store.get("lastForm", "bond"));
  }
  $("#dialog").showModal();
}

const num = (v) => (v === "" || v == null ? undefined : Number(v));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && !(typeof v === "number" && isNaN(v))));

async function submitEntry(list, entry, extra = {}, label) {
  const next = { ...state.portfolio, ...extra };
  const items = [...(next[list] ?? [])];
  if (state.editing) items[state.editing.index] = entry;
  else items.push(entry);
  next[list] = items;
  const btn = $(`#form-${FORMS[list]} button.primary`);
  btn.disabled = true;
  $("#formError").textContent = "";
  try {
    await save(next, state.editing ? "Changes saved" : label);
    store.set("lastForm", FORMS[list]);
    $("#dialog").close();
  } catch (e) {
    $("#formError").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

$("#form-bond").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const terms = f.firstYearRate ? { firstYearRate: num(f.firstYearRate), margin: num(f.margin) ?? 0, earlyFee: num(f.earlyFee) ?? 0 } : undefined;
  const bond = clean({ series: f.series.toUpperCase(), purchaseDate: f.purchaseDate, quantity: num(f.quantity), pricePerBond: num(f.pricePerBond), account: f.account, terms });
  submitEntry("bonds", bond, {}, `Added ${bond.quantity} × ${bond.series}`);
});

$("#form-trade").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const symbol = f.symbol.trim().toUpperCase();
  const instruments = [...(state.portfolio.instruments ?? [])];
  if (!instruments.some((i) => i.symbol === symbol)) {
    instruments.push(clean({ symbol, name: f.name, currency: (f.currency || "PLN").toUpperCase(), stooq: f.stooq, yahoo: f.yahoo, analizy: f.analizy }));
  }
  const old = state.editing ? state.portfolio.trades[state.editing.index] : {};
  const trade = clean({ ...old, symbol, account: f.account, type: f.type, date: f.date, quantity: num(f.quantity), price: num(f.price), commission: num(f.commission) });
  submitEntry("trades", trade, { instruments }, `${trade.type === "buy" ? "Bought" : "Sold"} ${trade.quantity} ${symbol}`);
});

$("#form-dividend").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const old = state.editing ? state.portfolio.dividends[state.editing.index] : {};
  const dividend = clean({ ...old, symbol: f.symbol.trim().toUpperCase(), account: f.account, date: f.date, gross: num(f.gross), withheldTax: num(f.withheldTax) });
  if (f.withheldTax === "") delete dividend.withheldTax;
  submitEntry("dividends", dividend, {}, `Added dividend for ${dividend.symbol}`);
});

$("#form-trade [name=symbol]").addEventListener("input", (e) => {
  const known = (state.portfolio.instruments ?? []).some((i) => i.symbol === e.target.value.trim().toUpperCase());
  $("#newInstrument").hidden = known;
});

// ---------------------------------------------------------------- events

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, tr.main, [data-action]");
  if (!t) return;
  const d = t.dataset;
  if (d.action === "add" || t.id === "addBtn") openDialog();
  else if (d.action === "sample") {
    if ((state.portfolio.bonds?.length || state.portfolio.trades?.length) && !confirm("Replace your entries with the sample portfolio?")) return;
    await save(await api("/api/sample"), "Sample portfolio loaded").catch((err) => toast(err.message, true));
  } else if (t.id === "refresh") load(true);
  else if (d.form) { showForm(d.form); }
  else if (d.type) setTradeType(d.type);
  else if (d.account) { state.account = d.account; render(); }
  else if (d.class) { state.assetClass = d.class; render(); }
  else if (d.mode) {
    state.allocMode = d.mode;
    $$("#allocMode button").forEach((b) => b.classList.toggle("on", b === t));
    render();
  } else if (d.themeSet) setTheme(d.themeSet);
  else if (d.edit) {
    const [list, index] = d.edit.split(":");
    openDialog({ list, index: Number(index) });
  } else if (d.del) {
    const [list, index] = d.del.split(":");
    if (!confirm("Delete this entry?")) return;
    const next = { ...state.portfolio, [list]: state.portfolio[list].filter((_, j) => j !== Number(index)) };
    await save(next, "Entry deleted").catch((err) => toast(err.message, true));
  } else if (t.matches("tr.main")) {
    const id = t.dataset.id;
    state.open.has(id) ? state.open.delete(id) : state.open.add(id);
    t.nextElementSibling.hidden = !state.open.has(id);
  }
});

$$("#holdingsTable th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  const key = th.dataset.sort;
  state.sort = { key, asc: state.sort.key === key ? !state.sort.asc : key === "name" || key === "account" };
  store.set("sort", state.sort);
  render();
}));
$("#search").addEventListener("input", (e) => { state.search = e.target.value; render(); });
$("#entrySearch").addEventListener("input", renderEntries);
$("#projPick").addEventListener("change", renderBonds);
["#infl", "#nbp"].forEach((id) => $(id).addEventListener("input", () => {
  $("#inflOut").textContent = `${Number($("#infl").value).toFixed(1)}%`;
  $("#nbpOut").textContent = `${Number($("#nbp").value).toFixed(2)}%`;
  store.set("assumeInfl", Number($("#infl").value));
  store.set("assumeNbp", Number($("#nbp").value));
  clearTimeout(projTimer);
  projTimer = setTimeout(async () => { await loadProjection(); renderBonds(); }, 200);
}));

for (const id of ["#netToggle", "#netToggleMobile"]) {
  $(id).checked = state.net;
  $(id).addEventListener("change", (e) => {
    state.net = e.target.checked;
    $("#netToggle").checked = $("#netToggleMobile").checked = state.net;
    store.set("net", state.net);
    render();
  });
}

$("#selfEmployed").addEventListener("change", async (e) => {
  const next = { ...state.portfolio, settings: { ...(state.portfolio.settings ?? {}), ikzeSelfEmployed: e.target.checked } };
  await save(next, "Saved").catch((err) => toast(err.message, true));
});

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.portfolio, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `portfel-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const next = JSON.parse(await file.text());
    if (!confirm("Replace all current entries with this backup?")) return;
    await save(next, "Backup restored");
  } catch (err) {
    toast(`Couldn't import: ${err.message}`, true);
  } finally {
    e.target.value = "";
  }
});

function setTheme(mode) {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  $$(".theme button").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === mode));
  store.set("theme", mode);
  if (state.data) render();
}

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });

setTheme(store.get("theme", "auto"));
go(location.hash.slice(1) || "overview");
load();
