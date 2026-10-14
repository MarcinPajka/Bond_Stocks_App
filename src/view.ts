import type { AccountType } from "./tax.js";
import type { Report } from "./portfolio.js";

/** Flat rows for the dashboard: one per bond lot or share position, all amounts in PLN. */
export interface Row {
  kind: "bond" | "stock";
  name: string;
  detail: string;
  account: AccountType;
  quantity: number;
  cost: number;
  value: number | null;
  income: number | null; // gross: interest/dividends + price gains, realised and unrealised
  netIncome: number | null; // after Belka
  ifSoldNow?: number; // bonds: net gain after early-redemption fee and Belka
  breakdown: Record<string, number>;
}

export function toRows(report: Report, names: Record<string, string | undefined> = {}): Row[] {
  const rows: Row[] = [];
  for (const b of report.bonds) {
    const p = b.valuation.currentPeriod;
    rows.push({
      kind: "bond",
      name: b.lot.series.toUpperCase(),
      detail: b.valuation.matured
        ? `matured ${b.valuation.asOf}`
        : `bought ${b.lot.purchaseDate} · year ${p.index}: ${p.rate.toFixed(2)}%${p.basis ? ` (${p.basis})` : ""}`,
      account: b.lot.account,
      quantity: b.lot.quantity,
      cost: b.cost,
      value: b.value,
      income: b.gain,
      netIncome: b.netGain,
      ifSoldNow: b.redemptionNetGain,
      breakdown: { "Interest paid out": b.interestPaid, "Accrued in value": Math.round((b.value - b.cost) * 100) / 100, "Belka": b.tax },
    });
  }
  for (const s of report.positions) {
    rows.push({
      kind: "stock",
      name: s.symbol,
      detail: [names[s.symbol], s.price !== undefined ? `${s.price} on ${s.priceDate}` : "no price"].filter(Boolean).join(" · "),
      account: s.account,
      quantity: +s.quantity.toFixed(4),
      cost: s.costPln,
      value: s.valuePln ?? null,
      income: s.gainPln ?? null,
      netIncome: s.netGainPln ?? null,
      breakdown: {
        "Unrealised": s.unrealizedPln ?? 0,
        "Realised": s.realizedPln,
        "Dividends (gross)": s.dividendsGrossPln,
        "Dividend tax": s.dividendsTaxPln,
      },
    });
  }
  return rows;
}
