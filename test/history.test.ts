import { describe, expect, it } from "vitest";
import { valueLot } from "../src/bonds/lot.js";
import { chartDates, fetchFxHistory, parseNbpRateSeries, parseYahooHistory, valueHistory } from "../src/history.js";
import { incomeByYear } from "../src/insights.js";
import { buildReport, type PortfolioFile } from "../src/portfolio.js";
import { testMarketData } from "./fixtures/market.js";

describe("early redemption", () => {
  const lot = { series: "EDO1035", purchaseDate: "2025-10-15", quantity: 10, account: "regular" as const };

  it("closes the lot at the redemption value, after the fee", () => {
    const r = valueLot({ ...lot, redeemedOn: "2026-10-14" }, testMarketData(), "2026-12-01");
    expect(r.redeemed).toEqual({ date: "2026-10-14", proceeds: 1029.8 });
    expect(r).toMatchObject({ value: 0, gain: 29.8, tax: 6, netGain: 23.8 });
  });

  it("is still held before the redemption date", () => {
    const r = valueLot({ ...lot, redeemedOn: "2026-10-14" }, testMarketData(), "2026-06-01");
    expect(r.redeemed).toBeUndefined();
    expect(r.value).toBeGreaterThan(1000);
  });

  it("rejects a redemption before purchase", () => {
    expect(() => valueLot({ ...lot, redeemedOn: "2025-01-01" }, testMarketData(), "2026-01-01")).toThrow(/before it was bought/);
  });

  it("counts the redemption in that year's income", async () => {
    const report = await buildReport({ bonds: [{ ...lot, redeemedOn: "2026-10-14" }] }, { offline: true, asOf: "2026-12-01", marketData: testMarketData() });
    expect(incomeByYear(report).find((y) => y.year === 2026)).toMatchObject({ bondInterest: 29.8, bondTax: 6 });
  });
});

describe("price history sources", () => {
  it("reads daily closes from the Yahoo chart API, skipping empty days", () => {
    const json = JSON.stringify({ chart: { result: [{
      meta: { currency: "EUR", gmtoffset: 7200 },
      timestamp: [1760511600, 1760598000, 1760684400], // 15, 16, 17 Oct 2025, 09:00 local time
      indicators: { quote: [{ close: [140.12, null, 141.5] }] },
    }] } });
    expect(parseYahooHistory(json)).toEqual({ "2025-10-15": 140.12, "2025-10-17": 141.5 });
  });

  it("converts London pence to pounds", () => {
    const json = JSON.stringify({ chart: { result: [{ meta: { currency: "GBp", gmtoffset: 0 }, timestamp: [1760511600], indicators: { quote: [{ close: [5012] }] } }] } });
    expect(parseYahooHistory(json)).toEqual({ "2025-10-15": 50.12 });
  });

  it("asks NBP for at most 90 days at a time and skips spans without tables", async () => {
    const asked: string[] = [];
    const get = async (url: string) => {
      asked.push(url);
      if (url.includes("2026-03-31")) throw new Error("HTTP 404");
      return JSON.stringify({ rates: [{ effectiveDate: url.split("/")[8], mid: 4.2 }] });
    };
    const s = await fetchFxHistory("EUR", "2026-01-01", "2026-05-15", get);
    expect(asked.map((u) => u.split("/").slice(8, 10).join(" "))).toEqual(["2026-01-01 2026-03-31", "2026-04-01 2026-05-15"]);
    expect(s).toEqual({ "2026-04-01": 4.2 });
    expect(parseNbpRateSeries('{"rates":[{"effectiveDate":"2026-01-02","mid":4.21}]}')).toEqual({ "2026-01-02": 4.21 });
  });
});

describe("value over time, ETF bought in złoty", () => {
  it("prices it in euro at NBP rates and ignores złoty trade prices as quotes", () => {
    const p: PortfolioFile = {
      instruments: [{ symbol: "VWCE", currency: "PLN", stooq: "vwce.de" }],
      trades: [{ symbol: "VWCE", account: "regular", type: "buy", date: "2025-11-18", quantity: 50, price: 654.204 }],
    };
    const prices = {
      prices: { VWCE: { "2025-11-18": 150, "2026-10-16": 170.44 } },
      currencies: { VWCE: "EUR" },
      fx: { EUR: { "2025-11-17": 4.23, "2026-10-15": 4.24 } },
      checkedAt: {},
    };
    const h = valueHistory(p, p.trades!, testMarketData(), prices, "2026-10-18");
    const pts = h.byId["stock:VWCE|regular"];
    expect(pts[0]).toEqual({ date: "2025-11-18", value: 31725, cost: 32710.2 }); // 50 × 150 € × 4.23
    expect(pts.at(-1)).toEqual({ date: "2026-10-18", value: 36133.28, cost: 32710.2 }); // 50 × 170.44 € × 4.24
  });
});

describe("value over time", () => {
  const p: PortfolioFile = {
    bonds: [{ series: "EDO1035", purchaseDate: "2025-10-15", quantity: 10, account: "regular", redeemedOn: "2026-04-15" }],
    instruments: [{ symbol: "VWCE", currency: "EUR" }],
    trades: [
      { symbol: "VWCE", account: "IKE", type: "buy", date: "2025-11-03", quantity: 10, price: 130, fxRate: 4.25 },
      { symbol: "VWCE", account: "IKE", type: "sell", date: "2026-02-02", quantity: 4, price: 135, fxRate: 4.2 },
    ],
  };
  const prices = {
    prices: { VWCE: { "2025-11-03": 130, "2025-12-01": 132, "2026-03-02": 140 } },
    fx: { EUR: { "2025-11-03": 4.25, "2025-12-01": 4.22, "2026-03-02": 4.3 } },
    checkedAt: {},
  };
  const h = valueHistory(p, p.trades!, testMarketData(), prices, "2026-05-01");

  it("prices shares at the last close and NBP rate on or before each day", () => {
    const at = (d: string) => h.byId["stock:VWCE|IKE"].find((x) => x.date === d)!;
    expect(at("2025-11-03")).toEqual({ date: "2025-11-03", value: 5525, cost: 5525 });
    expect(at("2025-12-15").value).toBe(5570.4); // 10 × 132 × 4.22
    expect(at("2026-03-10")).toEqual({ date: "2026-03-10", value: 3612, cost: 3315 }); // 6 left, FIFO cost 6 × 130 × 4.25
  });

  it("values the bond from purchase until it was redeemed", () => {
    const bond = h.byId["bond:0"];
    expect(bond[0]).toEqual({ date: "2025-10-15", value: 1000, cost: 1000 });
    expect(bond.at(-1)!.date).toBe("2026-04-15");
    expect(bond.at(-1)!.value).toBeLessThan(1035);
  });

  it("adds every holding into the total", () => {
    const t = h.total.find((x) => x.date === "2025-12-15")!;
    const bond = h.byId["bond:0"].find((x) => x.date === "2025-12-15")!;
    expect(t.value).toBeCloseTo(bond.value + 5570.4, 2);
    expect(h.total.at(-1)).toEqual({ date: "2026-05-01", value: 3612, cost: 3315 });
  });

  it("spreads long histories over at most ~400 points", () => {
    expect(chartDates("2020-01-01", "2026-01-01").length).toBeLessThanOrEqual(402);
    expect(chartDates("2026-01-01", "2026-01-03")).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });
});
