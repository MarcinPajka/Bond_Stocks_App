import { readFileSync } from "node:fs";
import { today, type IsoDate } from "./bonds/dates.js";
import { loadBondData, valueLot, type BondLot, type BondLotValuation } from "./bonds/lot.js";
import { fetchFxRate, fetchQuote } from "./prices/providers.js";
import { buildPositions, type Dividend, type Instrument, type Position, type Quote, type Trade } from "./stocks/positions.js";

export interface PortfolioFile {
  bonds?: BondLot[];
  instruments?: Instrument[];
  trades?: Trade[];
  dividends?: Dividend[];
  /** Manual prices, used offline or when no live price is found. */
  prices?: Record<string, { price: number; date: IsoDate; fxRate?: number }>;
}

export interface Report {
  asOf: IsoDate;
  bonds: BondLotValuation[];
  positions: Position[];
  warnings: string[];
}

export function loadPortfolio(path: string): PortfolioFile {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function buildReport(p: PortfolioFile, opts: { offline?: boolean; asOf?: IsoDate } = {}): Promise<Report> {
  const asOf = opts.asOf ?? today();
  const warnings: string[] = [];
  const bondData = loadBondData();
  const bonds = (p.bonds ?? []).map((lot) => valueLot(lot, bondData, asOf));

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
        warnings.push(`${inst.symbol}: ${(e as Error).message}`);
      }
    }
  }

  return { asOf, bonds, positions: buildPositions(instruments, trades, dividends, quotes), warnings };
}
