import { readFileSync } from "node:fs";
import { belkaTax, type AccountType } from "../tax.js";
import { today, type IsoDate } from "./dates.js";
import { PRODUCTS, valueBond, type BondValuation, type MarketData, type SeriesTerms } from "./bond.js";

export interface BondLot {
  series: string; // e.g. "EDO1035"
  purchaseDate: IsoDate;
  quantity: number;
  pricePerBond?: number; // 100, or 99.90 when bought by exchange (zamiana)
  account: AccountType;
  terms?: SeriesTerms; // only needed when the series is not in data/bond-series.json
}

export interface BondLotValuation {
  lot: BondLot;
  valuation: BondValuation;
  cost: number;
  value: number; // current value if held
  interestPaid: number; // gross interest already paid out
  gain: number; // value + interestPaid - cost
  tax: number; // Belka on payouts so far plus on the rest if redeemed at full value
  netGain: number;
  redemptionValue: number; // cash if redeemed early today, before tax
  redemptionNetGain: number;
}

export interface BondData extends MarketData {
  series: Record<string, SeriesTerms>;
}

export function loadBondData(dataDir = new URL("../../data/", import.meta.url)): BondData {
  const read = (f: string) => JSON.parse(readFileSync(new URL(f, dataDir), "utf8"));
  return {
    cpi: read("cpi.json").yoyPercent,
    nbpReference: read("nbp-reference-rate.json").changes,
    series: read("bond-series.json").series,
  };
}

export function termsFor(lot: BondLot, data: BondData): SeriesTerms {
  const terms = lot.terms ?? data.series[lot.series.toUpperCase()];
  if (!terms) {
    throw new Error(
      `Unknown series ${lot.series}: add "terms" (firstYearRate, margin, earlyFee) to the holding or to data/bond-series.json`,
    );
  }
  return terms;
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function valueLot(lot: BondLot, data: BondData, asOf: IsoDate = today()): BondLotValuation {
  const product = lot.series.slice(0, 3).toUpperCase();
  if (!PRODUCTS[product]) throw new Error(`${product} bonds are not supported`);
  const feeExempt = lot.account === "IKE" || lot.account === "IKZE";
  const valuation = valueBond(product, lot.purchaseDate, termsFor(lot, data), data, asOf, feeExempt);

  const q = lot.quantity;
  const cost = round2(q * (lot.pricePerBond ?? 100));
  const value = round2(q * valuation.valuePerBond);
  const redemptionValue = round2(q * valuation.redemptionValuePerBond);
  // Belka is withheld on each interest payout, then on the redemption gain.
  const payoutAmounts = valuation.payouts.map((p) => round2(q * p.amount));
  const interestPaid = round2(payoutAmounts.reduce((a, b) => a + b, 0));
  const payoutTax = payoutAmounts.reduce((a, p) => a + belkaTax(p, lot.account), 0);

  const gain = round2(value + interestPaid - cost);
  const tax = payoutTax + belkaTax(round2(value - cost), lot.account);
  const redemptionTax = payoutTax + belkaTax(round2(redemptionValue - cost), lot.account);
  return {
    lot,
    valuation,
    cost,
    value,
    interestPaid,
    gain,
    tax,
    netGain: round2(gain - tax),
    redemptionValue,
    redemptionNetGain: round2(redemptionValue + interestPaid - cost - redemptionTax),
  };
}
