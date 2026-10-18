import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGusCpiPage,
  parseNbpRatesXml,
  parseSeriesPage,
  refreshBondData,
  saleMonth,
} from "../src/bonds/refresh.js";

// Fragments as they appear on obligacjeskarbowe.pl series pages.
const page = (...parts: string[]) => `<html><body>${parts.map((p) => `<p>${p}</p>`).join("\n")}</body></html>`;
const FEES = (word: string, before: string, after: string) => [
  `Dla emisji zakupionych do 31 sierpnia 2024 r. opłata wynosi ${before} zł od każdej obligacji ${word}.`,
  `Dla emisji zakupionych od 1 września 2024 r. opłata wynosi ${after} zł od każdej obligacji ${word}.`,
];

describe("series pages", () => {
  it("works out the sale month from the code", () => {
    expect(saleMonth("EDO1035")).toBe("2025-10-01");
    expect(saleMonth("ror1027")).toBe("2026-10-01");
    expect(saleMonth("OTS0127")).toBe("2026-10-01");
  });

  it("reads EDO terms and picks the fee for when the series was sold", () => {
    const html = page(
      "<strong>6,00%</strong> w pierwszym rocznym okresie odsetkowym",
      "w kolejnych rocznych okresach odsetkowych: marża 2,00% + inflacja",
      ...FEES("dziesięcioletniej", "2,00", "3,00"),
    );
    expect(parseSeriesPage(html, "EDO1035")).toEqual({ firstYearRate: 6, margin: 2, earlyFee: 3 });
    expect(parseSeriesPage(html, "EDO0634")).toEqual({ firstYearRate: 6, margin: 2, earlyFee: 2 });
  });

  it("reads an older page with a single fee", () => {
    const html = page("6,80% w pierwszym rocznym okresie odsetkowym", "marża 2,00% + inflacja",
      "opłatę, która wynosi 2,00 zł od każdej obligacji dziesięcioletniej");
    expect(parseSeriesPage(html, "EDO0634")).toEqual({ firstYearRate: 6.8, margin: 2, earlyFee: 2 });
  });

  it("reads COI, DOR, ROR and TOS wording", () => {
    expect(parseSeriesPage(page("5,50%, w skali roku, w pierwszym rocznym okresie odsetkowym.", "marża 1,50% + inflacja",
      ...FEES("czteroletniej", "0,70", "2,00")), "COI1029")).toEqual({ firstYearRate: 5.5, margin: 1.5, earlyFee: 2 });
    expect(parseSeriesPage(page("4,15% w skali roku, w pierwszym miesięcznym okresie odsetkowym.",
      "stopa referencyjna NBP+0,15%.", "Opłata wynosi 0,70 zł od każdej obligacji dwuletniej."), "DOR1028"))
      .toEqual({ firstYearRate: 4.15, margin: 0.15, earlyFee: 0.7 });
    expect(parseSeriesPage(page("W pierwszym miesięcznym okresie odsetkowym oprocentowanie wynosi 4,00% w skali roku.",
      "(stopa referencyjna NBP + marża)", "Opłata wynosi 0,50 zł od każdej obligacji rocznej."), "ROR1027"))
      .toEqual({ firstYearRate: 4, margin: 0, earlyFee: 0.5 });
    expect(parseSeriesPage(page("<b>Oprocentowanie:</b> 4,40%, stałe przez cały 3-letni okres oszczędzania",
      ...FEES("trzyletniej", "0,70", "1,00")), "TOS1029")).toEqual({ firstYearRate: 4.4, margin: 0, earlyFee: 1 });
  });

  it("refuses to guess when the page has no rate", () => {
    expect(() => parseSeriesPage(page("Strona nie istnieje"), "EDO1035")).toThrow(/interest rate/);
  });
});

describe("GUS and NBP", () => {
  const gus = `<h3>Grudzień poprzedniego roku = 100</h3><table><tr><td>Rok</td><td>01</td></tr>
    <tr><td>2026</td><td>100,7</td><td>101,0</td></tr></table>
    <h3>Analogiczny miesiąc poprzedniego roku = 100</h3><table>
    <tr><th>Wyszczególnienie</th><th>Rok</th><th>01</th><th>02</th></tr>
    <tr><td>Ogółem</td><td>2026</td><td>102,1</td><td>102,1</td><td>103,0</td><td>103,2</td><td>103,1</td><td>102,5</td><td>103,0</td><td>103,4</td><td></td><td></td><td></td><td></td></tr>
    <tr><td></td><td>2025</td><td>104,9</td><td>104,9</td></tr></table>
    <h3>Okres poprzedni = 100</h3><table><tr><td>2026</td><td>100,1</td></tr></table>`;

  it("reads only the year-on-year table", () => {
    const cpi = parseGusCpiPage(gus);
    expect(cpi["2026-01"]).toBe(2.1);
    expect(cpi["2026-08"]).toBe(3.4);
    expect(cpi["2026-09"]).toBeUndefined();
    expect(cpi["2025-02"]).toBe(4.9);
  });

  it("reads the layout stat.gov.pl uses: one table, headings inside data rows", () => {
    const real = `<table><tr><td>Wyszczególnienie</td><td>Rok</td><td colspan="12">MIESIĄCE</td></tr>
      <tr><td>Grudzień&nbsp;&nbsp;&nbsp;&nbsp; poprzedniego<br>
      roku = 100</td><td>2026</td><td>100,7</td><td>101,0</td></tr>
      <tr><td></td><td>Rok</td><td>01</td><td>02</td></tr>
      <tr><td>Analogiczny&nbsp;&nbsp; miesi&#261;c<br/>   poprzedniego
      roku&nbsp;=&nbsp;100</td><td>2026</td><td>102,1</td><td>102,1</td><td>103,0</td><td>103,2</td><td>103,1</td><td>102,5</td><td>103,0</td><td>103,4</td><td>104,1</td><td></td><td></td><td></td></tr>
      <tr><td></td><td>2025</td><td>104,9</td><td>104,9</td></tr>
      <tr><td>Analogiczny okres narastający poprzedniego roku = 100</td><td>2026</td><td>102,1</td></tr>
      <tr><td></td><td>2025</td><td>104,9</td></tr></table>`;
    const cpi = parseGusCpiPage(real);
    expect(cpi["2026-01"]).toBe(2.1);
    expect(cpi["2026-09"]).toBe(4.1);
    expect(cpi["2026-10"]).toBeUndefined();
    expect(cpi["2025-02"]).toBe(4.9);
    expect(Object.keys(cpi)).toHaveLength(11);
  });

  it("reads the NBP reference rate", () => {
    const xml = `<tabela id="stoproc"><pozycja\n id="ref"\n nazwa="Stopa referencyjna"\n oprocentowanie="3,75"\n trend = "spadek"\n obowiazuje_od="2026-03-05" />
      <pozycja id="lom" oprocentowanie="4,25" obowiazuje_od="2026-03-05" /></tabela>`;
    expect(parseNbpRatesXml(xml)).toEqual({ date: "2026-03-05", rate: 3.75 });
  });
});

describe("refreshBondData", () => {
  it("fetches unknown series once, updates CPI and NBP, and caches them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-"));
    const cachePath = join(dir, "cache.json");
    const asked: string[] = [];
    const get = async (url: string) => {
      asked.push(url);
      if (url.includes("edo0136")) return page("5,35% w pierwszym rocznym okresie odsetkowym", "marża 2,00% + inflacja", ...FEES("dziesięcioletniej", "2,00", "3,00"));
      if (url.includes("stat.gov.pl")) return `<p>Analogiczny miesiąc poprzedniego roku = 100</p><table><tr><td>2026</td><td>102,1</td><td>102,1</td><td>103,0</td><td>103,2</td><td>103,1</td><td>102,5</td><td>103,0</td><td>103,4</td></tr></table>`;
      if (url.includes("archiwum")) return `<stopy_procentowe_archiwum><pozycje obowiazuje_od="2025-12-04"><pozycja id="ref" oprocentowanie="4,00" /><pozycja id="lom" oprocentowanie="4,50" /></pozycje>
        <pozycje\n obowiazuje_od="2026-03-05"><pozycja\n id="lom" oprocentowanie="4,25" /><pozycja\n id="ref"\n oprocentowanie="3,75" /></pozycje></stopy_procentowe_archiwum>`;
      if (url.includes("nbp.pl")) return `<pozycja id="ref" oprocentowanie="3,50" obowiazuje_od="2026-11-05" />`;
      throw new Error("HTTP 404");
    };

    const r = await refreshBondData(cachePath, ["EDO0136", "edo0136", "XYZ0101"], get, 1e13);
    expect(asked.filter((u) => u.includes("edo0136"))).toHaveLength(1);
    expect(r.data.series.EDO0136).toEqual({ firstYearRate: 5.35, margin: 2, earlyFee: 3 });
    expect(r.data.cpi["2026-08"]).toBe(3.4);
    expect(r.data.nbpReference).toEqual({ "2025-12-04": 4, "2026-03-05": 3.75, "2026-11-05": 3.5 });
    expect(r.warnings.join()).toMatch(/XYZ0101/);
    expect(JSON.parse(readFileSync(cachePath, "utf8")).series.EDO0136.firstYearRate).toBe(5.35);

    // Second run within 12 hours: nothing refetched.
    asked.length = 0;
    await refreshBondData(cachePath, ["EDO0136"], get, 1e13 + 1000);
    expect(asked).toEqual([]);
  });
});
