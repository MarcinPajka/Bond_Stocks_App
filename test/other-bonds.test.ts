import { describe, expect, it } from "vitest";
import { valueBond, type MarketData } from "../src/bonds/bond.js";
import { businessDaysBefore, isPolishHoliday } from "../src/bonds/dates.js";
import { valueLot } from "../src/bonds/lot.js";
import { testMarketData } from "./fixtures/market.js";

const market: MarketData = {
  cpi: { "2027-08": 3.0 },
  nbpReference: { "2026-03-05": 3.75, "2026-10-20": 3.5 },
};

describe("COI (yearly payout, inflation-indexed)", () => {
  const terms = { firstYearRate: 4.75, margin: 1.5, earlyFee: 2.0 };

  it("pays interest each year and accrues on the nominal", () => {
    const v = valueBond("COI", "2026-10-01", terms, market, "2028-04-01");
    expect(v.payouts).toEqual([{ date: "2027-10-01", amount: 4.75 }]);
    expect(v.currentPeriod.rate).toBe(4.5);
    expect(v.valuePerBond).toBe(102.25); // 100 + 100 * 4.5% * 183/366
    expect(v.redemptionValuePerBond).toBe(100.25); // full 2 zł fee from period 2
  });

  it("caps the fee at accrued interest in the first year", () => {
    const v = valueBond("COI", "2026-10-01", terms, market, "2026-10-11");
    expect(v.valuePerBond).toBe(100.13);
    expect(v.redemptionValuePerBond).toBe(100);
  });

  it("taxes each payout and the remaining gain", () => {
    const data = { ...testMarketData(), ...market };
    const r = valueLot({ series: "COI1030", purchaseDate: "2026-10-01", quantity: 10, account: "regular" }, data, "2028-04-01");
    expect(r).toMatchObject({ cost: 1000, value: 1022.5, interestPaid: 47.5, gain: 70, tax: 13, netGain: 57 });
    expect(r.redemptionValue).toBe(1002.5);
    expect(r.redemptionNetGain).toBe(41);
  });
});

describe("ROR (monthly payout, NBP rate)", () => {
  const terms = { firstYearRate: 4.0, margin: 0, earlyFee: 0.5 };

  it("uses the NBP rate in force 10 business days before the month starts", () => {
    expect(businessDaysBefore("2026-11-01", 10)).toBe("2026-10-19");
    const v = valueBond("ROR", "2026-10-01", terms, market, "2026-12-01");
    expect(v.payouts).toEqual([
      { date: "2026-11-01", amount: 0.33 },
      { date: "2026-12-01", amount: 0.31 },
    ]);
    expect(v.periods[1].rate).toBe(3.75); // the 20 Oct cut came after the fixing date
    expect(v.periods[2].rate).toBe(3.5);
  });
});

describe("TOS and OTS (fixed rate)", () => {
  it("capitalises TOS yearly at the fixed rate", () => {
    const terms = { firstYearRate: 4.4, margin: 0, earlyFee: 1.0 };
    expect(valueBond("TOS", "2026-10-01", terms, market, "2027-10-01").valuePerBond).toBe(104.4);
    expect(valueBond("TOS", "2026-10-01", terms, market, "2028-10-01").valuePerBond).toBe(108.99);
  });

  it("pays OTS interest at maturity and only the nominal if redeemed early", () => {
    const terms = { firstYearRate: 2.0, margin: 0, earlyFee: 0 };
    const early = valueBond("OTS", "2026-10-01", terms, market, "2026-11-15");
    expect(early.redemptionValuePerBond).toBe(100);
    const done = valueBond("OTS", "2026-10-01", terms, market, "2027-02-01");
    expect(done.matured).toBe(true);
    expect(done.payouts).toEqual([{ date: "2027-01-01", amount: 0.5 }]);
  });
});

describe("accounts and calendar", () => {
  it("charges no early-redemption fee on IKE", () => {
    const data = testMarketData();
    const r = valueLot({ series: "EDO1035", purchaseDate: "2025-10-15", quantity: 10, account: "IKE" }, data, "2026-10-14");
    expect(r.redemptionValue).toBe(r.value);
  });

  it("knows movable Polish holidays", () => {
    expect(isPolishHoliday("2026-04-06")).toBe(true); // Easter Monday
    expect(isPolishHoliday("2026-06-04")).toBe(true); // Corpus Christi
    expect(isPolishHoliday("2026-06-05")).toBe(false);
  });

  it("accepts terms on the holding for series not in the table", () => {
    const r = valueLot(
      { series: "EDO0124", purchaseDate: "2024-01-10", quantity: 1, account: "regular", terms: { firstYearRate: 7.0, margin: 1.5, earlyFee: 2.0 } },
      testMarketData(),
      "2025-01-10",
    );
    expect(r.value).toBe(107);
  });
});
