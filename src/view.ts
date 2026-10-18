import type { AccountType } from "./tax.js";
import type { Report } from "./portfolio.js";
import type { BondLot } from "./bonds/lot.js";
import type { Instrument } from "./stocks/positions.js";

/** Flat rows for the dashboard: one per bond lot or share position, all amounts in PLN. */
export type AssetClass = "Bonds" | "Shares & ETFs" | "Funds";

export interface Row {
  id: string; // "bond:<index in portfolio.bonds>" or "stock:<symbol>|<account>", also used by /api/history
  kind: "bond" | "stock";
  closed: boolean; // redeemed or sold out
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
  redemptionValue?: number; // bonds: cash back if redeemed today, after the fee, before tax
  price?: { value: number; currency: string; date: string };
  breakdown: Record<string, number>;
}

export function toRows(report: Report, instruments: Instrument[] = [], bondEntries: BondLot[] = []): Row[] {
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const rows: Row[] = [];
  for (const b of report.bonds) {
    const p = b.valuation.currentPeriod;
    const index = bondEntries.indexOf(b.lot);
    rows.push({
      id: `bond:${index < 0 ? report.bonds.indexOf(b) : index}`,
      kind: "bond",
      closed: !!b.redeemed,
      assetClass: "Bonds",
      name: b.lot.series.toUpperCase(),
      detail: b.redeemed
        ? `redeemed early ${b.redeemed.date} · bought ${b.lot.purchaseDate}`
        : b.valuation.matured
        ? `matured ${b.valuation.asOf}`
        : `year ${p.index} at ${p.rate.toFixed(2)}%${p.basis ? ` (${p.basis})` : ""} · bought ${b.lot.purchaseDate}`,
      account: b.lot.account,
      quantity: b.lot.quantity,
      cost: b.cost,
      value: b.value,
      income: b.gain,
      netIncome: b.netGain,
      ifSoldNow: b.redeemed || b.valuation.matured ? undefined : b.redemptionNetGain,
      redemptionValue: b.redeemed || b.valuation.matured ? undefined : b.redemptionValue,
      breakdown: b.redeemed
        ? { "Received on redemption": b.redeemed.proceeds, "Interest paid out": b.interestPaid, "Belka": b.tax }
        : { "Interest paid out": b.interestPaid, "Accrued in value": Math.round((b.value - b.cost) * 100) / 100, "Belka": b.tax },
    });
  }
  for (const s of report.positions) {
    const inst = bySymbol.get(s.symbol);
    rows.push({
      id: `stock:${s.symbol}|${s.account}`,
      kind: "stock",
      closed: s.quantity <= 1e-9,
      assetClass: inst?.analizy ? "Funds" : "Shares & ETFs",
      name: s.symbol,
      detail: inst?.name ?? s.symbol,
      price: s.price !== undefined ? { value: s.price, currency: s.priceCurrency ?? inst?.currency ?? "PLN", date: s.priceDate! } : undefined,
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
