// Usage: npx tsx src/cli.ts [holdings.json] [YYYY-MM-DD]
import { readFileSync } from "node:fs";
import { loadBondData, valueLot, type BondLot } from "./bonds/lot.js";
import { today } from "./bonds/dates.js";

const file = process.argv[2] ?? "holdings.json";
const asOf = process.argv[3] ?? today();
const holdings: { bonds: BondLot[] } = JSON.parse(readFileSync(file, "utf8"));
const data = loadBondData();
const zl = (x: number) => x.toFixed(2).padStart(10);

console.log(`Valuation as of ${asOf}\n`);
for (const lot of holdings.bonds) {
  const r = valueLot(lot, data, asOf);
  const p = r.valuation.currentPeriod;
  const why = p.basis ?? "fixed";
  console.log(`${lot.series} x${lot.quantity} (${lot.account}), bought ${lot.purchaseDate}`);
  console.log(`  period ${p.index}: ${p.start} → ${p.end}, ${p.rate.toFixed(2)}% (${why})`);
  console.log(`  cost           ${zl(r.cost)} zł`);
  console.log(`  value          ${zl(r.value)} zł   (${r.valuation.valuePerBond.toFixed(2)} per bond)`);
  if (r.interestPaid) console.log(`  interest paid  ${zl(r.interestPaid)} zł`);
  console.log(`  gain           ${zl(r.gain)} zł   after Belka ${zl(r.netGain)} zł`);
  console.log(`  if redeemed now${zl(r.redemptionValue)} zł   gain after Belka ${zl(r.redemptionNetGain)} zł\n`);
}
