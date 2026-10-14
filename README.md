# Portfolio tracker

Private tracker for Polish treasury bonds, stocks/ETFs and PKO DFE, with gains shown before and after Belka tax and IKE/IKZE/OKI accounts.

## Status
- Step 1 (done): bond calculator for all retail treasury bonds: OTS, ROR, DOR, TOS, COI, EDO, ROS, ROD.
- Step 2 (done): shares and ETFs with FIFO sells, commissions, dividends, foreign currency via NBP rates, live prices from stooq.pl with Yahoo Finance as fallback.
- Step 3 (done): per-instrument income in one report, PKO DFE priced from analizy.pl.
- Next: the web app.

## Try it
```
npm install
cp portfolio.example.json portfolio.json   # made-up sample; replace with your own holdings
npx tsx src/cli.ts                         # live prices, value as of today
npx tsx src/cli.ts --offline               # use the "prices" in the file instead
npx tsx src/cli.ts --date 2027-04-15       # bonds valued on another date
npm test
```

## Data
- `data/cpi.json`: GUS y/y CPI by month (from stat.gov.pl). Add each new month as GUS publishes it.
- `data/bond-series.json`: per-series terms from obligacjeskarbowe.pl (first-year rate, margin, early-redemption fee). For a series not listed, put `"terms": {"firstYearRate": .., "margin": .., "earlyFee": ..}` on the holding.
- `data/nbp-reference-rate.json`: NBP reference rate changes (for ROR/DOR), by effective date.

## Bond rules implemented (from the issue letters)
- Year 1 fixed rate; later years CPI y/y (announced the month before the period starts, i.e. two months back) + margin, CPI below 0 counts as 0.
- Periods run from the purchase-day anniversary; interest capitalised yearly, rounded to the grosz per bond.
- Mid-period accrual on actual days / days in the period.
- Capitalised bonds (EDO, ROS, ROD, TOS): early redemption fee deducted, never below the 100 zł nominal.
- Paid-out bonds (COI yearly, ROR/DOR monthly, OTS at maturity): fee capped at accrued interest in period 1, full fee from period 2. ROR/DOR rate = NBP reference rate in force 10 business days before the period's month + margin.
- OTS redeemed early returns only the nominal.
- No early-redemption fee on IKE/IKZE payouts.
- Belka: 19% of the gain, rounded to whole złoty; not applied on IKE/IKZE/OKI.

## Shares, ETFs and dividends
- `instruments`: symbol, currency, and optionally `stooq` / `yahoo` symbols (defaults: `cdr` and `CDR.WA` for GPW).
- `trades`: buys and sells per account; sells match buys first-in-first-out. Commissions are part of the cost.
- Foreign trades and dividends are converted at the NBP rate from the business day before (fetched automatically, or set `fxRate`).
- `dividends`: gross amount and tax withheld at source. On a regular account at least 19% is due in total.
- Gain = unrealised + realised + gross dividends; "Net Belka" is what's left after tax if everything were sold today. Belka is shown per instrument; in a real PIT-38 losses offset gains within the year.
- `prices`: manual prices, used with `--offline` or when no live price is found.

## PKO DFE and other funds
Add the fund as an instrument with its analizy.pl id (`"analizy": "EBAN2"` is PKO DFE) and record each contribution as a buy of units at the unit price, as shown on the PKO statement. IKZE holdings show no Belka; the 10% IKZE withdrawal tax is not modelled.
