import { describe, expect, it } from "vitest";
import { buildPositions, type Instrument, type Trade } from "../src/stocks/positions.js";
import { fetchFxRate, fetchQuote, parseAnalizyFundPage, parseNbpRates, parseStooqQuote, parseYahooChart } from "../src/prices/providers.js";

const instruments: Instrument[] = [
  { symbol: "CDR", currency: "PLN" },
  { symbol: "VWCE", currency: "EUR", stooq: "vwce.de", yahoo: "VWCE.DE" },
];

describe("positions", () => {
  const trades: Trade[] = [
    { symbol: "CDR", account: "regular", type: "buy", date: "2024-10-10", quantity: 10, price: 120, commission: 5 },
    { symbol: "CDR", account: "regular", type: "buy", date: "2025-03-01", quantity: 10, price: 200, commission: 5 },
    { symbol: "CDR", account: "regular", type: "sell", date: "2026-02-01", quantity: 15, price: 250, commission: 10 },
    { symbol: "VWCE", account: "IKE", type: "buy", date: "2025-05-05", quantity: 2, price: 120, fxRate: 4.3 },
  ];
  const dividends = [{ symbol: "CDR", account: "regular" as const, date: "2026-06-20", gross: 5, withheldTax: 0.95 }];
  const quotes = {
    CDR: { price: 300, date: "2026-10-14", fxRate: 1 },
    VWCE: { price: 140, date: "2026-10-14", fxRate: 4.25 },
  };

  it("matches sells FIFO, includes commissions and taxes the total gain", () => {
    const [cdr] = buildPositions(instruments, trades, dividends, quotes);
    expect(cdr).toMatchObject({
      symbol: "CDR",
      quantity: 5,
      costPln: 1002.5,
      avgCost: 200.5,
      realizedPln: 1532.5,
      valuePln: 1500,
      unrealizedPln: 497.5,
      dividendsGrossPln: 5,
      dividendsTaxPln: 0.95,
      gainPln: 2035,
      netGainPln: 1648.05, // 2030 - 386 Belka + 5 - 0.95
    });
  });

  it("converts foreign holdings to PLN and skips Belka on IKE", () => {
    const vwce = buildPositions(instruments, trades, dividends, quotes)[1];
    expect(vwce).toMatchObject({ account: "IKE", costPln: 1032, valuePln: 1190, unrealizedPln: 158, netGainPln: 158 });
  });

  it("rejects selling more than held and foreign trades without an exchange rate", () => {
    const oversell: Trade = { symbol: "CDR", account: "IKE", type: "sell", date: "2026-01-01", quantity: 1, price: 1 };
    expect(() => buildPositions(instruments, [oversell], [], {})).toThrow(/selling more than held/);
    const noFx: Trade = { symbol: "VWCE", account: "regular", type: "buy", date: "2026-01-01", quantity: 1, price: 1 };
    expect(() => buildPositions(instruments, [noFx], [], {})).toThrow(/fxRate/);
  });

  it("charges 19% on dividends with low foreign withholding", () => {
    const d = [{ symbol: "VWCE", account: "regular" as const, date: "2026-01-01", gross: 10, withheldTax: 1.5, fxRate: 4 }];
    const t: Trade[] = [{ symbol: "VWCE", account: "regular", type: "buy", date: "2025-01-01", quantity: 1, price: 100, fxRate: 4 }];
    const [p] = buildPositions(instruments, t, d, {});
    expect(p.dividendsTaxPln).toBe(7.6);
  });
});

describe("price sources", () => {
  it("parses stooq quotes and ignores N/D", () => {
    const ok = "Symbol,Date,Time,Open,High,Low,Close,Volume\nCDR,2026-10-14,17:04:59,250,255,248,252.4,123456\n";
    expect(parseStooqQuote(ok)).toEqual({ price: 252.4, date: "2026-10-14", source: "stooq" });
    expect(parseStooqQuote("Symbol,Date,Time,Open,High,Low,Close,Volume\nXYZ,N/D,N/D,N/D,N/D,N/D,N/D,N/D")).toBeUndefined();
  });

  it("parses Yahoo chart meta", () => {
    const json = JSON.stringify({ chart: { result: [{ meta: { currency: "EUR", regularMarketPrice: 141.2, regularMarketTime: 1791990000 } }] } });
    expect(parseYahooChart(json)).toMatchObject({ price: 141.2, source: "yahoo" });
  });

  it("falls back to Yahoo when stooq has nothing", async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      if (url.includes("stooq")) return "Symbol,Date,Time,Open,High,Low,Close,Volume\nVWCE.DE,N/D,N/D,N/D,N/D,N/D,N/D,N/D";
      return JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 140, regularMarketTime: 1791990000 } }] } });
    };
    const q = await fetchQuote(instruments[1], get);
    expect(q.price).toBe(140);
    expect(urls[1]).toContain("VWCE.DE");
  });

  it("takes the NBP rate from the business day before the trade", async () => {
    const json = JSON.stringify({ rates: [
      { effectiveDate: "2026-10-09", mid: 4.25 },
      { effectiveDate: "2026-10-12", mid: 4.26 },
      { effectiveDate: "2026-10-13", mid: 4.27 },
    ] });
    expect(parseNbpRates(json, "2026-10-13")).toBe(4.26);
    let asked = "";
    expect(await fetchFxRate("EUR", "2026-10-13", async (u) => ((asked = u), json))).toBe(4.26);
    expect(asked).toContain("/eur/2026-09-29/2026-10-12/");
  });

  it("reads the PKO DFE unit value from analizy.pl", async () => {
    const html = `<div class="x"><span>28,28</span> PLN</div>\n<p>Aktualna wartość J.U.</p>\n<span>12.10.2026</span><span>0,09 PLN /</span>`;
    expect(parseAnalizyFundPage(html)).toEqual({ price: 28.28, date: "2026-10-12", source: "analizy.pl" });
    let asked = "";
    const q = await fetchQuote({ symbol: "PKODFE", currency: "PLN", analizy: "EBAN2" }, async (u) => ((asked = u), html));
    expect(q.price).toBe(28.28);
    expect(asked).toBe("https://www.analizy.pl/fundusz/EBAN2");
  });
});
