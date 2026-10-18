# Portfolio tracker

Private tracker for Polish treasury bonds, stocks/ETFs and PKO DFE, with gains shown before and after Belka tax and IKE/IKZE/OKI accounts.

## Status
- Step 1 (done): bond calculator for all retail treasury bonds: OTS, ROR, DOR, TOS, COI, EDO, ROS, ROD.
- Step 2 (done): shares and ETFs with FIFO sells, commissions, dividends, foreign currency via NBP rates, live prices from stooq.pl with Yahoo Finance as fallback.
- Step 3 (done): per-instrument income in one report, PKO DFE priced from analizy.pl.
- Step 4 (done): local web app with a dashboard, account filter, before/after Belka toggle and forms to log everything.
- Step 5 (done): redesigned app with five pages, light/dark theme and a phone layout:
  - Overview: total value and gain, value history (a snapshot is saved each day the app is opened, in `portfolio-history.json`), allocation by asset class and account, upcoming bond payouts, rate resets and maturities, IKE/IKZE contribution limits for the year.
  - Holdings: sortable, filterable and searchable list with a per-instrument breakdown.
  - Income & tax: bond interest, dividends and realised gains per year, with Belka and the PIT-38 amount for regular accounts.
  - Bond outlook: each bond held to maturity under an inflation and NBP-rate assumption you set with sliders.
  - Entries: edit or delete any logged item, export and import the portfolio as JSON.

- Step 6 (done): selling and history:
  - Open any holding and press **Sell** (shares, ETFs, funds) or **Redeem early** (bonds). Part of a bond lot can be redeemed; it becomes its own entry. Sold and redeemed holdings are hidden from the list until you press "Show sold".
  - Value over time is rebuilt from your entries, for the whole portfolio (Overview, with 1M/3M/YTD/1Y/All) and for each holding (open its row). Bonds are valued day by day with the bond calculator; shares and ETFs use daily closes from Yahoo Finance and NBP exchange rates, kept in `price-history.cache.json`. Funds priced from analizy.pl have no history source, so their line uses your trade prices and the unit values the app has fetched since.

IKE/IKZE contributions are approximated from purchases made in those accounts, so reinvested sale proceeds count twice. Tick "self-employed" on the Overview page for the higher IKZE limit.

## Run the app
Needs Node.js 20 or newer (`node -v`). Ubuntu's apt ships Node 12, which is too old; install a current one with nvm:
```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal, then in this folder:
nvm install 22
```
Then:
```
npm install
npm start          # open http://localhost:5173
```
Your data is kept outside the app folder, so updating the app (`git pull`, or downloading it again) never touches it:
- Windows: `%APPDATA%\portfel\portfolio.json`
- macOS: `~/Library/Application Support/portfel/portfolio.json`
- Linux: `~/.local/share/portfel/portfolio.json`

The Entries page shows the exact path. Older versions kept `portfolio.json` next to the code; it is copied over automatically the first time a new version starts. Each save keeps the previous version as `portfolio.backup.json`, and a file saved by a newer, incompatible version of the app is never overwritten by an older one. `PORTFEL_DATA=/some/folder` moves the data folder; `PORTFOLIO=/path/file.json` uses another data file.

Use "Load sample data" to try it with made-up holdings. The server listens on localhost only. `OFFLINE=1 npm start` skips live prices and uses the manual `prices` in the file.

Foreign shares and ETFs can be entered in the currency you actually paid: if your broker charged you in złoty for VWCE, set the instrument's currency to PLN and enter złoty prices. The live price is read in the listing's own currency (EUR for VWCE.DE, as Yahoo reports it) and converted at today's NBP rate, so the gain is the real one in złoty.

Exchange rates change, so each entry keeps its own. When you add or edit a trade or dividend in a foreign currency, the form fills in the NBP rate from the business day before its date (the rate the tax office uses for Belka) and saves it with the entry; type your broker's rate over it if you prefer that. For an entry paid in złoty for something listed abroad, the form shows that day's rate and what your price was in the listing's currency. Current values always use today's NBP rate.

Each share or fund needs a price source: GPW shares need nothing; foreign ETFs need their stooq or Yahoo symbol; funds need their analizy.pl id (open the holding and press "Price source"). Instruments the app already knows from its sample list, such as PKODFE, get theirs filled in automatically.

## Command-line report
```
npx tsx src/cli.ts portfolio.example.json   # live prices, value as of today
npx tsx src/cli.ts --offline               # use the "prices" in the file instead
npx tsx src/cli.ts --date 2027-04-15       # bonds valued on another date
npm test
```

## Data
No market data is bundled with the app. Bond data is fetched while the app is online, and is saved to `market-data.cache.json` next to your portfolio file:
- **Series terms** (first-year rate, margin, early-redemption fee) are read from the series page on obligacjeskarbowe.pl the first time you add a bond of that series, so you only enter the series code, date and quantity. If a page can't be read, the app says so and you can enter the terms on the bond yourself.
- **Inflation** (full history) comes from the GUS monthly CPI table and the **NBP reference rate** history from NBP's rates archive XML, checked every 12 hours.
- If a bond needs a CPI month that isn't published or downloaded yet, the latest known month is used and the bond is flagged as estimated.

Offline mode uses whatever was last saved in the cache, so the app has to run online once before bonds can be valued offline.

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
- Foreign trades and dividends carry `fxRate` (PLN per unit of the currency). The app fills in the NBP rate from the business day before when you save one without it.
- `dividends`: gross amount and tax withheld at source. On a regular account at least 19% is due in total.
- Gain = unrealised + realised + gross dividends; "Net Belka" is what's left after tax if everything were sold today. Belka is shown per instrument; in a real PIT-38 losses offset gains within the year.
- `prices`: manual prices, used with `--offline` or when no live price is found.

## PKO DFE and other funds
Add the fund as an instrument with its analizy.pl id (`"analizy": "EBAN2"` is PKO DFE) and record each contribution as a buy of units at the unit price, as shown on the PKO statement. IKZE holdings show no Belka; the 10% IKZE withdrawal tax is not modelled.
