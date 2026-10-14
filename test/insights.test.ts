import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildReport, type PortfolioFile } from "../src/portfolio.js";
import { contributions, incomeByYear, projectBonds, upcomingEvents } from "../src/insights.js";

const sample: PortfolioFile = JSON.parse(readFileSync(new URL("../portfolio.example.json", import.meta.url), "utf8"));
const report = await buildReport(sample, { offline: true, asOf: "2026-10-14" });

describe("insights on the sample portfolio", () => {
  it("lists upcoming bond events with known amounts", () => {
    const events = upcomingEvents(report.bonds, "2026-10-14");
    expect(events[0]).toMatchObject({ date: "2026-10-15", kind: "reset", title: "EDO1035 year 1 ends", amount: 60 });
    expect(events.find((e) => e.title.startsWith("EDO0135"))).toMatchObject({ date: "2027-01-20", amount: 239.5 });
    expect(events.some((e) => e.title.startsWith("COI1030"))).toBe(false); // first payout is a year away
  });

  it("sums income and tax by year", () => {
    const y2026 = incomeByYear(report).find((r) => r.year === 2026)!;
    expect(y2026).toMatchObject({ realizedRegular: 642.5, pit38Tax: 122, dividends: 15, dividendTax: 2.85 });
    expect(y2026.totalNet).toBe(532.65); // 642.5 - 122 + 15 - 2.85
  });

  it("tracks IKE and IKZE purchases against the yearly limit", () => {
    expect(contributions(report, 2026)).toEqual([
      { account: "IKE", year: 2026, paidIn: 0, limit: 28260 },
      { account: "IKZE", year: 2026, paidIn: 8620.27, limit: 11304 },
    ]);
    expect(contributions(report, 2025)[0].paidIn).toBe(9099.2);
    expect(contributions(report, 2026, true)[1].limit).toBe(16956);
  });

  it("projects a bond to maturity with assumed inflation", () => {
    const lot = sample.bonds!.find((b) => b.series === "EDO1035")!;
    const [p] = projectBonds([lot], report.bondData, "2026-10-14", { inflation: 3, nbpRate: 3.75 });
    let v = 111.72; // 100 * 1.06, then * 1.054 (Aug 2026 CPI 3.4% + 2%)
    for (let i = 0; i < 8; i++) v = Math.round(v * 1.05 * 100) / 100;
    expect(p.maturity).toBe("2035-10-15");
    expect(p.valueAtMaturity).toBeCloseTo(v * 10, 2);
    expect(p.points[0]).toEqual({ date: "2025-10-15", value: 1000 });
    expect(p.points).toHaveLength(11);
    expect(p.netGain).toBe(p.gain - Math.round(p.gain * 0.19));
  });
});
