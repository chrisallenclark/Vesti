# Build Status

Updated at every phase boundary. Ordered **trading-first**: reach validated paper
trading before building the research/AI layer.

---

## Where things stand

**Phase 0 (Foundations) — complete.** The database enforces every invariant the
rest of the system depends on. 25 automated assertions pass against a database
built from nothing.

**Phase 5's deterministic core is complete and ahead of schedule** — risk engine,
synthetic market generator, broker adapter, and execution gate — because none of
it needs network access or a broker key, and because everything downstream
depends on it being correct.

**The order lifecycle now writes to the database.** Fills land in `lots`,
`cash_ledger` and `order_lot_allocations` under specific-lot rules, so mandate
isolation is an executed guarantee rather than a schema property nothing had
ever exercised. An Active exit for 100 shares fails when Active holds 40 — even
though the account holds 540 and the broker would sell them.

**Real market data is loaded and the PIT layer is verified against it.** Daily
bars for 17 names with nine real splits among them, checked against the vendor's
own split-adjusted series rather than against our own generator. That
verification ran on the IEX archive (2020-07-27 onward); the tape has since moved
to consolidated SIP back to 2016-01-04 (D-032), which widens the same check
rather than changing it.

**The autonomous loop exists and refuses to trade for the right reasons.**
One command runs a session: reconcile, check the kill switch, catch up on
fills, evaluate promoted strategies, size, submit, mark equity. It halts on a
drifted ledger, a tripped switch, a closed market, or an unpromoted strategy —
and marks the equity curve even when it halts, because a gap in the curve
cannot be filled in later.

**A paper trade has been placed through the whole chain.** 1 AAPL bought at
$305.27 and sold at $305.02 on the Alpaca paper account, via intent → risk
ruling → execution gate → venue → fill → lot → cash → reconciliation. Realised
−$0.25; Alpaca's cash moved by exactly −$0.25 and so did the mandate's ledger.
**273 tests pass** across five packages.

No strategy exists yet, so nothing decides *what* to trade. That is Phase 4 —
see *Honest limitations* below.

---

## Phases

**The target: Phase 6.** All three mandates paper trading autonomously against
live market data, with equity curves and benchmark comparison per mandate — so
the question "does this actually make money?" has a measured answer.

Reaching that required a **correction to the phase order**. The original
sequence built the technical engine (Active mandate only) before paper trading,
and left fundamentals and catalysts until Phase 7 — which would have delivered
one portfolio trading and two sitting idle.

The correction is cheap because **no mandate needs the AI layer to trade**:

- **Active** — technical setups from price and volume.
- **Long-Term** — deterministic quality and valuation screens (ROIC, FCF growth,
  balance sheet, valuation percentile) straight from EDGAR XBRL.
- **Catalyst** — deterministic event rules (known catalyst inside a window,
  prior-evidence strength, binary-event position sizing) from ClinicalTrials.gov,
  openFDA, and earnings calendars.

All three are falsifiable without a single model call. The AI layer deepens the
research later; it is not a prerequisite for measuring whether the approach works.

| Phase | Deliverable | Status |
|---|---|---|
| **0** Foundations | Schema, bitemporal PIT layer, roles + RLS, immutability, job runner, AI cost ledger, docs | ✅ **complete** |
| **1** Portfolio spine + design system | Auth, mandates, accounts, lot-level positions, manual entry, risk settings, journal, mobile shell, component library | 🔨 **in progress** |
| **2** Data for all three mandates | Prices + corporate actions + calendars; **EDGAR XBRL fundamentals**; **catalyst calendar** (CT.gov, openFDA, earnings) | 🔨 **prices done and deepened; EDGAR validated live, not yet ingested** — prices now come from the full consolidated tape back to 2016 (D-032), and the EDGAR parser has been run against 21,936 real facts with zero rejections. Catalysts remain |
| **3** Feature engines | Technical features + patterns (Active); fundamental quality/valuation features (Long-Term); catalyst proximity & magnitude features (Catalyst); forward labeling for all three | ⬜ |
| **4** Strategy Lab | Backtester, walk-forward, Monte Carlo, regime engine, benchmarks, trial ledger, promotion gates — **one strategy family per mandate**, validated identically | ⬜ |
| **5** Paper trading | `BrokerAdapter` + `SimBroker` + Alpaca paper, risk engine, order lifecycle, post-trade review, kill switch, reconciliation | ✅ **complete** — engine, simulator, gate, Alpaca paper adapter, DB order lifecycle, kill switch and reconciliation, all tested and exercised on a real round trip. Post-trade review moves to Phase 6, where there are trades to review |
| **6** **Autonomous paper — the goal** | Signal → construction → risk → execution loop running unattended across **all three mandates**; per-mandate equity curves, benchmark comparison, attribution, calibration scoring | 🔨 **loop built** — one command runs a full session with promotion gate, kill switch, reconciliation gate and per-mandate equity snapshots; it has nothing validated to run, and benchmark/attribution reporting remains |
| **7** Evidence + AI intelligence | Full document pipeline, model router, thesis versioning, conviction scoring, briefs, alerts — *deepens* the mandates rather than enabling them | ⬜ |
| **8** Discovery & graph | Opportunity discovery, second-order relationships, knowledge graph, "What did I notice?" | ⬜ |
| **9** Controlled live | Alpaca live adapter, L3 human-approved, then L4 tiny autonomous | ⬜ |

### What "does it work?" will actually mean at Phase 6

Two independent readings, because either alone is misleading:

1. **Backtest** (Phase 4) — an immediate historical answer over years of data,
   with walk-forward validation and a trial-count penalty so the Lab cannot
   manufacture an edge by trying many variants.
2. **Forward paper** (Phase 6) — real-time, against live prices, which is the
   only thing that proves the backtest was not fantasy.

**An honest caveat worth setting now:** forward paper trading takes real time.
Three months at Active-mandate frequency might produce 20–40 trades — enough to
detect a catastrophic strategy, nowhere near enough to confirm a good one. The
Catalyst and Long-Term mandates trade far less often, so their forward samples
will be smaller still. The backtest is what provides statistical weight; forward
paper is what provides honesty. The scorecard will show sample size and
confidence alongside every return figure, so a good-looking month is never
mistaken for evidence.

---

## Phase 0 — what was built

### Migrations (`packages/db/migrations/`)

| File | Contents |
|---|---|
| `001_foundation.sql` | pgcrypto/btree_gist/citext, shared enums, `users`, hash-chained `audit_log` + `vesti_verify_audit_chain()` |
| `002_reference_and_market_data.sql` | `sources` (tiered), `securities` (asset_class + `instrument_terms` extension point), `security_identifiers`, `exchange_sessions`, bitemporal `corporate_actions`, partitioned `bars_daily` / `bars_intraday` / `bar_features` |
| `003_pit_layer.sql` | `pit_universe`, `pit_split_factor`, `pit_bars_daily`, `pit_bars_intraday`, `pit_corporate_actions`, `pit_bar_features` — all `SECURITY DEFINER` with pinned `search_path` |
| `004_portfolio_risk_strategy.sql` | `mandates`, `accounts`, `cash_ledger`, `lots`, risk tables, `strategies`/`strategy_versions`, `setups`/`setup_versions`, `orders`, `fills`, `order_lot_allocations`, `pre_trade_records`, `decision_snapshots`, `post_trade_reviews`, `journal_entries` |
| `005_roles_rls_immutability.sql` | Four roles + grants, RLS policies, append-only triggers, `orders_risk_gate` |
| `006_jobs_and_ai_ledger.sql` | `jobs` + `vesti_claim_jobs`/`vesti_fail_job`/`vesti_reclaim_expired_jobs`, `ai_calls`, `ai_model_pricing`, `ai_budgets`, `vesti_ai_cost`, `vesti_ai_budget_check` |
| `007_synthetic_source.sql` | `sources` row for generated data, tiered lowest so nothing synthetic can outrank a real print |
| `008_partition_provisioning.sql` | Partition functions as `SECURITY DEFINER`, so ingest can provision without holding `CREATE` on the schema |
| `009_fill_idempotency.sql` | Partial unique index on `fills (order_id, broker_fill_id)` — the deduplication key for replayed broker fills |
| `010_equity_and_reconciliation.sql` | `equity_snapshots` (the daily per-mandate mark) and `reconciliation_runs` |
| `011_fundamentals.sql` | Bitemporal `fundamental_facts` + `pit_fundamental_facts()` — XBRL with restatement history |

### Verified behaviour

All 25 assertions in `packages/db/src/invariants.test.ts` pass against a freshly
created database:

**Point-in-time (4)** — raw price before a split is announced; correct
back-adjustment after; future bars invisible; delisted names present in the
universe on dates they were listed.

**Role isolation (4)** — backtest role denied `bars_daily`, `bars_intraday`,
`securities`, `corporate_actions`; backtest role succeeds through PIT functions;
research role denied writes to orders and lots; app role denied writes to orders.

**Append-only (8)** — `UPDATE` and `DELETE` rejected on all seven protected
tables; audit chain detects tampering that bypasses the trigger.

**Mandate isolation and risk gate (5)** — order without an evaluation rejected;
order exceeding approved quantity rejected; evaluation for a different mandate
rejected; properly approved order admitted; Active-mandate exit cannot allocate a
Long-Term lot.

**Cost control and jobs (4)** — model pricing matches published rates
($30/MTok pair on Opus 5, 50% batch discount, 0.1× cache reads); budget gate
flips to `may_dispatch = false` once exhausted; no job claimed by two workers;
poison job retires to `dead` rather than looping.

---

## Real market data — what the verification actually establishes

The synthetic pipeline test proves the PIT layer is right about data we
generated. It cannot prove the generator and the adjustment do not share a
misconception. `packages/ingest/src/real-pit.test.ts` closes that: it ingests
real bars through the real path and compares the reconstruction to **Alpaca's
own split-adjusted series**, fetched by a separate implementation so the two
sides of the comparison are genuinely independent.

6,048 sessions across AAPL, AMZN, NVDA and TSLA reconstruct to within the cent
the vendor rounds to. NVDA carries a split factor of exactly 40 before both its
splits — the assertion that separates compounding two ratios from applying the
nearer one, which is the failure mode that still yields a smooth, plausible,
entirely fictional price series.

Three defects surfaced that synthetic data could not have shown:

1. **Splits were dated as knowable on the day they took effect.** Alpaca
   publishes no declaration date, and its `process_date` turns out to equal the
   ex-date on every split observed. Apple's 4:1 was therefore "announced"
   2020-08-31, a month after the market was told — so a backtest standing in
   that window read prices no trader ever saw. Announcement is now the earliest
   vendor date that cannot precede the declaration (record, payable, process,
   ex). Still late, never early.
2. **Corporate actions were fetched unpaginated**, silently truncating at 1,000
   rows. A missing split leaves the discontinuity it was meant to explain, and
   the series reads as a real 75% overnight collapse.
3. **The CLI could not write `corporate_actions` at all** — bars only, which is
   the half that produces those cliffs.

## EDGAR fundamentals

Built, tested offline, and now **validated against live EDGAR**. The egress
policy that blocked `www.sec.gov` and `data.sec.gov` has been lifted, and the
parser was run against real filings rather than fixtures:

| | |
|---|---|
| Filers | AAPL, MSFT, JNJ, MRNA, BRK.A, F |
| Facts extracted | 21,936 |
| Rejected by `validateFact` | **0** |
| Filing dates spanned | 2009-07-22 → 2026-08-10 |
| Restated series detected | 1,352 on AAPL alone |
| `INGESTED_CONCEPTS` present | 35 / 36 |

The one concept never seen — `InterestIncomeExpenseNet` — is a
financial-sector tag, and none of these six are banks; it is unexercised rather
than wrong. Two things worth noting from the run: fundamentals reach back to
**2009**, considerably deeper than price history, so the Long-Term mandate is
not history-limited; and real filers exercise the restatement path heavily,
which is exactly what the bitemporal design exists for.

Still not *ingested into Postgres* — that is a database run, not a code
question, and the code path it needs is now proven end to end.

**Fundamentals are where point-in-time discipline actually bites.** A price is
knowable the instant it prints, so a sloppy price pipeline misaligns a bar. A
financial fact describes a period that ended weeks before anyone outside the
company saw it: Q4 revenue is true on 31 December and public in February. A
screen that reads December's revenue in December knows the future, and it will
produce a strategy that looks superb and cannot be traded. So `period_end`
(when it became true) and `filed_at` (when it became knowable) are separate
columns, and `pit_fundamental_facts()` filters on the second.

**Restatements make it genuinely bitemporal.** Companies revise prior periods
under a new accession months or years later. Overwriting the old value would
make history change retroactively — a backtest run today would see numbers
nobody had, and the same backtest run last year would have seen different ones.
Every version is kept, and the PIT function returns the newest one filed by the
as-of instant. A screen standing in early 2023 sees 2023's understanding of
2022; standing today it sees the correction. Both are right.

**Two guards against the most flattering bug available here.** A fact filed
before the period it reports had ended is look-ahead with a timestamp on it, and
it is rejected by the validator *and* by a `CHECK` constraint — the second is
why a bug in the first cannot quietly admit one. And `observed_at` is the end of
the filing day rather than its start, because filings are accepted through the
afternoon and midnight would claim the market knew a 10-K before it opened.

**Raw tags only.** Filers use different us-gaap concepts for the same quantity
— `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`,
`SalesRevenueNet` — and the mapping lives in code, resolved at read time.
Canonicalising at write time would bake one interpretation into permanent
storage, the same mistake as an adjusted close, and revising it would mean
re-ingesting a decade of filings.

## The order lifecycle

`packages/execution/` posts fills into the ledger under specific-lot rules.

**Mandate isolation, executed.** Lot selection is scoped to the *order's*
mandate, so an exit cannot see another mandate's shares, let alone consume them.
The `order_lot_allocations` trigger checks it again on the way in, and a test
writes an allocation directly — bypassing every line of application code — to
confirm the database still refuses. Realised P&L is charged against the selling
mandate's own cost basis, so a tactical trade cannot book a multi-year holding's
gain.

**Fills are idempotent.** Brokers replay; the unique index turns a redelivery
into a collision. Deduplication runs *before* the state and quantity checks,
because the commonest replay is the final fill of an order that is already
`filled` — checking state first rejects it as an error when it needs no action
at all.

**Cash is a ledger.** Signed entries per fill, fees as their own rows,
attributed to the mandate that traded. The balance is a fold, so it cannot drift
from its entries.

## Running it unattended

```bash
npm run session -w @vesti/execution -- --status      # what it would do, and why not
npm run session -w @vesti/execution -- --deposit 100000
npm run session -w @vesti/execution -- --register
npm run session -w @vesti/execution                  # one session
npm run session -w @vesti/execution -- --halt "reason"
npm run session -w @vesti/execution -- --resume "reason"
```

**Five refusals, all tested against a real database.** A drifted ledger, a
tripped kill switch, a closed market, an unpromoted strategy, a position sized
below one share. Every one of them marks the equity curve anyway.

**The promotion gate is what makes this safe to leave running.** A strategy
trades only at `paper_approved` or above; registration puts it at
`experimental`, promotion moves one rung at a time with a mandatory rationale,
and live is not reachable by this route at all. **The role that trades cannot
promote** — `vesti_execution` has no write access to `strategies`, so the
registry connects as `vesti_research`. An execution service able to authorise
its own strategies would make the ladder decorative.

**The kill switch is now a control rather than a claim.** It can be tripped,
it halts the session and the gate refuses orders while it is set, a second trip
does not bury the first reason, and resetting requires quoting that reason back
— because the way a kill switch fails is being cleared by whoever is most
inconvenienced by it before anybody established what happened.

**Capital is asserted, never inferred.** `--deposit` records an external
contribution and splits it across mandates by target weight, double-entry, so
the mandates always sum to the account. Reading the broker's balance and making
ours match would paper over exactly the drift reconciliation exists to catch: an
unrecorded fill and a real deposit both look like "our number is low".

## The first paper trade

`npm run paper -w @vesti/execution -- --symbol AAPL --quantity 1 --mandate active`

No test doubles anywhere in that path, which is the only reason running it
proves anything. The engine sized 5 shares from a $75 risk budget against a
$292.98 stop; we asked for 1 and got the smaller of the two. Bought $305.27,
sold $305.02, realised −$0.25. Alpaca's cash went 100,000.00 → 99,999.75 and the
Active mandate's ledger reads −0.25. The lot opened at a $305.27 basis, closed
to zero with a timestamp, and the exit named it in `order_lot_allocations`.
Audit chain intact across all eleven rows.

Three defects surfaced that no test had:

1. **Requests failed with a 503 that was not Alpaca's.** First read as a venue
   blip; it is the sandbox's egress proxy answering `DNS resolution failure`,
   and it *latches for the lifetime of the process* — one Node process failed
   six consecutive reads while a neighbouring one succeeded six. Retrying
   inside the process cannot fix it, so the adapter names the cause instead of
   blaming the venue. It still retries genuine 5xx, 429 and transport errors,
   and resolves a duplicate `client_order_id` to the order that already exists,
   which is what makes retrying a POST safe.
2. **The trade-updates stream sends JSON inside BINARY frames.** Left at the
   default `blob`, every message decoded to the literal string `"[object Blob]"`
   and the stream silently delivered nothing. The first live order filled anyway
   — the poller caught it — which is precisely the failure a fallback is meant
   to hide, and precisely why it must not be the only thing that works.
3. **Portfolio state fed the risk engine cost basis where it expects market
   value.** The engine derives sellable size from market value over the
   reference price, so exiting a position whose price had moved came back as
   0.99 shares and was refused for being under one share. A profitable position
   could not have been closed at all.

**Reconciliation is the falsifiability check.** Our per-mandate lots and the
broker's single omnibus number are computed by different code from different
state; a test runs `SimBroker` across three sessions, posts every fill through
the ledger, and requires the two to agree on both position and cash. It reports
rather than repairs — a drift means a fill we missed, one applied twice, or an
unprocessed corporate action, and writing one number over the other destroys the
evidence needed to tell them apart.

## What is needed from outside

Things no amount of code here can supply.

1. ~~**Allowlist `www.sec.gov` and `data.sec.gov`.**~~ **Done.** Both are
   reachable and the EDGAR layer has been exercised against real filings. Note
   for anyone reading a 403 from SEC in future: SEC refuses requests without a
   real contact in the `User-Agent`, and that refusal looks identical to a
   policy denial. `EdgarClient` sets one and requires it at construction.
   `clinicaltrials.gov` and `api.fda.gov` are reachable too, so Catalyst is
   unblocked whenever it is built.
2. **A persistent Postgres.** This container is ephemeral and takes the
   database with it. Code is pushed; data is not. **This is now the single
   binding external constraint** — every other blocker on this list has cleared.
3. **A host and a scheduler** for the daily session. A fresh process per run is
   also the recovery path for the proxy DNS latch described below.

## Honest limitations

Worth stating plainly, because the gap between "foundations complete" and
"working system" is where optimism usually creeps in.

1. **Nothing decides what to trade.** The risk engine can size and veto, the
   simulator can fill, the gate can refuse — but no strategy produces an intent
   for any of them to act on. The Strategy Lab is Phase 4, and a legitimate
   outcome of it is *"none of these setups have an edge"* — that is a finding,
   not a failure.
2. **The loop has nothing validated to run.** `active.trend_pullback` exists so
   the interface is exercised by an implementation rather than a stub. It has
   been through no backtest, no walk-forward, no regime stratification and no
   trial-count deflation, because none of those exist yet. It ships at
   `experimental` and the loop will not touch it until somebody promotes it by
   hand. If it is promoted and makes money for a month, that is not evidence —
   twenty trades cannot separate an edge from luck.
3. **Two mandates cannot trade one symbol in opposite directions.** Legal in our
   model, a wash trade at a single omnibus account. `selfcross.ts` detects it
   and refuses before submission, which is better than a cryptic venue
   rejection, but detection is not a solution. The answer is to net internally —
   cross the shares between mandates at the prevailing price and send only the
   residual — and that changes what a fill means, since an internal cross has no
   broker fill to reconcile against. Deferred to the Phase 6 execution loop
   deliberately rather than by omission.
4. **Only the Active mandate has a strategy at all.** The Long-Term screen now
   has a data layer waiting for it, but no facts in it and no screen written
   against it; Catalyst still needs the event calendar. Two of the three
   mandates cannot produce a signal whatever the loop does.
5. **The EDGAR layer has never spoken to EDGAR.** Its parsing is written against
   the documented `companyfacts` shape and exercised against a fixture in that
   shape — which proves the code is self-consistent, not that the shape is
   right. The same class of gap the synthetic price tests had before real bars
   arrived, and it closes the same way: three real filers ingested, and the
   restatement and filing-date assertions re-run against them.
6. **Position sizing values holdings at the last daily close**, not a live
   quote. Fine for a runner invoked by hand between sessions; wrong for an
   intraday loop, where a stale mark means the risk engine sizes against
   yesterday's equity.
7. **History starts 2016-01-04.** Measured through the provider on free keys:
   2,666 daily sessions for AAPL on the consolidated tape, against 1,518 on IEX.
   2018Q4, the February–March 2020 crash and 2022 are all in the sample, so
   regime stratification and drawdown claims are testable. What is genuinely
   absent is 2008 — no free Alpaca tier reaches it, and a pre-2016 regime needs a
   different source rather than a bigger Alpaca plan. An earlier revision of this
   file claimed ~6 years and no SIP; see D-021 and D-032 for how that was wrong.
8. **Split announcements are late by construction.** Alpaca publishes no
   declaration date. The ingest derives the tightest bound the vendor's own
   dates support — the record date, typically 1–4 weeks before the ex-date — but
   Apple's split was really declared 2020-07-30 and we date it 2020-08-24. The
   error is always in the safe direction: it can withhold an adjustment a
   backtest was entitled to, never grant one it was not. A vendor with
   declaration dates would tighten it.
9. **One known bad bar.** SPY carries a single 2018-11-01 print — 200 shares,
   one trade, zero range — 20 months before the rest of its history. It is
   individually plausible, so the per-bar validator passes it, and only its
   isolation gives it away. It matters because a return computed from row
   adjacency would read a 20-month gap as one session. Phase 3 features must key
   off the trading calendar rather than adjacent rows; recorded here rather than
   discovered as an outlier in a backtest.
10. **Reconciliation is not scheduled.** The function exists and is tested;
   nothing calls it on a timer yet. An unreconciled ledger is only as good as
   the last time someone looked.
11. **The simulator's fill model is a model.** Realistic and deliberately
   pessimistic, but a model: it assumes a single intrabar path from a daily bar,
   no queue position, and no venue-specific behaviour. Its purpose is to stop a
   strategy looking better than it is, not to predict any individual fill.
12. **Volume is now consolidated, not IEX.** This entry previously said the free
   tier was IEX-only and that volume-dependent strategies needed a ~$79–199/mo
   upgrade before their backtests meant anything. That was wrong: the free tier
   serves the full tape historically, and volume features built on it are
   unbiased (D-032). The residual caveat is narrow — bars ingested *before* the
   switch carry `tape='iex'` and their volume is still ~2–3% of consolidated, so
   mixed history must either be filtered by tape or re-ingested. Every bar and
   feature row records its `tape`, which is what makes that recoverable.
13. **RLS policies are permissive when unset.** `vesti_current_user_id()`
   returning NULL means unrestricted — correct for migrations and the
   single-user deployment, but the connection pool must set
   `vesti.current_user_id` per request before multi-user ships.
14. **`ai_budgets` has no row by default.** `vesti_ai_budget_check()` returns no
   rows until one is inserted; the router must treat "no budget configured" as
   deny, not allow.

---

## Running it

```bash
service postgresql start
createdb vesti
cp .env.example .env      # fill in the four role passwords
npm install
npm run db:migrate        # apply migrations
npm run db:status         # what is applied vs pending
npm run db:test           # 25 invariant assertions on a fresh database
npm test                  # everything: 273 assertions across five packages
```

Loading real data needs Alpaca keys in `.env`:

```bash
npm run ingest -w @vesti/ingest -- sync --universe starter --from 2016-01-01
```

`sync` writes bars and then corporate actions, in that order — action ingest
attaches to securities that must already exist. Bars alone give a series with
unexplained cliffs in it wherever a split happened.

Without keys, the suite skips the real-data checks and stays green; with them,
`packages/ingest/src/real-pit.test.ts` reconstructs six thousand sessions and
compares each to the vendor's own adjusted print.

Placing a paper trade:

```bash
npm run paper -w @vesti/execution -- --symbol AAPL --quantity 1 --mandate active
npm run paper -w @vesti/execution -- --symbol AAPL --quantity 1 --dry-run
```

`--dry-run` stops after the risk ruling, before anything reaches the venue. The
runner refuses any base URL that is not `paper-api`, so pointing it at live
takes a code change rather than an environment variable.

Migrations are immutable once applied — the runner refuses to proceed if a file's
checksum changes, because silent schema drift between environments is how
look-ahead bugs and permission holes ship.
