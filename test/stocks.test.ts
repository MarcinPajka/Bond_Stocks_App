import { describe, expect, it } from "vitest";
import { buildPositions, type Instrument, type Trade } from "../src/stocks/positions.js";
import { analizyId, yahooSymbol, fetchFxQuote, fetchFxRate, fetchQuote, parseAnalizyFundPage, parseNbpRates, parseStooqQuote, parseYahooChart } from "../src/prices/providers.js";
import { withFxRates } from "../src/portfolio.js";

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
    expect(() => buildPositions(instruments, [noFx], [], {})).toThrow(/exchange rate/);
  });

  it("keeps the price paid for the shares still held, after FIFO sells", () => {
    const [cdr] = buildPositions(instruments, trades, dividends, quotes);
    expect(cdr).toMatchObject({ avgPrice: 200, openLots: [{ date: "2025-03-01", quantity: 5, price: 200 }], pricePln: 300 });
  });

  it("values a euro-listed ETF bought in złoty at its euro price times the NBP rate", () => {
    const inst = [{ symbol: "VWCE", currency: "PLN", stooq: "vwce.de" }];
    const bought: Trade[] = [{ symbol: "VWCE", account: "regular", type: "buy", date: "2025-11-18", quantity: 50, price: 654.204 }];
    const [p] = buildPositions(inst, bought, [], { VWCE: { price: 170.44, date: "2026-10-16", currency: "EUR", fxRate: 4.24 } });
    expect(p).toMatchObject({ costPln: 32710.2, valuePln: 36133.28, unrealizedPln: 3423.08, priceCurrency: "EUR", pricePln: 722.67, avgPrice: 654.204 });
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

  it("asks Yahoo first for a listing outside Warsaw, and keeps the price's currency", async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      return JSON.stringify({ chart: { result: [{ meta: { currency: "EUR", regularMarketPrice: 170.44, regularMarketTime: 1791990000 } }] } });
    };
    const q = await fetchQuote({ symbol: "VWCE", currency: "PLN", stooq: "vwce.de" }, get);
    expect(q).toMatchObject({ price: 170.44, currency: "EUR" });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/chart/VWCE.DE?");
  });

  it("tries stooq first for GPW shares, then Yahoo", async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      if (url.includes("stooq")) return "Symbol,Date,Time,Open,High,Low,Close,Volume\nCDR,N/D,N/D,N/D,N/D,N/D,N/D,N/D";
      return JSON.stringify({ chart: { result: [{ meta: { currency: "PLN", regularMarketPrice: 280, regularMarketTime: 1791990000 } }] } });
    };
    const q = await fetchQuote({ symbol: "CDR", currency: "PLN" }, get);
    expect(q.price).toBe(280);
    expect(urls[0]).toContain("stooq.pl");
    expect(urls[1]).toContain("/chart/CDR.WA?");
  });

  it("derives the Yahoo symbol from the stooq one", () => {
    expect(yahooSymbol({ symbol: "VWCE", currency: "PLN", stooq: "vwce.de" })).toBe("VWCE.DE");
    expect(yahooSymbol({ symbol: "AAPL", currency: "USD", stooq: "aapl.us" })).toBe("AAPL");
    expect(yahooSymbol({ symbol: "HSBA", currency: "GBP", stooq: "hsba.uk" })).toBe("HSBA.L");
    expect(yahooSymbol({ symbol: "CDR", currency: "PLN" })).toBe("CDR.WA");
    expect(yahooSymbol({ symbol: "X", currency: "EUR", stooq: "x.de", yahoo: "X.F" })).toBe("X.F");
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
    // The entry form shows which day's rate it used: a Tuesday trade after a Monday holiday still gets Friday's.
    const holiday = JSON.stringify({ rates: [{ effectiveDate: "2026-10-09", mid: 4.25 }] });
    expect(await fetchFxQuote("USD", "2026-10-13", async () => holiday)).toEqual({ rate: 4.25, date: "2026-10-09" });
    expect(await fetchFxQuote("PLN", "2026-10-13")).toEqual({ rate: 1, date: "2026-10-13" });
  });

  it("saves foreign entries with the NBP rate when none was entered", async () => {
    const json = JSON.stringify({ rates: [{ effectiveDate: "2026-10-12", mid: 3.66 }] });
    const p = await withFxRates({
      instruments: [{ symbol: "AAPL", currency: "USD" }, { symbol: "VWCE", currency: "PLN" }],
      trades: [
        { symbol: "AAPL", account: "regular", type: "buy", date: "2026-10-13", quantity: 1, price: 230 },
        { symbol: "AAPL", account: "regular", type: "buy", date: "2026-10-14", quantity: 1, price: 231, fxRate: 3.7 },
        { symbol: "VWCE", account: "regular", type: "buy", date: "2026-10-13", quantity: 1, price: 700 },
      ],
    }, async () => json);
    expect(p.trades!.map((t) => t.fxRate)).toEqual([3.66, 3.7, undefined]);
    await expect(withFxRates({ instruments: [{ symbol: "AAPL", currency: "USD" }], dividends: [{ symbol: "AAPL", account: "regular", date: "2026-10-13", gross: 1 }] },
      async () => { throw new Error("HTTP 404"); })).rejects.toThrow(/AAPL dividend on 2026-10-13: .*Enter the exchange rate/);
  });

  it("reads the PKO DFE unit value from analizy.pl", async () => {
    const html = `<div class="x"><span>28,28</span> PLN</div>\n<p>Aktualna wartość J.U.</p>\n<span>12.10.2026</span><span>0,09 PLN /</span>`;
    expect(parseAnalizyFundPage(html)).toEqual({ price: 28.28, date: "2026-10-12", source: "analizy.pl", currency: "PLN" });
    let asked = "";
    const q = await fetchQuote({ symbol: "PKODFE", currency: "PLN", analizy: "EBAN2" }, async (u) => ((asked = u), html));
    expect(q.price).toBe(28.28);
    expect(asked).toBe("https://www.analizy.pl/fundusz/EBAN2");
  });

  it("accepts a pasted analizy.pl fund link as the id", () => {
    expect(analizyId("https://www.analizy.pl/fundusz/EBAN2/pko-dobrowolny-fundusz-emerytalny")).toBe("EBAN2");
    expect(analizyId(" eban2 ")).toBe("EBAN2");
  });

  it("says how to fix an instrument that no source knows", async () => {
    const get = async () => { throw new Error("HTTP 404"); };
    await expect(fetchQuote({ symbol: "PKODFE", currency: "PLN" }, get)).rejects.toThrow(/analizy\.pl id.*Price source/);
  });
});
