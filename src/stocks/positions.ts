import { BELKA_RATE, belkaTax, type AccountType } from "../tax.js";
import type { IsoDate } from "../bonds/dates.js";

/**
 * Shares and ETFs. Each (symbol, account) pair is one position; sells are matched to
 * buys first-in-first-out, as Polish tax rules require. All gains are in PLN: foreign
 * trades are converted at the NBP rate from the business day before the trade
 * (pass it as fxRate), dividends likewise.
 */

export interface Instrument {
  symbol: string; // e.g. "CDR", "VWCE"
  name?: string;
  currency: string; // "PLN", "EUR", ...
  stooq?: string; // stooq symbol, default lower-case symbol (GPW)
  yahoo?: string; // Yahoo symbol, default SYMBOL.WA (GPW)
}

export interface Trade {
  symbol: string;
  account: AccountType;
  type: "buy" | "sell";
  date: IsoDate;
  quantity: number;
  price: number; // per share, instrument currency
  commission?: number; // instrument currency
  fxRate?: number; // PLN per unit of currency; 1 for PLN
}

export interface Dividend {
  symbol: string;
  account: AccountType;
  date: IsoDate;
  gross: number; // total, instrument currency
  withheldTax?: number; // total tax already withheld at source, instrument currency
  fxRate?: number;
}

export interface Quote {
  price: number; // instrument currency
  date: IsoDate;
  fxRate: number; // PLN per unit now
}

export interface Position {
  symbol: string;
  account: AccountType;
  quantity: number;
  costPln: number; // of shares still held, commissions included
  avgCost: number; // per share, PLN
  price?: number; // instrument currency
  priceDate?: IsoDate;
  valuePln?: number;
  unrealizedPln?: number;
  realizedPln: number;
  dividendsGrossPln: number;
  dividendsTaxPln: number;
  gainPln?: number; // unrealized + realized + gross dividends
  netGainPln?: number; // after Belka on gains and dividend tax, if all sold today
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

function fx(currency: string, rate: number | undefined, what: string): number {
  if (currency === "PLN") return 1;
  if (!rate) throw new Error(`${what}: fxRate (PLN per ${currency}) is required for foreign instruments`);
  return rate;
}

/** Tax on a dividend: at least 19% overall on a regular account; whatever was withheld elsewhere. */
export function dividendTax(grossPln: number, withheldPln: number | undefined, account: AccountType): number {
  if (account === "regular") return round2(Math.max(withheldPln ?? 0, grossPln * BELKA_RATE));
  return round2(withheldPln ?? 0);
}

export function buildPositions(
  instruments: Instrument[],
  trades: Trade[],
  dividends: Dividend[],
  quotes: Record<string, Quote | undefined>,
): Position[] {
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const keys = new Set([...trades, ...dividends].map((t) => `${t.symbol}|${t.account}`));
  const positions: Position[] = [];

  for (const key of keys) {
    const [symbol, account] = key.split("|") as [string, AccountType];
    const inst = bySymbol.get(symbol);
    if (!inst) throw new Error(`No instrument entry for ${symbol}`);

    const lots: { qty: number; costPerShare: number }[] = [];
    let realized = 0;
    const own = trades
      .filter((t) => t.symbol === symbol && t.account === account)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.type === "buy" ? -1 : 1));
    for (const t of own) {
      const rate = fx(inst.currency, t.fxRate, `${symbol} ${t.type} on ${t.date}`);
      const commission = (t.commission ?? 0) * rate;
      if (t.type === "buy") {
        lots.push({ qty: t.quantity, costPerShare: (t.quantity * t.price * rate + commission) / t.quantity });
        continue;
      }
      let left = t.quantity;
      let matchedCost = 0;
      while (left > 1e-9) {
        const lot = lots[0];
        if (!lot) throw new Error(`${symbol} (${account}): selling more than held on ${t.date}`);
        const take = Math.min(left, lot.qty);
        matchedCost += take * lot.costPerShare;
        lot.qty -= take;
        left -= take;
        if (lot.qty <= 1e-9) lots.shift();
      }
      realized += t.quantity * t.price * rate - commission - matchedCost;
    }

    const quantity = lots.reduce((a, l) => a + l.qty, 0);
    const costPln = round2(lots.reduce((a, l) => a + l.qty * l.costPerShare, 0));
    let dividendsGrossPln = 0;
    let dividendsTaxPln = 0;
    for (const d of dividends.filter((d) => d.symbol === symbol && d.account === account)) {
      const rate = fx(inst.currency, d.fxRate, `${symbol} dividend on ${d.date}`);
      const gross = d.gross * rate;
      dividendsGrossPln += gross;
      dividendsTaxPln += dividendTax(gross, d.withheldTax === undefined ? undefined : d.withheldTax * rate, account);
    }

    const position: Position = {
      symbol,
      account,
      quantity,
      costPln,
      avgCost: quantity ? round2(costPln / quantity) : 0,
      realizedPln: round2(realized),
      dividendsGrossPln: round2(dividendsGrossPln),
      dividendsTaxPln: round2(dividendsTaxPln),
    };

    const quote = quotes[symbol];
    if (quote || quantity === 0) {
      const valuePln = quote ? round2(quantity * quote.price * quote.fxRate) : 0;
      const unrealized = round2(valuePln - costPln);
      const capitalGain = round2(unrealized + position.realizedPln);
      Object.assign(position, {
        price: quote?.price,
        priceDate: quote?.date,
        valuePln,
        unrealizedPln: unrealized,
        gainPln: round2(capitalGain + position.dividendsGrossPln),
        netGainPln: round2(capitalGain - belkaTax(capitalGain, account) + position.dividendsGrossPln - position.dividendsTaxPln),
      });
    }
    positions.push(position);
  }
  return positions.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account.localeCompare(b.account));
}
