import { readFileSync } from "node:fs";
import type { BondData } from "../../src/bonds/lot.js";

/** Terms, CPI and NBP rates for tests, so they don't depend on the live sites. */
export function testMarketData(): BondData {
  const { series, cpi, nbpReference } = JSON.parse(readFileSync(new URL("./market-data.json", import.meta.url), "utf8"));
  return { series, cpi, nbpReference };
}
