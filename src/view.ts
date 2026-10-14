import type { AccountType } from "./tax.js";
import type { Report } from "./portfolio.js";
import type { Instrument } from "./stocks/positions.js";

/** Flat rows for the dashboard: one per bond lot or share position, all amounts in PLN. */
export type AssetClass = "Bonds" | "Shares & ETFs" | "Funds";

export interface Row {
  kind: "bond" | "stock";
  assetClass: AssetClass;
  name: string;
  detail: string;
  account: AccountType;
  quantity: number;
  cost: number;
  value: number | null;
  income: number | null; // gross: interest/dividends + price gains, realised and unrealised
  netIncome: number | null; // after Belka
  ifSoldNow?: number; // bonds: net gain after early-redemption fee and Belka
  price?: { value: number; currency: string; date: string };
  breakdown: Record<string, number>;
}

export function toRows(report: Report, instruments: Instrument[] = []): Row[] {
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const rows: Row[] = [];
  for (const b of report.bonds) {
    const p = b.valuation.currentPeriod;
    rows.push({
      kind: "bond",
      assetClass: "Bonds",
      name: b.lot.series.toUpperCase(),
      detail: b.valuation.matured
        ? `matured ${b.valuation.asOf}`
        : `year ${p.index} at ${p.rate.toFixed(2)}%${p.basis ? ` (${p.basis})` : ""} · bought ${b.lot.purchaseDate}`,
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
    const inst = bySymbol.get(s.symbol);
    rows.push({
      kind: "stock",
      assetClass: inst?.analizy ? "Funds" : "Shares & ETFs",
      name: s.symbol,
      detail: inst?.name ?? s.symbol,
      price: s.price !== undefined ? { value: s.price, currency: inst?.currency ?? "PLN", date: s.priceDate! } : undefined,
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
