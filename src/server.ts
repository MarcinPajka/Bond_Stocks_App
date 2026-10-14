// Local, private web app: npm start, then open http://localhost:5173
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, type PortfolioFile } from "./portfolio.js";
import { toRows } from "./view.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const PORTFOLIO = process.env.PORTFOLIO ?? join(root, "portfolio.json");
const OFFLINE = process.env.OFFLINE === "1";
const PORT = Number(process.env.PORT ?? 5173);
const CACHE_MS = 5 * 60_000;

const readPortfolio = (): PortfolioFile => (existsSync(PORTFOLIO) ? JSON.parse(readFileSync(PORTFOLIO, "utf8")) : {});

let cache: { key: string; at: number; body: unknown } | undefined;

async function report(date: string | undefined, refresh: boolean) {
  const portfolio = readPortfolio();
  const key = JSON.stringify([portfolio, date]);
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.body;
  const r = await buildReport(portfolio, { offline: OFFLINE, asOf: date });
  const names = Object.fromEntries((portfolio.instruments ?? []).map((i) => [i.symbol, i.name]));
  const body = { asOf: r.asOf, rows: toRows(r, names), warnings: r.warnings, offline: OFFLINE };
  cache = { key, at: Date.now(), body };
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
      return send(res, 200, await report(url.searchParams.get("date") ?? undefined, url.searchParams.has("refresh")));
    }
    if (url.pathname === "/api/portfolio" && req.method === "GET") return send(res, 200, readPortfolio());
    if (url.pathname === "/api/portfolio" && req.method === "PUT") {
      const next: PortfolioFile = JSON.parse(await readBody(req));
      await buildReport(next, { offline: true }); // reject data the calculators can't handle
      writeFileSync(PORTFOLIO, JSON.stringify(next, null, 2));
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
