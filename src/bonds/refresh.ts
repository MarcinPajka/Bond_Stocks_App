import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { httpFetch, type Fetcher } from "../prices/providers.js";
import { addMonths, type IsoDate } from "./dates.js";
import { PRODUCTS, type SeriesTerms } from "./bond.js";
import type { BondData } from "./lot.js";

/**
 * Keeps bond data current from the official sources, on the machine running the app:
 *  - series terms (first-year rate, margin, early-redemption fee) from each series page
 *    on obligacjeskarbowe.pl, fetched the first time a series is used
 *  - y/y CPI from the GUS monthly CPI table
 *  - the NBP reference rate from NBP's rates XML
 * Everything fetched is stored in a cache file so it is only downloaded once.
 */

const SERIES_URL = "https://www.obligacjeskarbowe.pl/oferta-obligacji";
const PRODUCT_SLUGS: Record<string, string> = {
  OTS: "obligacje-3-miesieczne-ots",
  ROR: "obligacje-roczne-ror",
  DOR: "obligacje-2-letnie-dor",
  TOS: "obligacje-3-letnie-tos",
  COI: "obligacje-4-letnie-coi",
  ROS: "obligacje-6-letnie-ros",
  EDO: "obligacje-10-letnie-edo",
  ROD: "obligacje-12-letnie-rod",
};
const GUS_CPI_URL =
  "https://stat.gov.pl/obszary-tematyczne/ceny-handel/wskazniki-cen/wskazniki-cen-towarow-i-uslug-konsumpcyjnych-pot-inflacja-/miesieczne-wskazniki-cen-towarow-i-uslug-konsumpcyjnych-od-1982-roku";
const NBP_RATES_URL = "https://static.nbp.pl/dane/stopy/stopy_procentowe.xml";
const REFRESH_EVERY_MS = 12 * 3600_000;

export interface MarketCache {
  series: Record<string, SeriesTerms>;
  cpi: Record<string, number>;
  nbpReference: Record<IsoDate, number>;
  checkedAt?: { cpi?: number; nbp?: number };
}

const num = (s: string) => Number(s.replace(/\s/g, "").replace(",", "."));

export function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ");
}

/** Month the series was sold in, from its code: PPPmmyy is the maturity month. */
export function saleMonth(series: string): IsoDate {
  const code = series.toUpperCase();
  const product = PRODUCTS[code.slice(0, 3)];
  const m = code.match(/^[A-Z]{3}(\d{2})(\d{2})$/);
  if (!product || !m) throw new Error(`Not a bond series code: ${series}`);
  return addMonths(`20${m[2]}-${m[1]}-01`, -product.periods * product.periodMonths);
}

export function parseSeriesPage(html: string, series: string): SeriesTerms {
  const text = pageText(html);
  const code = series.toUpperCase();
  const product = PRODUCTS[code.slice(0, 3)];

  const rateMatch =
    text.match(/(\d+,\d+)\s*%,?\s*(?:w skali roku,?\s*)?w pierwszym/) ??
    text.match(/oprocentowanie wynosi (\d+,\d+)\s*% w skali roku/) ??
    text.match(/pierwszym[^.]{0,80}?wynosi (\d+,\d+)\s*%/) ??
    text.match(/Oprocentowanie:?\s*(\d+,\d+)\s*%/);
  if (!rateMatch) throw new Error(`Could not find the interest rate on the ${code} page`);

  let margin = 0;
  if (product.rate !== "fixed") {
    const m = text.match(/marża (\d+,\d+)\s*%/) ?? text.match(/referencyjna NBP\s*\+\s*(\d+,\d+)\s*%/);
    if (m) margin = num(m[1]);
    else if (product.rate === "cpi") throw new Error(`Could not find the margin on the ${code} page`);
  }

  let earlyFee = 0;
  if (code.slice(0, 3) !== "OTS") {
    const before = text.match(/do 31 sierpnia 2024 r\. opłata wynosi (\d+,\d+) zł/);
    const after = text.match(/od 1 września 2024 r\. opłata wynosi (\d+,\d+) zł/);
    const single = text.match(/[Oo]płat\S*?,? (?:która )?wynosi (\d+,\d+) zł/);
    const fee = before && after ? (saleMonth(code) < "2024-09-01" ? before : after) : single;
    if (!fee) throw new Error(`Could not find the early-redemption fee on the ${code} page`);
    earlyFee = num(fee[1]);
  }
  return { firstYearRate: num(rateMatch[1]), margin, earlyFee };
}

export async function fetchSeriesTerms(series: string, get: Fetcher = httpFetch): Promise<SeriesTerms> {
  const code = series.toUpperCase();
  const slug = PRODUCT_SLUGS[code.slice(0, 3)];
  if (!slug) throw new Error(`Unknown bond product in ${series}`);
  return parseSeriesPage(await get(`${SERIES_URL}/${slug}/${code.toLowerCase()}/`), code);
}

/**
 * y/y CPI by month from the GUS block "Analogiczny miesiąc poprzedniego roku = 100".
 * On stat.gov.pl all blocks share one table and a block's heading sits in a cell of its
 * first data row (or between rows), with irregular whitespace, so rows are read in order and each
 * "... = 100" heading switches the current block.
 */
export function parseGusCpiPage(html: string): Record<string, number> {
  const out: Record<string, number> = {};
  let inYoy = false;
  let found = false;
  let last = 0;
  for (const m of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const row = m[0];
    const between = pageText(html.slice(last, m.index)); // headings placed outside the table rows
    last = m.index + row.length;
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((c) => pageText(c).trim());
    const heading = cells.find((c) => /=\s*100\b/.test(c)) ?? (/=\s*100\b/.test(between) ? between : undefined);
    if (heading) {
      inYoy = /analogiczny\s+miesi\S*\s+poprzedniego\s+roku/i.test(heading);
      found ||= inYoy;
    }
    if (!inYoy) continue;
    const yearIdx = cells.findIndex((c) => /^(19|20)\d{2}$/.test(c));
    if (yearIdx < 0) continue;
    cells.slice(yearIdx + 1, yearIdx + 13).forEach((c, i) => {
      if (/^\d+(,\d+)?$/.test(c)) out[`${cells[yearIdx]}-${String(i + 1).padStart(2, "0")}`] = Math.round((num(c) - 100) * 10) / 10;
    });
  }
  if (!found) throw new Error("GUS page: y/y CPI table not found");
  if (Object.keys(out).length === 0) throw new Error("GUS page: no CPI values found");
  return out;
}

export function parseNbpRatesXml(xml: string): { date: IsoDate; rate: number } {
  const tag = xml.match(/<pozycja[^>]*\bid="ref"[^>]*>/);
  const rate = tag?.[0].match(/oprocentowanie\s*=\s*"([\d,]+)"/);
  const date = tag?.[0].match(/obowiazuje_od\s*=\s*"(\d{4}-\d{2}-\d{2})"/);
  if (!rate || !date) throw new Error("NBP rates XML: reference rate not found");
  return { date: date[1], rate: num(rate[1]) };
}

export function loadCache(path: string): MarketCache {
  if (!existsSync(path)) return { series: {}, cpi: {}, nbpReference: {} };
  return { series: {}, cpi: {}, nbpReference: {}, ...JSON.parse(readFileSync(path, "utf8")) };
}

/** Bundled data overlaid with whatever has been fetched. */
export function mergeData(bundled: BondData, cache: MarketCache): BondData {
  return {
    series: { ...bundled.series, ...cache.series },
    cpi: { ...bundled.cpi, ...cache.cpi },
    nbpReference: { ...bundled.nbpReference, ...cache.nbpReference },
  };
}

/**
 * Fetches what is missing or stale and saves it to the cache. Problems become warnings;
 * the bundled data still works without them.
 */
export async function refreshBondData(
  bundled: BondData,
  cachePath: string | undefined,
  neededSeries: string[],
  get: Fetcher = httpFetch,
  now = Date.now(),
): Promise<{ data: BondData; warnings: string[] }> {
  const cache = cachePath ? loadCache(cachePath) : { series: {}, cpi: {}, nbpReference: {} };
  const warnings: string[] = [];
  let changed = false;

  const known = mergeData(bundled, cache).series;
  for (const s of new Set(neededSeries.map((x) => x.toUpperCase()))) {
    if (known[s]) continue;
    try {
      cache.series[s] = await fetchSeriesTerms(s, get);
      changed = true;
    } catch (e) {
      warnings.push(`${s}: couldn't fetch its terms from obligacjeskarbowe.pl (${(e as Error).message}). Enter them on the bond instead.`);
    }
  }

  cache.checkedAt ??= {};
  if (now - (cache.checkedAt.cpi ?? 0) > REFRESH_EVERY_MS) {
    try {
      Object.assign(cache.cpi, parseGusCpiPage(await get(GUS_CPI_URL)));
      cache.checkedAt.cpi = now;
      changed = true;
    } catch (e) {
      warnings.push(`Inflation data not updated from GUS (${(e as Error).message})`);
    }
  }
  if (now - (cache.checkedAt.nbp ?? 0) > REFRESH_EVERY_MS) {
    try {
      const { date, rate } = parseNbpRatesXml(await get(NBP_RATES_URL));
      cache.nbpReference[date] = rate;
      cache.checkedAt.nbp = now;
      changed = true;
    } catch (e) {
      warnings.push(`NBP reference rate not updated (${(e as Error).message})`);
    }
  }

  if (changed && cachePath) writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return { data: mergeData(bundled, cache), warnings };
}
