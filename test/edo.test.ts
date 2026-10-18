import { describe, expect, it } from "vitest";
import { valueBond as value, type MarketData, type SeriesTerms } from "../src/bonds/bond.js";
import { valueLot } from "../src/bonds/lot.js";
import { testMarketData } from "./fixtures/market.js";
import { addYears } from "../src/bonds/dates.js";

const EDO1035: SeriesTerms = { firstYearRate: 6.0, margin: 2.0, earlyFee: 3.0 };
const cpi = { "2026-08": 3.4, "2027-08": -0.5 };
const valueBond = (purchase: string, terms: SeriesTerms, c: MarketData["cpi"], asOf: string) =>
  value("EDO", purchase, terms, { cpi: c, nbpReference: {} }, asOf);

describe("EDO valuation", () => {
  it("accrues the fixed first-year rate on actual days", () => {
    const v = valueBond("2025-10-15", EDO1035, cpi, "2026-10-14");
    expect(v.currentPeriod.index).toBe(1);
    expect(v.valuePerBond).toBe(105.98); // 100 * (1 + 6% * 364/365)
  });

  it("capitalises on the anniversary and uses CPI from two months before plus margin", () => {
    const v = valueBond("2025-10-15", EDO1035, cpi, "2026-10-15");
    expect(v.currentPeriod).toMatchObject({ index: 2, basis: "CPI 2026-08 3.4% + 2%", rate: 5.4, valueAtStart: 106 });
    expect(v.valuePerBond).toBe(106);
  });

  it("accrues mid-period on the capitalised value", () => {
    const v = valueBond("2025-10-15", EDO1035, cpi, "2027-04-15");
    expect(v.valuePerBond).toBe(108.85); // 106 * (1 + 5.4% * 182/365)
  });

  it("treats negative inflation as zero", () => {
    const v = valueBond("2025-10-15", EDO1035, cpi, "2027-10-15");
    expect(v.currentPeriod.rate).toBe(2.0);
    expect(v.currentPeriod.valueAtStart).toBe(111.72); // 106 * 1.054
  });

  it("never lets the early-redemption fee go below nominal", () => {
    const v = valueBond("2025-10-15", EDO1035, cpi, "2025-10-30");
    expect(v.valuePerBond).toBe(100.25);
    expect(v.redemptionValuePerBond).toBe(100);
  });

  it("deducts the fee once enough interest has accrued", () => {
    const v = valueBond("2025-10-15", EDO1035, cpi, "2026-10-14");
    expect(v.redemptionValuePerBond).toBe(102.98);
  });

  it("estimates from the latest known CPI when a month is missing, and fails with none", () => {
    const v = valueBond("2025-10-15", EDO1035, { "2026-06": 2.5 }, "2026-11-01");
    expect(v.currentPeriod.rate).toBe(4.5);
    expect(v.currentPeriod.basis).toMatch(/^estimated: CPI 2026-08 not in data, used 2026-06/);
    expect(() => valueBond("2025-10-15", EDO1035, {}, "2026-11-01")).toThrow(/Missing CPI for 2026-08/);
  });

  it("pays the full compounded value at maturity with no fee", () => {
    const flat: Record<string, number> = {};
    for (let y = 2026; y <= 2035; y++) flat[`${y}-08`] = 3.0;
    const v = valueBond("2025-10-15", EDO1035, flat, "2040-01-01");
    expect(v.matured).toBe(true);
    expect(v.asOf).toBe("2035-10-15");
    // 106 * 1.05^9, rounded to grosz each year
    let expected = 106;
    for (let i = 0; i < 9; i++) expected = Math.round(expected * 1.05 * 100) / 100;
    expect(v.valuePerBond).toBe(expected);
    expect(v.redemptionValuePerBond).toBe(expected);
  });

  it("handles a 29 February purchase", () => {
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
  });
});

describe("EDO lot", () => {
  it("computes gain with and without Belka tax", () => {
    const data = testMarketData();
    const lot = { series: "EDO1035", purchaseDate: "2025-10-15", quantity: 10, account: "regular" as const };
    const r = valueLot(lot, data, "2026-10-14");
    expect(r).toMatchObject({ cost: 1000, value: 1059.8, gain: 59.8, tax: 11, netGain: 48.8 });
    expect(r.redemptionValue).toBe(1029.8);
    expect(r.redemptionNetGain).toBe(23.8); // 29.80 - round(5.66)
  });

  it("skips Belka on IKE", () => {
    const data = testMarketData();
    const r = valueLot({ series: "EDO1035", purchaseDate: "2025-10-15", quantity: 10, account: "IKE" }, data, "2026-10-14");
    expect(r.netGain).toBe(59.8);
  });
});
