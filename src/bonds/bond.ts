import {
  addMonths,
  businessDaysBefore,
  daysBetween,
  monthBefore,
  type IsoDate,
} from "./dates.js";

/**
 * Polish retail treasury bonds (obligacje oszczędnościowe), following their issue letters.
 *
 * Every product: 100 zł nominal, periods counted from the purchase day, interest rounded
 * to the grosz per bond, partial periods accrue on actual days / days in the period.
 *
 * Capitalised (EDO, ROS, ROD, TOS): interest is added to the value at each period end.
 *   Early redemption deducts a fee, but never below the 100 zł nominal.
 * Paid out (COI yearly, ROR/DOR monthly, OTS at maturity): interest is paid at each
 *   period end. Early redemption in period 1 deducts the fee capped at accrued interest;
 *   from period 2 the full fee is deducted.
 * IKE/IKZE payouts carry no early-redemption fee.
 */

export const NOMINAL = 100;

export type RateRule = "fixed" | "cpi" | "nbp";

export interface Product {
  periods: number;
  periodMonths: number;
  capitalised: boolean;
  rate: RateRule;
}

export const PRODUCTS: Record<string, Product> = {
  OTS: { periods: 1, periodMonths: 3, capitalised: false, rate: "fixed" },
  ROR: { periods: 12, periodMonths: 1, capitalised: false, rate: "nbp" },
  DOR: { periods: 24, periodMonths: 1, capitalised: false, rate: "nbp" },
  TOS: { periods: 3, periodMonths: 12, capitalised: true, rate: "fixed" },
  COI: { periods: 4, periodMonths: 12, capitalised: false, rate: "cpi" },
  ROS: { periods: 6, periodMonths: 12, capitalised: true, rate: "cpi" },
  EDO: { periods: 10, periodMonths: 12, capitalised: true, rate: "cpi" },
  ROD: { periods: 12, periodMonths: 12, capitalised: true, rate: "cpi" },
};

export interface SeriesTerms {
  firstYearRate: number; // percent; the rate for the whole bond when the rule is "fixed"
  margin: number; // percent
  earlyFee: number; // zł per bond
}

export interface MarketData {
  cpi: Record<string, number>; // "YYYY-MM" -> y/y percent
  nbpReference: Record<IsoDate, number>; // effective date -> percent
}

export interface Period {
  index: number; // 1-based
  start: IsoDate;
  end: IsoDate;
  rate: number; // percent per year
  basis?: string; // where a variable rate came from
  valueAtStart: number; // per bond
}

export interface BondValuation {
  asOf: IsoDate;
  matured: boolean;
  currentPeriod: Period;
  periods: Period[]; // periods started up to asOf
  /** Value if held: capitalised value, or nominal plus accrued interest. Per bond. */
  valuePerBond: number;
  /** Interest already paid out, one entry per payout. Per bond. */
  payouts: { date: IsoDate; amount: number }[];
  /** Cash received on early redemption today. Per bond. */
  redemptionValuePerBond: number;
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function nbpRateOn(date: IsoDate, table: Record<IsoDate, number>): number {
  const effective = Object.keys(table).filter((d) => d <= date).sort();
  if (effective.length === 0) throw new Error(`No NBP reference rate known for ${date}`);
  return table[effective[effective.length - 1]];
}

function periodRate(
  product: Product,
  index: number,
  start: IsoDate,
  terms: SeriesTerms,
  market: MarketData,
): Pick<Period, "rate" | "basis"> {
  if (index === 1 || product.rate === "fixed") return { rate: terms.firstYearRate };
  if (product.rate === "cpi") {
    // CPI announced by GUS in the month before the period starts = figure for two months back
    const month = monthBefore(start, 2);
    const cpi = market.cpi[month];
    if (cpi !== undefined) {
      return { rate: round2(Math.max(cpi, 0) + terms.margin), basis: `CPI ${month} ${cpi}% + ${terms.margin}%` };
    }
    // Not in the data yet: estimate with the latest month known before it.
    const latest = Object.keys(market.cpi).filter((m) => m < month).sort().at(-1);
    if (!latest) throw new Error(`Missing CPI for ${month}, needed for the period starting ${start}`);
    const est = market.cpi[latest];
    return {
      rate: round2(Math.max(est, 0) + terms.margin),
      basis: `estimated: CPI ${month} not in data, used ${latest} ${est}% + ${terms.margin}%`,
    };
  }
  // NBP reference rate in force on the 10th business day before the 1st of the period's month
  const fixingDate = businessDaysBefore(start.slice(0, 8) + "01", 10);
  const ref = nbpRateOn(fixingDate, market.nbpReference);
  return { rate: round2(Math.max(ref, 0) + terms.margin), basis: `NBP ref ${ref}% on ${fixingDate} + ${terms.margin}%` };
}

export function valueBond(
  productCode: string,
  purchaseDate: IsoDate,
  terms: SeriesTerms,
  market: MarketData,
  asOf: IsoDate,
  feeExempt = false,
): BondValuation {
  const product = PRODUCTS[productCode];
  if (!product) throw new Error(`Unknown bond product ${productCode}`);
  if (daysBetween(purchaseDate, asOf) < 0) throw new Error("Valuation date is before purchase");

  const maturity = addMonths(purchaseDate, product.periods * product.periodMonths);
  const matured = daysBetween(asOf, maturity) <= 0;
  const valueDate = matured ? maturity : asOf;
  const periodsPerYear = 12 / product.periodMonths;

  const periods: Period[] = [];
  const payouts: BondValuation["payouts"] = [];
  let value = NOMINAL;
  for (let i = 1; i <= product.periods; i++) {
    const start = addMonths(purchaseDate, (i - 1) * product.periodMonths);
    const end = addMonths(purchaseDate, i * product.periodMonths);
    const period: Period = { index: i, start, end, valueAtStart: value, ...periodRate(product, i, start, terms, market) };
    periods.push(period);
    const completed = daysBetween(end, valueDate) >= 0;
    if (!completed) break;
    const interest = round2(value * (period.rate / 100 / (product.capitalised ? 1 : periodsPerYear)));
    if (product.capitalised) value = round2(value + interest);
    else payouts.push({ date: end, amount: interest });
    if (i === product.periods) break;
  }

  const current = periods[periods.length - 1];
  if (matured) {
    return { asOf: valueDate, matured, currentPeriod: current, periods, valuePerBond: value, payouts, redemptionValuePerBond: value };
  }

  const elapsed = daysBetween(current.start, valueDate);
  const length = daysBetween(current.start, current.end);
  const accrued = round2(value * (current.rate / 100) * (elapsed / length) / (product.capitalised ? 1 : periodsPerYear));
  const valuePerBond = round2(value + accrued);

  let redemptionValuePerBond: number;
  const fee = feeExempt ? 0 : terms.earlyFee;
  if (productCode === "OTS") {
    redemptionValuePerBond = NOMINAL; // early redemption returns the nominal only, no interest
  } else if (product.capitalised) {
    redemptionValuePerBond = Math.max(NOMINAL, round2(valuePerBond - fee));
  } else if (current.index === 1) {
    redemptionValuePerBond = round2(valuePerBond - Math.min(fee, accrued));
  } else {
    redemptionValuePerBond = round2(valuePerBond - fee);
  }

  return { asOf: valueDate, matured, currentPeriod: current, periods, valuePerBond, payouts, redemptionValuePerBond };
}
