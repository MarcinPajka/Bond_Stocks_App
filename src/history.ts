import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { addDays, daysBetween, type IsoDate } from "./bonds/dates.js";
import { valueLot, type BondData } from "./bonds/lot.js";
import type { PortfolioFile, Report } from "./portfolio.js";
import { httpFetch, type Fetcher } from "./prices/providers.js";
import type { Instrument, Trade } from "./stocks/positions.js";

/**
 * Value over time, rebuilt from the entries: bonds with the bond calculator on each day,
 * shares and ETFs from daily closes (Yahoo Finance chart API) converted at NBP rates.
 * Funds priced from analizy.pl have no history source, so their line uses the prices
 * from your own trades and the unit values seen each time the app fetched one.
 */

export type Series = Record<IsoDate, number>;

export interface PriceHistoryCache {
  prices: Record<string, Series>; // symbol -> day -> close, instrument currency
  fx: Record<string, Series>; // currency -> day -> NBP mid rate
  checkedAt: Record<string, number>; // "price:SYMBOL" or "fx:EUR" -> when last fetched
}

export interface Point {
  date: IsoDate;
  value: number;
  cost: number; // money still invested in what is held that day
}

const REFRESH_EVERY_MS = 12 * 3600_000;
const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const unix = (d: IsoDate) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

// ---------------------------------------------------------------- sources

/** Daily closes from the Yahoo chart API (v8/finance/chart?period1=…&interval=1d). */
export function parseYahooHistory(json: string): Series {
  const r = JSON.parse(json)?.chart?.result?.[0];
  const stamps: number[] = r?.timestamp ?? [];
  const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
  const div = r?.meta?.currency === "GBp" ? 100 : 1;
  const offset = r?.meta?.gmtoffset ?? 0;
  const out: Series = {};
  stamps.forEach((t, i) => {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) out[new Date((t + offset) * 1000).toISOString().slice(0, 10)] = round2(c / div * 10000) / 10000;
  });
  return out;
}

/** NBP table A series: {"rates":[{"effectiveDate":"2026-01-02","mid":4.2}]} */
export function parseNbpRateSeries(json: string): Series {
  const out: Series = {};
  for (const r of JSON.parse(json).rates ?? []) out[r.effectiveDate] = r.mid;
  return out;
}

export async function fetchPriceHistory(inst: Instrument, from: IsoDate, to: IsoDate, get: Fetcher = httpFetch): Promise<Series> {
  const yahoo = inst.yahoo ?? `${inst.symbol.toUpperCase()}.WA`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?period1=${unix(from)}&period2=${unix(addDays(to, 1))}&interval=1d`;
  const series = parseYahooHistory(await get(url));
  if (!Object.keys(series).length) throw new Error(`no price history for ${yahoo}`);
  return series;
}

/** NBP allows at most 93 days per request, so longer spans are fetched in pieces. */
export async function fetchFxHistory(currency: string, from: IsoDate, to: IsoDate, get: Fetcher = httpFetch): Promise<Series> {
  const out: Series = {};
  for (let start = from; start <= to; start = addDays(start, 90)) {
    const end = addDays(start, 89) < to ? addDays(start, 89) : to;
    try {
      Object.assign(out, parseNbpRateSeries(await get(`https://api.nbp.pl/api/exchangerates/rates/a/${currency.toLowerCase()}/${start}/${end}/?format=json`)));
    } catch (e) {
      if (!/404/.test((e as Error).message)) throw e; // 404 = no tables in that span (holidays)
    }
  }
  return out;
}

// ---------------------------------------------------------------- cache

export function loadPriceHistory(path: string): PriceHistoryCache {
  const empty = { prices: {}, fx: {}, checkedAt: {} };
  return existsSync(path) ? { ...empty, ...JSON.parse(readFileSync(path, "utf8")) } : empty;
}

/** Earliest trade date per symbol, and per currency for foreign instruments. */
function firstDates(p: PortfolioFile) {
  const symbols: Record<string, IsoDate> = {};
  const currencies: Record<string, IsoDate> = {};
  const cur = new Map((p.instruments ?? []).map((i) => [i.symbol, i.currency]));
  for (const t of p.trades ?? []) {
    if (!symbols[t.symbol] || t.date < symbols[t.symbol]) symbols[t.symbol] = t.date;
    const c = cur.get(t.symbol);
    if (c && c !== "PLN" && (!currencies[c] || t.date < currencies[c])) currencies[c] = t.date;
  }
  return { symbols, currencies };
}

/** Fetches price and exchange-rate history that is missing or older than 12 hours. */
export async function refreshPriceHistory(
  cachePath: string,
  p: PortfolioFile,
  asOf: IsoDate,
  get: Fetcher = httpFetch,
  now = Date.now(),
): Promise<{ cache: PriceHistoryCache; warnings: string[] }> {
  const cache = loadPriceHistory(cachePath);
  const warnings: string[] = [];
  const { symbols, currencies } = firstDates(p);
  const stale = (key: string) => now - (cache.checkedAt[key] ?? 0) > REFRESH_EVERY_MS;
  let changed = false;

  for (const inst of p.instruments ?? []) {
    const from = symbols[inst.symbol];
    if (!from || inst.analizy || !stale(`price:${inst.symbol}`)) continue;
    try {
      cache.prices[inst.symbol] = { ...cache.prices[inst.symbol], ...(await fetchPriceHistory(inst, addDays(from, -7), asOf, get)) };
      cache.checkedAt[`price:${inst.symbol}`] = now;
      changed = true;
    } catch (e) {
      warnings.push(`${inst.symbol}: price history not updated (${(e as Error).message})`);
    }
  }
  for (const [currency, from] of Object.entries(currencies)) {
    if (!stale(`fx:${currency}`)) continue;
    try {
      cache.fx[currency] = { ...cache.fx[currency], ...(await fetchFxHistory(currency, addDays(from, -7), asOf, get)) };
      cache.checkedAt[`fx:${currency}`] = now;
      changed = true;
    } catch (e) {
      warnings.push(`${currency}: NBP rate history not updated (${(e as Error).message})`);
    }
  }
  if (changed) writeFileSync(cachePath, JSON.stringify(cache));
  return { cache, warnings };
}

/** Keeps the prices the report just fetched, so funds without a history source build one up. */
export function recordQuotes(cachePath: string, cache: PriceHistoryCache, report: Report, instruments: Instrument[]) {
  let changed = false;
  for (const pos of report.positions) {
    if (pos.price === undefined || !pos.priceDate) continue;
    const series = (cache.prices[pos.symbol] ??= {});
    if (series[pos.priceDate] !== pos.price) {
      series[pos.priceDate] = pos.price;
      changed = true;
    }
  }
  if (changed && instruments.length) writeFileSync(cachePath, JSON.stringify(cache));
}

// ---------------------------------------------------------------- building the lines

/** Last value on or before each requested day, walking both lists once. */
function stepLookup(series: Series) {
  const days = Object.keys(series).sort();
  let i = -1;
  return (d: IsoDate): number | undefined => {
    while (i + 1 < days.length && days[i + 1] <= d) i++;
    return i >= 0 ? series[days[i]] : series[days[0]];
  };
}

export function chartDates(start: IsoDate, end: IsoDate, maxPoints = 400): IsoDate[] {
  const span = Math.max(0, daysBetween(start, end));
  const step = Math.max(1, Math.ceil(span / maxPoints));
  const out: IsoDate[] = [];
  for (let d = start; d < end; d = addDays(d, step)) out.push(d);
  out.push(end);
  return out;
}

export interface ValueHistory {
  total: Point[];
  byId: Record<string, Point[]>; // keyed like the holdings rows: "bond:<index>", "stock:<symbol>|<account>"
  notes: string[];
}

export function valueHistory(
  p: PortfolioFile,
  trades: Trade[], // with exchange rates filled in, as in the report
  bondData: BondData,
  history: PriceHistoryCache,
  asOf: IsoDate,
): ValueHistory {
  const bonds = p.bonds ?? [];
  const starts = [...bonds.map((b) => b.purchaseDate), ...trades.map((t) => t.date)].filter((d) => d <= asOf).sort();
  if (!starts.length) return { total: [], byId: {}, notes: [] };
  const dates = chartDates(starts[0], asOf);
  const byId: Record<string, Point[]> = {};
  const notes: string[] = [];

  bonds.forEach((lot, i) => {
    const pts: Point[] = [];
    try {
      for (const d of dates) {
        if (d < lot.purchaseDate) continue;
        if (lot.redeemedOn && d > lot.redeemedOn) break;
        const v = valueLot(lot, bondData, d);
        pts.push({ date: d, value: v.redeemed ? v.redeemed.proceeds : v.value, cost: v.cost });
      }
    } catch {
      return; // can't be valued (no terms or CPI yet); the holdings page already says why
    }
    if (pts.length) byId[`bond:${i}`] = pts;
  });

  const instruments = new Map((p.instruments ?? []).map((x) => [x.symbol, x]));
  const keys = [...new Set(trades.map((t) => `${t.symbol}|${t.account}`))];
  for (const key of keys) {
    const [symbol, account] = key.split("|");
    const inst = instruments.get(symbol);
    if (!inst) continue;
    const own = trades.filter((t) => t.symbol === symbol && t.account === account)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.type === "buy" ? -1 : 1));

    // Real prices only: daily closes, the prices you traded at, and prices fetched by the app.
    const priceSeries: Series = {};
    for (const t of trades.filter((t) => t.symbol === symbol)) priceSeries[t.date] = t.price;
    const manual = p.prices?.[symbol];
    if (manual) priceSeries[manual.date] = manual.price;
    Object.assign(priceSeries, history.prices[symbol]);
    const priceOn = stepLookup(priceSeries);

    const fxSeries: Series = {};
    if (inst.currency !== "PLN") {
      for (const t of own) if (t.fxRate) fxSeries[t.date] = t.fxRate;
      if (manual?.fxRate) fxSeries[manual.date] = manual.fxRate;
      Object.assign(fxSeries, history.fx[inst.currency]);
    }
    const fxOn = inst.currency === "PLN" ? () => 1 : stepLookup(fxSeries);
    if (inst.analizy) notes.push(`${symbol}: drawn from your trade prices and the unit values the app has fetched so far`);
    else if (!history.prices[symbol]) notes.push(`${symbol}: no daily prices yet, drawn from your trade prices`);

    const lots: { qty: number; costPerShare: number }[] = [];
    let next = 0;
    const pts: Point[] = [];
    for (const d of dates) {
      for (; next < own.length && own[next].date <= d; next++) {
        const t = own[next];
        const rate = inst.currency === "PLN" ? 1 : (t.fxRate ?? fxOn(t.date) ?? 0);
        if (t.type === "buy") {
          lots.push({ qty: t.quantity, costPerShare: (t.quantity * t.price + (t.commission ?? 0)) * rate / t.quantity });
          continue;
        }
        let left = t.quantity;
        while (left > 1e-9 && lots.length) {
          const take = Math.min(left, lots[0].qty);
          lots[0].qty -= take;
          left -= take;
          if (lots[0].qty <= 1e-9) lots.shift();
        }
      }
      if (next === 0) continue; // nothing bought yet
      const qty = lots.reduce((a, l) => a + l.qty, 0);
      if (qty <= 1e-9) {
        if (pts.length) pts.push({ date: d, value: 0, cost: 0 });
        if (next === own.length) break; // sold out for good
        continue;
      }
      const price = priceOn(d) ?? 0;
      const fx = fxOn(d) ?? 0;
      pts.push({ date: d, value: round2(qty * price * fx), cost: round2(lots.reduce((a, l) => a + l.qty * l.costPerShare, 0)) });
    }
    if (pts.length) byId[`stock:${key}`] = pts;
  }

  // Portfolio total: each holding's last known point on every chart date.
  const total = dates.map((d) => ({ date: d, value: 0, cost: 0 }));
  for (const pts of Object.values(byId)) {
    const at = new Map(pts.map((pt) => [pt.date, pt]));
    for (const t of total) {
      const pt = at.get(t.date);
      if (pt) {
        t.value += pt.value;
        t.cost += pt.cost;
      }
    }
  }
  // A redeemed bond's last point is the cash it paid; it is out of the portfolio after that.
  for (const t of total) {
    t.value = round2(t.value);
    t.cost = round2(t.cost);
  }
  return { total: total.filter((t) => t.value || t.cost), byId, notes: [...new Set(notes)] };
}
