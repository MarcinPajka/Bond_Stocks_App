import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { today, type IsoDate } from "./bonds/dates.js";
import { emptyBondData, valueLot, type BondData, type BondLot, type BondLotValuation } from "./bonds/lot.js";
import { cacheData, loadCache, refreshBondData } from "./bonds/refresh.js";
import { fetchFxRate, fetchQuote, yahooSymbol, type Fetcher } from "./prices/providers.js";
import { buildPositions, type Dividend, type Instrument, type Position, type Quote, type Trade } from "./stocks/positions.js";

export interface PortfolioFile {
  version?: number; // file format, see storage.ts
  bonds?: BondLot[];
  instruments?: Instrument[];
  trades?: Trade[];
  dividends?: Dividend[];
  /** Manual prices, used offline or when no live price is found. */
  prices?: Record<string, { price: number; date: IsoDate; fxRate?: number }>;
  settings?: { ikzeSelfEmployed?: boolean };
}

export interface Report {
  asOf: IsoDate;
  bonds: BondLotValuation[];
  positions: Position[];
  trades: Trade[]; // with exchange rates filled in
  bondData: BondData; // fetched terms, CPI and NBP rates used for the valuation
  warnings: string[];
}

export function loadPortfolio(path: string): PortfolioFile {
  return JSON.parse(readFileSync(path, "utf8"));
}

const hasSource = (i: Instrument) => Boolean(i.stooq || i.yahoo || i.analizy);

/**
 * Fills in the exchange rate on foreign-currency trades and dividends saved without one:
 * the NBP table A rate from the business day before, which is what Belka is computed with.
 */
export async function withFxRates(p: PortfolioFile, get?: Fetcher): Promise<PortfolioFile> {
  const currencyOf = (s: string) => p.instruments?.find((i) => i.symbol === s)?.currency ?? "PLN";
  const fill = <T extends { symbol: string; date: IsoDate; fxRate?: number }>(rows: T[] | undefined, what: string) =>
    rows &&
    Promise.all(
      rows.map(async (r) => {
        const cur = currencyOf(r.symbol);
        if (cur === "PLN" || r.fxRate) return r;
        try {
          return { ...r, fxRate: await fetchFxRate(cur, r.date, get) };
        } catch (e) {
          throw new Error(`${r.symbol} ${what} on ${r.date}: couldn't look up the NBP ${cur} rate (${(e as Error).message}). Enter the exchange rate.`);
        }
      }),
    );
  const filled = { ...p };
  if (p.trades) filled.trades = await fill(p.trades, "trade");
  if (p.dividends) filled.dividends = await fill(p.dividends, "dividend");
  return filled;
}

/**
 * Instruments saved without saying where their price comes from get it from the app's
 * instrument list (the sample portfolio's instruments), e.g. PKODFE is the analizy.pl fund
 * EBAN2. Only fills gaps: anything set on your own instrument wins. The file isn't changed.
 */
export function withKnownSources(p: PortfolioFile, known: Instrument[] = knownInstruments()): PortfolioFile {
  if (!p.instruments?.some((i) => !hasSource(i))) return p;
  const bySymbol = new Map(known.filter(hasSource).map((k) => [k.symbol.toUpperCase(), k]));
  const instruments = p.instruments.map((i) => {
    const k = hasSource(i) ? undefined : bySymbol.get(i.symbol.toUpperCase());
    return k ? { ...i, stooq: k.stooq, yahoo: k.yahoo, analizy: k.analizy, currency: i.currency ?? k.currency, name: i.name ?? k.name } : i;
  });
  return { ...p, instruments };
}

export function knownInstruments(): Instrument[] {
  try {
    return JSON.parse(readFileSync(new URL("../portfolio.example.json", import.meta.url), "utf8")).instruments ?? [];
  } catch {
    return [];
  }
}

/** Where fetched bond terms, CPI and NBP rates are kept: next to the portfolio file. */
export const cachePathFor = (portfolioPath: string) => join(dirname(portfolioPath), "market-data.cache.json");

export interface ReportOptions {
  offline?: boolean;
  asOf?: IsoDate;
  cachePath?: string;
  skipPrices?: boolean;
  /** Throw on any bond that can't be valued, instead of reporting it as a warning. */
  strict?: boolean;
  /** Use these terms, CPI and NBP rates instead of fetching (tests). */
  marketData?: BondData;
}

export async function buildReport(p: PortfolioFile, opts: ReportOptions = {}): Promise<Report> {
  const asOf = opts.asOf ?? today();
  const warnings: string[] = [];

  const lots = p.bonds ?? [];
  let bondData = opts.marketData ?? (opts.cachePath ? cacheData(loadCache(opts.cachePath)) : emptyBondData());
  if (!opts.offline && !opts.marketData) {
    const needed = lots.filter((l) => !l.terms).map((l) => l.series);
    const refreshed = await refreshBondData(opts.cachePath, needed);
    bondData = refreshed.data;
    warnings.push(...refreshed.warnings);
  }
  const bonds: BondLotValuation[] = [];
  for (const lot of lots) {
    try {
      const v = valueLot(lot, bondData, asOf);
      if (v.valuation.currentPeriod.basis?.startsWith("estimated")) {
        warnings.push(`${lot.series}: rate ${v.valuation.currentPeriod.basis}`);
      }
      bonds.push(v);
    } catch (e) {
      if (opts.strict) {
        const related = warnings.filter((w) => w.startsWith(lot.series.toUpperCase()));
        throw new Error(related[0] ?? (e as Error).message);
      }
      warnings.push(`${lot.series} bought ${lot.purchaseDate}: ${(e as Error).message}`);
    }
  }
  if (opts.skipPrices) return { asOf, bonds, positions: [], trades: [], bondData, warnings };

  const instruments = p.instruments ?? [];
  const withFx = opts.offline ? p : await withFxRates(p);
  const trades = withFx.trades ?? [];
  const dividends = withFx.dividends ?? [];

  const quotes: Record<string, Quote | undefined> = {};
  // Only instruments you trade: one left behind after renaming a symbol shouldn't raise warnings.
  const used = new Set([...trades, ...dividends].map((t) => t.symbol));
  for (const inst of instruments.filter((i) => used.has(i.symbol))) {
    const manual = p.prices?.[inst.symbol];
    try {
      if (opts.offline) throw new Error("offline");
      const q = await fetchQuote(inst);
      const currency = q.currency ?? inst.currency;
      if (!q.currency && !yahooSymbol(inst).toUpperCase().endsWith(".WA")) {
        warnings.push(`${inst.symbol}: Yahoo had no price, and stooq's doesn't say its currency, so ${currency} was assumed. Check its Yahoo symbol under "Price source".`);
      }
      quotes[inst.symbol] = { price: q.price, date: q.date, currency, fxRate: await fetchFxRate(currency) };
    } catch (e) {
      if (manual) {
        const fxRate = inst.currency === "PLN" ? 1 : manual.fxRate;
        if (fxRate) quotes[inst.symbol] = { price: manual.price, date: manual.date, fxRate };
        else warnings.push(`${inst.symbol}: manual price needs fxRate`);
        if (!opts.offline) warnings.push(`${inst.symbol}: using manual price (${(e as Error).message})`);
      } else {
        warnings.push(opts.offline ? `${inst.symbol}: no manual price set (offline mode)` : `${inst.symbol}: ${(e as Error).message}`);
      }
    }
  }

  return { asOf, bonds, positions: buildPositions(instruments, trades, dividends, quotes), trades, bondData, warnings };
}
