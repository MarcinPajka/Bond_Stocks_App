import { readFileSync } from "node:fs";
import { belkaTax, type AccountType } from "../tax.js";
import { today, type IsoDate } from "./dates.js";
import { valueBond, type BondValuation, type CpiTable, type SeriesTerms } from "./inflationIndexed.js";

export interface BondLot {
  series: string; // e.g. "EDO1035"
  purchaseDate: IsoDate;
  quantity: number;
  pricePerBond?: number; // 100, or 99.90 when bought by exchange (zamiana)
  account: AccountType;
}

export interface BondLotValuation {
  lot: BondLot;
  valuation: BondValuation;
  cost: number;
  value: number;
  gain: number;
  tax: number;
  netGain: number;
  redemptionValue: number; // if redeemed early today, before tax
  redemptionNetGain: number;
}

const PRODUCT_YEARS: Record<string, number> = { EDO: 10 };

export interface BondData {
  cpi: CpiTable;
  series: Record<string, Omit<SeriesTerms, "years">>;
}

export function loadBondData(dataDir = new URL("../../data/", import.meta.url)): BondData {
  const cpi = JSON.parse(readFileSync(new URL("cpi.json", dataDir), "utf8")).yoyPercent;
  const series = JSON.parse(readFileSync(new URL("bond-series.json", dataDir), "utf8")).series;
  return { cpi, series };
}

export function termsFor(series: string, data: BondData): SeriesTerms {
  const product = series.slice(0, 3).toUpperCase();
  const years = PRODUCT_YEARS[product];
  if (!years) throw new Error(`${product} bonds are not supported yet`);
  const terms = data.series[series.toUpperCase()];
  if (!terms) throw new Error(`Unknown series ${series}: add its first-year rate, margin and fee to data/bond-series.json`);
  return { ...terms, years };
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function valueLot(lot: BondLot, data: BondData, asOf: IsoDate = today()): BondLotValuation {
  const valuation = valueBond(lot.purchaseDate, termsFor(lot.series, data), data.cpi, asOf);
  const cost = round2(lot.quantity * (lot.pricePerBond ?? 100));
  const value = round2(lot.quantity * valuation.valuePerBond);
  const redemptionValue = round2(lot.quantity * valuation.redemptionValuePerBond);
  const gain = round2(value - cost);
  const tax = belkaTax(gain, lot.account);
  const redemptionGain = round2(redemptionValue - cost);
  return {
    lot,
    valuation,
    cost,
    value,
    gain,
    tax,
    netGain: round2(gain - tax),
    redemptionValue,
    redemptionNetGain: round2(redemptionGain - belkaTax(redemptionGain, lot.account)),
  };
}
