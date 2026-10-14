import type { IsoDate } from "../bonds/dates.js";
import type { Instrument } from "../stocks/positions.js";

/**
 * Live data, fetched on the machine running the app.
 *  - stooq.pl current quote CSV (still free; stooq's historical CSV needs an API key since 2026)
 *  - Yahoo Finance chart API as a fallback
 *  - analizy.pl fund pages for unit values of funds such as PKO DFE
 *  - NBP table A for exchange rates
 */

export type Fetcher = (url: string) => Promise<string>;

export const httpFetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (portfolio-tracker)" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
};

export interface RawQuote {
  price: number;
  date: IsoDate;
  source: string;
}

export function parseStooqQuote(csv: string): RawQuote | undefined {
  // Symbol,Date,Time,Open,High,Low,Close,Volume
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return undefined;
  const cols = lines[1].split(",");
  const close = Number(cols[6]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cols[1]) || !Number.isFinite(close)) return undefined;
  return { price: close, date: cols[1], source: "stooq" };
}

export function parseYahooChart(json: string): RawQuote | undefined {
  const meta = JSON.parse(json)?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return undefined;
  const date = new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);
  let price = meta.regularMarketPrice;
  if (meta.currency === "GBp") price /= 100; // London quotes in pence
  return { price, date, source: "yahoo" };
}

/** Unit value from an analizy.pl fund page ("28,28 PLN … Aktualna wartość J.U. … 12.10.2026"). */
export function parseAnalizyFundPage(html: string): RawQuote | undefined {
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const m = text.match(/(\d[\d ]*,\d+) PLN Aktualna wartość J\.U\. (\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return undefined;
  return { price: Number(m[1].replace(/ /g, "").replace(",", ".")), date: `${m[4]}-${m[3]}-${m[2]}`, source: "analizy.pl" };
}

export async function fetchQuote(inst: Instrument, get: Fetcher = httpFetch): Promise<RawQuote> {
  if (inst.analizy) {
    const q = parseAnalizyFundPage(await get(`https://www.analizy.pl/fundusz/${encodeURIComponent(inst.analizy)}`));
    if (!q) throw new Error(`No unit value found on analizy.pl for ${inst.analizy}`);
    return q;
  }
  const stooq = inst.stooq ?? inst.symbol.toLowerCase();
  const yahoo = inst.yahoo ?? `${inst.symbol.toUpperCase()}.WA`;
  const errors: string[] = [];
  try {
    const q = parseStooqQuote(await get(`https://stooq.pl/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&h&e=csv`));
    if (q) return q;
    errors.push("stooq: no data");
  } catch (e) {
    errors.push(`stooq: ${(e as Error).message}`);
  }
  try {
    const q = parseYahooChart(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?range=5d&interval=1d`));
    if (q) return q;
    errors.push("yahoo: no data");
  } catch (e) {
    errors.push(`yahoo: ${(e as Error).message}`);
  }
  throw new Error(`No price for ${inst.symbol} (${errors.join("; ")})`);
}

/** NBP mid rate (table A) from the last business day strictly before `date`, or the latest one. */
export function parseNbpRates(json: string, before?: IsoDate): number | undefined {
  const rates: { effectiveDate: string; mid: number }[] = JSON.parse(json).rates ?? [];
  const usable = before ? rates.filter((r) => r.effectiveDate < before) : rates;
  return usable.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)).at(-1)?.mid;
}

export async function fetchFxRate(currency: string, before?: IsoDate, get: Fetcher = httpFetch): Promise<number> {
  if (currency === "PLN") return 1;
  const code = currency.toLowerCase();
  let url = `https://api.nbp.pl/api/exchangerates/rates/a/${code}/?format=json`;
  if (before) {
    const end = new Date(Date.parse(before) - 86_400_000).toISOString().slice(0, 10);
    const start = new Date(Date.parse(before) - 14 * 86_400_000).toISOString().slice(0, 10);
    url = `https://api.nbp.pl/api/exchangerates/rates/a/${code}/${start}/${end}/?format=json`;
  }
  const rate = parseNbpRates(await get(url), before);
  if (!rate) throw new Error(`No NBP ${currency} rate${before ? ` before ${before}` : ""}`);
  return rate;
}
