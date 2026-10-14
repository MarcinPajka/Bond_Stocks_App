import { addDays, addMonths, monthBefore, type IsoDate } from "./bonds/dates.js";
import { PRODUCTS, valueBond } from "./bonds/bond.js";
import { termsFor, valueLot, type BondData, type BondLot, type BondLotValuation } from "./bonds/lot.js";
import type { Report } from "./portfolio.js";
import { BELKA_RATE, belkaTax, type AccountType } from "./tax.js";

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------- upcoming events

export interface UpcomingEvent {
  date: IsoDate;
  kind: "payout" | "reset" | "maturity";
  title: string;
  detail: string;
  amount?: number; // PLN, when it is already known
}

/** Bond payouts, rate resets and maturities in the next `days` days. */
export function upcomingEvents(bonds: BondLotValuation[], asOf: IsoDate, days = 120): UpcomingEvent[] {
  const until = addDays(asOf, days);
  const events: UpcomingEvent[] = [];
  for (const b of bonds) {
    if (b.valuation.matured) continue;
    const code = b.lot.series.toUpperCase();
    const product = PRODUCTS[code.slice(0, 3)];
    const current = b.valuation.currentPeriod;
    const q = b.lot.quantity;
    for (let i = current.index; i <= product.periods; i++) {
      const end = addMonths(b.lot.purchaseDate, i * product.periodMonths);
      if (end > until) break;
      if (end <= asOf) continue;
      const isCurrent = i === current.index;
      const isLast = i === product.periods;
      const periodInterest = (value: number) =>
        round2(value * (current.rate / 100) / (product.capitalised ? 1 : 12 / product.periodMonths));
      if (isLast) {
        const amount = isCurrent
          ? round2(q * (product.capitalised ? current.valueAtStart + periodInterest(current.valueAtStart) : 100 + periodInterest(100)))
          : undefined;
        events.push({ date: end, kind: "maturity", title: `${code} matures`, detail: `${q} bonds paid out`, amount });
      } else if (!product.capitalised) {
        events.push({
          date: end,
          kind: "payout",
          title: `${code} interest payout`,
          detail: isCurrent ? `${current.rate.toFixed(2)}% for this period` : "rate set at the start of the period",
          amount: isCurrent ? round2(q * periodInterest(100)) : undefined,
        });
        if (product.periodMonths === 1) break; // monthly bonds: only the next payout
      } else {
        const cpiMonth = new Date(`${monthBefore(end, 2)}-01`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
        const how = product.rate === "cpi" ? `next year's rate: ${cpiMonth} inflation + margin` : "same fixed rate";
        events.push({
          date: end,
          kind: "reset",
          title: `${code} year ${i} ends`,
          detail: `interest added to the bond, ${how}`,
          amount: isCurrent ? round2(q * periodInterest(current.valueAtStart)) : undefined,
        });
      }
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------- income by year

export interface YearIncome {
  year: number;
  bondInterest: number; // gross, paid out or redeemed at maturity
  bondTax: number; // Belka withheld on bond interest
  dividends: number; // gross
  dividendTax: number;
  realizedRegular: number; // net realised share gains on regular accounts (PIT-38)
  realizedTaxFree: number; // realised inside IKE/IKZE/OKI
  pit38Tax: number; // 19% of positive regular realised gains
  totalNet: number; // everything after tax
}

export function incomeByYear(report: Report): YearIncome[] {
  const years = new Map<number, YearIncome>();
  const y = (date: IsoDate) => {
    const year = Number(date.slice(0, 4));
    if (!years.has(year)) {
      years.set(year, {
        year, bondInterest: 0, bondTax: 0, dividends: 0, dividendTax: 0,
        realizedRegular: 0, realizedTaxFree: 0, pit38Tax: 0, totalNet: 0,
      });
    }
    return years.get(year)!;
  };

  for (const b of report.bonds) {
    for (const p of b.valuation.payouts) {
      const amount = round2(p.amount * b.lot.quantity);
      y(p.date).bondInterest += amount;
      y(p.date).bondTax += belkaTax(amount, b.lot.account);
    }
    if (b.valuation.matured && PRODUCTS[b.lot.series.slice(0, 3).toUpperCase()].capitalised) {
      const gain = round2(b.value - b.cost);
      y(b.valuation.asOf).bondInterest += gain;
      y(b.valuation.asOf).bondTax += belkaTax(gain, b.lot.account);
    }
  }
  for (const pos of report.positions) {
    for (const s of pos.sales) {
      if (pos.account === "regular") y(s.date).realizedRegular += s.gainPln;
      else y(s.date).realizedTaxFree += s.gainPln;
    }
    for (const d of pos.dividendList) {
      y(d.date).dividends += d.grossPln;
      y(d.date).dividendTax += d.taxPln;
    }
  }

  return [...years.values()]
    .map((r) => {
      const pit38Tax = Math.round(Math.max(0, r.realizedRegular) * BELKA_RATE);
      const rounded = {
        ...r,
        bondInterest: round2(r.bondInterest), bondTax: round2(r.bondTax),
        dividends: round2(r.dividends), dividendTax: round2(r.dividendTax),
        realizedRegular: round2(r.realizedRegular), realizedTaxFree: round2(r.realizedTaxFree), pit38Tax,
      };
      rounded.totalNet = round2(
        rounded.bondInterest - rounded.bondTax + rounded.dividends - rounded.dividendTax +
          rounded.realizedRegular - pit38Tax + rounded.realizedTaxFree,
      );
      return rounded;
    })
    .sort((a, b) => b.year - a.year);
}

// ---------------------------------------------------------------- IKE / IKZE limits

/** Yearly contribution limits (obwieszczenia MRPiPS). IKZE has a higher limit for the self-employed. */
export const LIMITS: Record<number, { IKE: number; IKZE: number; IKZEselfEmployed: number }> = {
  2024: { IKE: 23472, IKZE: 9388.8, IKZEselfEmployed: 14083.2 },
  2025: { IKE: 26019, IKZE: 10407.6, IKZEselfEmployed: 15611.4 },
  2026: { IKE: 28260, IKZE: 11304, IKZEselfEmployed: 16956 },
};

export interface Contribution {
  account: "IKE" | "IKZE";
  year: number;
  paidIn: number; // purchases made in the account this year, PLN
  limit?: number;
}

/**
 * Money put into IKE/IKZE this year, approximated by the purchases recorded there
 * (bond purchases and share/fund buys). Reinvested sale proceeds would count twice.
 */
export function contributions(report: Report, year: number, selfEmployed = false): Contribution[] {
  const sums: Record<"IKE" | "IKZE", number> = { IKE: 0, IKZE: 0 };
  const inYear = (d: IsoDate) => d.startsWith(String(year));
  for (const b of report.bonds) {
    if ((b.lot.account === "IKE" || b.lot.account === "IKZE") && inYear(b.lot.purchaseDate)) sums[b.lot.account] += b.cost;
  }
  for (const t of report.trades) {
    if ((t.account === "IKE" || t.account === "IKZE") && t.type === "buy" && inYear(t.date)) {
      sums[t.account] += (t.quantity * t.price + (t.commission ?? 0)) * (t.fxRate ?? 1);
    }
  }
  const limits = LIMITS[year];
  return (["IKE", "IKZE"] as const).map((account) => ({
    account,
    year,
    paidIn: round2(sums[account]),
    limit: limits ? (account === "IKZE" && selfEmployed ? limits.IKZEselfEmployed : limits[account]) : undefined,
  }));
}

// ---------------------------------------------------------------- bond projections

export interface Projection {
  series: string;
  account: AccountType;
  quantity: number;
  purchaseDate: IsoDate;
  maturity: IsoDate;
  cost: number;
  valueAtMaturity: number; // nominal + all interest, before tax
  gain: number;
  netGain: number; // after Belka
  points: { date: IsoDate; value: number }[]; // value incl. interest paid out so far
}

/**
 * Each bond held to maturity, with future inflation and NBP rate assumed constant
 * from the last known figures onwards.
 */
export function projectBonds(
  lots: BondLot[],
  data: BondData,
  asOf: IsoDate,
  assume: { inflation: number; nbpRate: number },
): Projection[] {
  const out: Projection[] = [];
  for (const lot of lots) {
    const code = lot.series.toUpperCase();
    const product = PRODUCTS[code.slice(0, 3)];
    if (!product) continue;
    const maturity = addMonths(lot.purchaseDate, product.periods * product.periodMonths);
    // Extend CPI with the assumption for every month after the last known one.
    const cpi = { ...data.cpi };
    const lastKnown = Object.keys(cpi).sort().at(-1) ?? monthBefore(asOf, 1);
    for (let m = addMonths(`${lastKnown}-01`, 1); m <= maturity; m = addMonths(m, 1)) {
      if (m.slice(0, 7) > lastKnown) cpi[m.slice(0, 7)] = assume.inflation;
    }
    const nbpReference = { ...data.nbpReference, [addDays(asOf, 1)]: assume.nbpRate };
    const extended: BondData = { ...data, cpi, nbpReference };

    let terms;
    try {
      terms = termsFor(lot, extended);
    } catch {
      continue;
    }
    const final = valueLot(lot, extended, maturity);
    const points: Projection["points"] = [];
    const step = product.periodMonths === 1 ? 3 : product.periodMonths; // quarterly points for monthly bonds
    for (let d = lot.purchaseDate; d < maturity; d = addMonths(d, step)) {
      const v = valueBond(code.slice(0, 3), lot.purchaseDate, terms, extended, d);
      const paid = v.payouts.reduce((a, p) => a + p.amount, 0);
      points.push({ date: d, value: round2(lot.quantity * (v.valuePerBond + paid)) });
    }
    points.push({ date: maturity, value: round2(final.value + final.interestPaid) });
    out.push({
      series: code,
      account: lot.account,
      quantity: lot.quantity,
      purchaseDate: lot.purchaseDate,
      maturity,
      cost: final.cost,
      valueAtMaturity: round2(final.value + final.interestPaid),
      gain: final.gain,
      netGain: final.netGain,
      points,
    });
  }
  return out;
}
