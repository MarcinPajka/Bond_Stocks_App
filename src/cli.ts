// Usage: npx tsx src/cli.ts [portfolio.json] [--offline] [--date YYYY-MM-DD]
import { join } from "node:path";
import { buildReport, cachePathFor, loadPortfolio, withKnownSources } from "./portfolio.js";
import { defaultDataDir } from "./storage.js";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".json")) ?? join(defaultDataDir(), "portfolio.json");
const dateIdx = args.indexOf("--date");
const report = await buildReport(withKnownSources(loadPortfolio(file)), {
  offline: args.includes("--offline"),
  asOf: dateIdx >= 0 ? args[dateIdx + 1] : undefined,
  cachePath: cachePathFor(file),
});

const zl = (x: number | undefined) => (x === undefined ? "—" : x.toFixed(2)).padStart(10);
const row = (cols: string[]) => console.log(cols.join("  "));

console.log(`Portfolio as of ${report.asOf}\n`);
console.log("BONDS");
row(["Series ", "Account", "  Qty", "      Cost", "     Value", "  Int.paid", "      Gain", " Net Belka", " If sold now (net gain)"]);
let total = { cost: 0, value: 0, gain: 0, net: 0 };
for (const r of report.bonds) {
  row([
    r.lot.series.padEnd(7), r.lot.account.padEnd(7), String(r.lot.quantity).padStart(5),
    zl(r.cost), zl(r.value), zl(r.interestPaid), zl(r.gain), zl(r.netGain), zl(r.redemptionNetGain),
  ]);
  const p = r.valuation.currentPeriod;
  console.log(`         period ${p.index}: ${p.rate.toFixed(2)}% ${p.basis ? `(${p.basis})` : "(fixed)"}`);
  total = { cost: total.cost + r.cost, value: total.value + r.value, gain: total.gain + r.gain, net: total.net + r.netGain };
}

console.log("\nSHARES, ETFs & FUNDS (PLN)");
row(["Symbol ", "Account", "  Qty", "      Cost", "     Value", "  Realised", " Dividends", "      Gain", " Net Belka", "  Price"]);
for (const p of report.positions) {
  row([
    p.symbol.padEnd(7), p.account.padEnd(7), String(+p.quantity.toFixed(4)).padStart(5),
    zl(p.costPln), zl(p.valuePln), zl(p.realizedPln), zl(p.dividendsGrossPln), zl(p.gainPln), zl(p.netGainPln),
    p.price === undefined ? "  no price" : `  ${p.price} (${p.priceDate})`,
  ]);
  total = {
    cost: total.cost + p.costPln, value: total.value + (p.valuePln ?? 0),
    gain: total.gain + (p.gainPln ?? 0), net: total.net + (p.netGainPln ?? 0),
  };
}

console.log(`\nTOTAL  cost ${total.cost.toFixed(2)}  value ${total.value.toFixed(2)}  gain ${total.gain.toFixed(2)}  after Belka ${total.net.toFixed(2)} zł`);
for (const w of report.warnings) console.log(`! ${w}`);
