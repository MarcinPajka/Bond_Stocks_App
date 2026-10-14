# Portfolio tracker

Private tracker for Polish treasury bonds, stocks/ETFs and PKO DFE, with gains shown before and after Belka tax and IKE/IKZE/OKI accounts.

## Status
Step 1 of 4: bond calculator. EDO (10-year, inflation-indexed) is implemented; other bond types follow.

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
- `data/bond-series.json`: per-series terms from obligacjeskarbowe.pl (first-year rate, margin, early-redemption fee).

## EDO rules implemented
- Year 1 fixed rate; later years CPI y/y (announced the month before the period starts, i.e. two months back) + margin, CPI below 0 counts as 0.
- Periods run from the purchase-day anniversary; interest capitalised yearly, rounded to the grosz per bond.
- Mid-period accrual on actual days / days in the period.
- Early redemption: fee per bond deducted, never below the 100 zł nominal.
- Belka: 19% of the gain, rounded to whole złoty; not applied on IKE/IKZE/OKI.
