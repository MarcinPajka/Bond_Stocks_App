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
  currency?: string; // currency of the price, when the source says (stooq's quote CSV doesn't)
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

/** Yahoo's currency code; London quotes in pence (GBp) are converted to pounds. */
export const yahooCurrency = (c: unknown) => (typeof c === "string" && c ? (c === "GBp" ? "GBP" : c.toUpperCase()) : undefined);

/**
 * Yahoo symbol of an instrument: set explicitly, else derived from its stooq symbol
 * ("vwce.de" -> "VWCE.DE", "aapl.us" -> "AAPL", "hsba.uk" -> "HSBA.L"), else a GPW share (SYMBOL.WA).
 */
export function yahooSymbol(inst: Instrument): string {
  if (inst.yahoo) return inst.yahoo;
  const m = inst.stooq?.match(/^(.+)\.([a-z]+)$/i);
  if (m) {
    const suffix: Record<string, string> = { us: "", uk: ".L", jp: ".T" };
    const ext = m[2].toLowerCase();
    return `${m[1].toUpperCase()}${ext in suffix ? suffix[ext] : `.${ext.toUpperCase()}`}`;
  }
  return `${inst.symbol.toUpperCase()}.WA`;
}

export function parseYahooChart(json: string): RawQuote | undefined {
  const meta = JSON.parse(json)?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return undefined;
  const date = new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);
  let price = meta.regularMarketPrice;
  if (meta.currency === "GBp") price /= 100; // London quotes in pence
  return { price, date, source: "yahoo", currency: yahooCurrency(meta.currency) };
}

/** Unit value from an analizy.pl fund page ("28,28 PLN … Aktualna wartość J.U. … 12.10.2026"). */
export function parseAnalizyFundPage(html: string): RawQuote | undefined {
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const m = text.match(/(\d[\d ]*,\d+) PLN Aktualna wartość J\.U\. (\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return undefined;
  return { price: Number(m[1].replace(/ /g, "").replace(",", ".")), date: `${m[4]}-${m[3]}-${m[2]}`, source: "analizy.pl", currency: "PLN" };
}

/** The fund id from an analizy.pl id or a pasted fund page link (…/fundusz/EBAN2/pko-…). */
export function analizyId(value: string): string {
  const m = value.match(/fundusz\/([A-Za-z0-9]+)/);
  return (m ? m[1] : value.trim()).toUpperCase();
}

export async function fetchQuote(inst: Instrument, get: Fetcher = httpFetch): Promise<RawQuote> {
  if (inst.analizy) {
    const id = analizyId(inst.analizy);
    const q = parseAnalizyFundPage(await get(`https://www.analizy.pl/fundusz/${encodeURIComponent(id)}`));
    if (!q) throw new Error(`No unit value found on analizy.pl for ${id}`);
    return q;
  }
  const stooq = inst.stooq ?? inst.symbol.toLowerCase();
  const yahoo = yahooSymbol(inst);
  const errors: string[] = [];
  const tryStooq = async () => {
    try {
      const q = parseStooqQuote(await get(`https://stooq.pl/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&h&e=csv`));
      if (q) return q;
      errors.push("stooq: no data");
    } catch (e) {
      errors.push(`stooq: ${(e as Error).message}`);
    }
  };
  const tryYahoo = async () => {
    try {
      const q = parseYahooChart(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?range=5d&interval=1d`));
      if (q) return q;
      errors.push("yahoo: no data");
    } catch (e) {
      errors.push(`yahoo: ${(e as Error).message}`);
    }
  };
  // Outside the Warsaw exchange the price's currency matters, and only Yahoo says what it is.
  const foreign = !yahoo.toUpperCase().endsWith(".WA");
  const q = foreign ? ((await tryYahoo()) ?? (await tryStooq())) : ((await tryStooq()) ?? (await tryYahoo()));
  if (q) return q;
  throw new Error(
    `No price for ${inst.symbol}: it isn't listed on stooq or Yahoo under ${stooq} / ${yahoo}. ` +
      `If it's a fund, give it its analizy.pl id; for shares or ETFs, its stooq or Yahoo symbol. ` +
      `Open it under Holdings and press "Price source". (${errors.join("; ")})`,
  );
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
