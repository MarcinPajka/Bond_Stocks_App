import { addYears, daysBetween, monthBefore, type IsoDate } from "./dates.js";

/**
 * Capitalised, inflation-indexed retail treasury bonds (EDO, and later ROS/ROD).
 * Rules from the EDO issue letter (list emisyjny):
 *  - first yearly period: fixed rate; later periods: CPI y/y + margin, CPI < 0 counts as 0
 *  - the CPI used is the one GUS announces in the month before the period starts,
 *    i.e. the y/y figure for two months before the period's first month
 *  - each period starts on the purchase-day anniversary; interest is capitalised yearly
 *  - mid-period interest accrues on actual days / actual days in the period
 *  - early redemption deducts a fee per bond, but never below the 100 zł nominal
 */

export const NOMINAL = 100;

export interface SeriesTerms {
  firstYearRate: number; // percent
  margin: number; // percent
  earlyFee: number; // zł per bond
  years: number;
}

export type CpiTable = Record<string, number>; // "YYYY-MM" -> y/y percent

export interface Period {
  index: number; // 1-based
  start: IsoDate;
  end: IsoDate;
  rate: number; // percent
  cpiMonth?: string;
  cpi?: number;
  valueAtStart: number; // per bond, zł
}

export interface BondValuation {
  asOf: IsoDate;
  matured: boolean;
  periods: Period[]; // periods started up to asOf
  currentPeriod: Period;
  valuePerBond: number; // value if held, before tax
  redemptionValuePerBond: number; // after early-redemption fee
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function periodRate(
  index: number,
  start: IsoDate,
  terms: SeriesTerms,
  cpi: CpiTable,
): Pick<Period, "rate" | "cpiMonth" | "cpi"> {
  if (index === 1) return { rate: terms.firstYearRate };
  const cpiMonth = monthBefore(start, 2);
  const value = cpi[cpiMonth];
  if (value === undefined) {
    throw new Error(`Missing CPI for ${cpiMonth}, needed for the period starting ${start}`);
  }
  return { rate: Math.max(value, 0) + terms.margin, cpiMonth, cpi: value };
}

export function valueBond(
  purchaseDate: IsoDate,
  terms: SeriesTerms,
  cpi: CpiTable,
  asOf: IsoDate,
): BondValuation {
  if (daysBetween(purchaseDate, asOf) < 0) throw new Error("Valuation date is before purchase");
  const maturity = addYears(purchaseDate, terms.years);
  const valueDate = daysBetween(asOf, maturity) <= 0 ? maturity : asOf;

  const periods: Period[] = [];
  let value = NOMINAL;
  for (let i = 1; i <= terms.years; i++) {
    const start = addYears(purchaseDate, i - 1);
    const end = addYears(purchaseDate, i);
    const period: Period = { index: i, start, end, valueAtStart: value, ...periodRate(i, start, terms, cpi) };
    periods.push(period);
    if (daysBetween(end, valueDate) < 0 || i === terms.years) break;
    value = round2(value * (1 + period.rate / 100));
  }

  const current = periods[periods.length - 1];
  const matured = valueDate === maturity;
  let valuePerBond: number;
  if (matured) {
    valuePerBond = round2(current.valueAtStart * (1 + current.rate / 100));
  } else {
    const elapsed = daysBetween(current.start, valueDate);
    const length = daysBetween(current.start, current.end);
    valuePerBond = round2(current.valueAtStart * (1 + (current.rate / 100) * (elapsed / length)));
  }
  const redemptionValuePerBond = matured
    ? valuePerBond
    : Math.max(NOMINAL, round2(valuePerBond - terms.earlyFee));

  return { asOf: valueDate, matured, periods, currentPeriod: current, valuePerBond, redemptionValuePerBond };
}
