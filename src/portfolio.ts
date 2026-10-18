import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { today, type IsoDate } from "./bonds/dates.js";
import { emptyBondData, valueLot, type BondData, type BondLot, type BondLotValuation } from "./bonds/lot.js";
import { cacheData, loadCache, refreshBondData } from "./bonds/refresh.js";
import { fetchFxRate, fetchQuote } from "./prices/providers.js";
import { buildPositions, type Dividend, type Instrument, type Position, type Quote, type Trade } from "./stocks/positions.js";

export interface PortfolioFile {
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
  const currencyOf = (s: string) => instruments.find((i) => i.symbol === s)?.currency ?? "PLN";

  // Fill in NBP rates for foreign trades and dividends that don't carry one.
  const withFx = async <T extends { symbol: string; date: IsoDate; fxRate?: number }>(rows: T[]): Promise<T[]> =>
    Promise.all(
      rows.map(async (r) => {
        const cur = currencyOf(r.symbol);
        if (cur === "PLN" || r.fxRate || opts.offline) return r;
        return { ...r, fxRate: await fetchFxRate(cur, r.date) };
      }),
    );
  const trades = await withFx(p.trades ?? []);
  const dividends = await withFx(p.dividends ?? []);

  const quotes: Record<string, Quote | undefined> = {};
  for (const inst of instruments) {
    const manual = p.prices?.[inst.symbol];
    try {
      if (opts.offline) throw new Error("offline");
      const q = await fetchQuote(inst);
      quotes[inst.symbol] = { price: q.price, date: q.date, fxRate: await fetchFxRate(inst.currency) };
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
