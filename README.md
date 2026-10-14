# Portfolio tracker

Private tracker for Polish treasury bonds, stocks/ETFs and PKO DFE, with gains shown before and after Belka tax and IKE/IKZE/OKI accounts.

## Status
Step 1 of 4: bond calculator. All current retail treasury bonds are supported: OTS, ROR, DOR, TOS, COI, EDO, ROS, ROD.

## Try it
```
npm install
cp holdings.example.json holdings.json   # edit with your own bonds
npx tsx src/cli.ts                       # value as of today
npx tsx src/cli.ts holdings.json 2027-04-15
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
