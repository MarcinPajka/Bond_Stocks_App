import { belkaTax, type AccountType } from "../tax.js";
import { today, type IsoDate } from "./dates.js";
import { PRODUCTS, valueBond, type BondValuation, type MarketData, type SeriesTerms } from "./bond.js";

export interface BondLot {
  series: string; // e.g. "EDO1035"
  purchaseDate: IsoDate;
  quantity: number;
  pricePerBond?: number; // 100, or 99.90 when bought by exchange (zamiana)
  account: AccountType;
  terms?: SeriesTerms; // only needed when its terms can't be fetched from obligacjeskarbowe.pl
  redeemedOn?: IsoDate; // sold back early (przedterminowy wykup); the whole lot, split it first for part
}

export interface BondLotValuation {
  lot: BondLot;
  valuation: BondValuation;
  cost: number;
  value: number; // current value if held; 0 once redeemed
  interestPaid: number; // gross interest already paid out
  gain: number; // value + interestPaid - cost
  tax: number; // Belka on payouts so far plus on the rest if redeemed at full value
  netGain: number;
  redemptionValue: number; // cash if redeemed early today, before tax
  redemptionNetGain: number;
  redeemed?: { date: IsoDate; proceeds: number }; // cash received on early redemption, before tax
}

export interface BondData extends MarketData {
  series: Record<string, SeriesTerms>;
}

export const emptyBondData = (): BondData => ({ series: {}, cpi: {}, nbpReference: {} });

export function termsFor(lot: BondLot, data: BondData): SeriesTerms {
  const terms = lot.terms ?? data.series[lot.series.toUpperCase()];
  if (!terms) {
    throw new Error(
      `No terms known for ${lot.series.toUpperCase()}. Check the series code, or enter its first-year rate, margin and fee under "Override series terms".`,
    );
  }
  return terms;
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function valueLot(lot: BondLot, data: BondData, asOf: IsoDate = today()): BondLotValuation {
  const product = lot.series.slice(0, 3).toUpperCase();
  if (!PRODUCTS[product]) throw new Error(`${product} bonds are not supported`);
  const feeExempt = lot.account === "IKE" || lot.account === "IKZE";
  const redeemed = lot.redeemedOn !== undefined && lot.redeemedOn <= asOf;
  if (redeemed && lot.redeemedOn! < lot.purchaseDate) throw new Error(`redeemed ${lot.redeemedOn}, before it was bought`);
  const valuation = valueBond(product, lot.purchaseDate, termsFor(lot, data), data, redeemed ? lot.redeemedOn! : asOf, feeExempt);
  if (redeemed && valuation.matured) throw new Error(`can't be redeemed on ${lot.redeemedOn}, it matured on ${valuation.asOf}`);

  const q = lot.quantity;
  const cost = round2(q * (lot.pricePerBond ?? 100));
  const value = round2(q * valuation.valuePerBond);
  const redemptionValue = round2(q * valuation.redemptionValuePerBond);
  // Belka is withheld on each interest payout, then on the redemption gain.
  const payoutAmounts = valuation.payouts.map((p) => round2(q * p.amount));
  const interestPaid = round2(payoutAmounts.reduce((a, b) => a + b, 0));
  const payoutTax = payoutAmounts.reduce((a, p) => a + belkaTax(p, lot.account), 0);

  if (redeemed) {
    const proceeds = redemptionValue;
    const gain = round2(proceeds + interestPaid - cost);
    const tax = payoutTax + belkaTax(round2(proceeds - cost), lot.account);
    const netGain = round2(gain - tax);
    return {
      lot, valuation, cost, value: 0, interestPaid, gain, tax, netGain,
      redemptionValue: 0, redemptionNetGain: netGain, redeemed: { date: lot.redeemedOn!, proceeds },
    };
  }

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
