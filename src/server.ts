// Local, private web app: npm start, then open http://localhost:5173
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, cachePathFor, withKnownSources, type PortfolioFile, type Report } from "./portfolio.js";
import { checkCompatible, defaultDataDir, migrateFromAppFolder, readPortfolioFile, writePortfolioFile } from "./storage.js";
import { contributions, incomeByYear, projectBonds, upcomingEvents } from "./insights.js";
import { toRows } from "./view.js";
import { loadPriceHistory, recordQuotes, refreshPriceHistory, valueHistory } from "./history.js";
import { today } from "./bonds/dates.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = defaultDataDir();
const PORTFOLIO = process.env.PORTFOLIO ?? join(DATA_DIR, "portfolio.json");
if (!process.env.PORTFOLIO) {
  const moved = migrateFromAppFolder(root, DATA_DIR);
  if (moved.length) console.log(`Copied your data (${moved.join(", ")}) from the app folder to ${DATA_DIR}`);
}
const OFFLINE = process.env.OFFLINE === "1";
const PORT = Number(process.env.PORT ?? 5173);
const CACHE_MS = 5 * 60_000;
const MARKET_CACHE = cachePathFor(PORTFOLIO);
const PRICE_HISTORY = join(dirname(PORTFOLIO), "price-history.cache.json");

const readPortfolio = (): PortfolioFile => readPortfolioFile(PORTFOLIO);
/** The portfolio as the calculators see it: price sources filled in where the file has none. */
const portfolioForReport = (): PortfolioFile => withKnownSources(readPortfolio());

let cache: { key: string; at: number; report: Report; body: unknown } | undefined;

async function report(date: string | undefined, refresh: boolean) {
  const portfolio = portfolioForReport();
  const key = JSON.stringify([portfolio, date]);
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache;
  const r = await buildReport(portfolio, { offline: OFFLINE, asOf: date, cachePath: MARKET_CACHE });
  const rows = toRows(r, portfolio.instruments ?? [], portfolio.bonds ?? []);
  const sum = (f: (x: (typeof rows)[number]) => number | null) => Math.round(rows.reduce((a, x) => a + (f(x) ?? 0), 0) * 100) / 100;
  const summary = { value: sum((x) => x.value), cost: sum((x) => x.cost), gain: sum((x) => x.income), netGain: sum((x) => x.netIncome) };

  const year = Number(r.asOf.slice(0, 4));
  const body = {
    asOf: r.asOf,
    offline: OFFLINE,
    rows,
    summary,
    warnings: [...compatibilityWarning(portfolio), ...r.warnings],
    dataFile: PORTFOLIO,
    instruments: portfolio.instruments ?? [], // with price sources filled in
    events: upcomingEvents(r.bonds, r.asOf),
    income: incomeByYear(r),
    contributions: contributions(r, year, portfolio.settings?.ikzeSelfEmployed),
    defaults: {
      inflation: r.bondData.cpi[Object.keys(r.bondData.cpi).sort().at(-1) ?? ""] ?? 3,
      nbpRate: r.bondData.nbpReference[Object.keys(r.bondData.nbpReference).sort().at(-1) ?? ""] ?? 4,
    },
  };
  cache = { key, at: Date.now(), report: r, body };
  return cache;
}

function compatibilityWarning(p: PortfolioFile): string[] {
  try {
    checkCompatible(p);
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}

let historyCache: { key: string; at: number; body: unknown } | undefined;

/** Value over time for the whole portfolio and each holding. Fetches price history as needed. */
async function history(refresh: boolean) {
  const { report: r } = await report(undefined, false);
  const portfolio = portfolioForReport();
  const key = JSON.stringify([portfolio, r.asOf]);
  if (!refresh && historyCache && historyCache.key === key && Date.now() - historyCache.at < CACHE_MS) return historyCache.body;
  let warnings: string[] = [];
  let prices = loadPriceHistory(PRICE_HISTORY);
  if (!OFFLINE) {
    ({ cache: prices, warnings } = await refreshPriceHistory(PRICE_HISTORY, portfolio, r.asOf));
    recordQuotes(PRICE_HISTORY, prices, r, portfolio.instruments ?? []);
  }
  const body = { ...valueHistory(portfolio, r.trades, r.bondData, prices, r.asOf), warnings };
  historyCache = { key, at: Date.now(), body };
  return body;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : (body as Buffer));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/report" && req.method === "GET") {
      return send(res, 200, (await report(url.searchParams.get("date") ?? undefined, url.searchParams.has("refresh"))).body);
    }
    if (url.pathname === "/api/history" && req.method === "GET") {
      return send(res, 200, await history(url.searchParams.has("refresh")));
    }
    if (url.pathname === "/api/projection" && req.method === "GET") {
      const { report: r } = await report(undefined, false);
      const inflation = Number(url.searchParams.get("inflation") ?? 3);
      const nbpRate = Number(url.searchParams.get("nbp") ?? 4);
      return send(res, 200, projectBonds(readPortfolio().bonds ?? [], r.bondData, today(), { inflation, nbpRate }));
    }
    if (url.pathname === "/api/portfolio" && req.method === "GET") return send(res, 200, readPortfolio());
    if (url.pathname === "/api/portfolio" && req.method === "PUT") {
      const next: PortfolioFile = JSON.parse(await readBody(req));
      // Reject data the calculators can't handle; this also fetches terms for new bond series.
      await buildReport(withKnownSources(next), { offline: OFFLINE, cachePath: MARKET_CACHE, skipPrices: true, strict: true });
      await buildReport(withKnownSources(next), { offline: true, cachePath: MARKET_CACHE, skipPrices: false });
      writePortfolioFile(PORTFOLIO, next);
      cache = undefined;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/sample" && req.method === "GET") {
      return send(res, 200, JSON.parse(readFileSync(join(root, "portfolio.example.json"), "utf8")));
    }
    const file = join(root, "public", url.pathname === "/" ? "index.html" : url.pathname.replace(/\.\./g, ""));
    if (req.method === "GET" && existsSync(file) && TYPES[extname(file)]) {
      return send(res, 200, readFileSync(file), TYPES[extname(file)]);
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Portfolio tracker on http://localhost:${PORT} (data: ${PORTFOLIO}${OFFLINE ? ", offline" : ""})`);
});
