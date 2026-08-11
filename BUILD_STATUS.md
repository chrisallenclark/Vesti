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

**Real market data is loaded and the PIT layer is verified against it.** Ten
years were requested; Alpaca's IEX archive begins 2020-07-27, so ~6 years of
daily bars for 17 names, with nine real splits among them. The reconstruction is
checked against the vendor's own split-adjusted series rather than against our
own generator. **189 tests pass** across five packages.

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
| **2** Data for all three mandates | Prices + corporate actions + calendars; **EDGAR XBRL fundamentals**; **catalyst calendar** (CT.gov, openFDA, earnings) | 🔨 **prices done** — daily bars and corporate actions ingested from Alpaca and verified against the PIT layer; fundamentals and catalysts remain |
| **3** Feature engines | Technical features + patterns (Active); fundamental quality/valuation features (Long-Term); catalyst proximity & magnitude features (Catalyst); forward labeling for all three | ⬜ |
| **4** Strategy Lab | Backtester, walk-forward, Monte Carlo, regime engine, benchmarks, trial ledger, promotion gates — **one strategy family per mandate**, validated identically | ⬜ |
| **5** Paper trading | `BrokerAdapter` + `SimBroker` + Alpaca paper, risk engine, order lifecycle, post-trade review, kill switch, reconciliation | 🔨 **core + lifecycle complete** — engine, simulator, gate, DB order lifecycle and reconciliation built and tested; the Alpaca *trading* adapter and post-trade review remain |
| **6** **Autonomous paper — the goal** | Signal → construction → risk → execution loop running unattended across **all three mandates**; per-mandate equity curves, benchmark comparison, attribution, calibration scoring | ⬜ |
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

**Reconciliation is the falsifiability check.** Our per-mandate lots and the
broker's single omnibus number are computed by different code from different
state; a test runs `SimBroker` across three sessions, posts every fill through
the ledger, and requires the two to agree on both position and cash. It reports
rather than repairs — a drift means a fill we missed, one applied twice, or an
unprocessed corporate action, and writing one number over the other destroys the
evidence needed to tell them apart.

## Honest limitations

Worth stating plainly, because the gap between "foundations complete" and
"working system" is where optimism usually creeps in.

1. **Nothing decides what to trade.** The risk engine can size and veto, the
   simulator can fill, the gate can refuse — but no strategy produces an intent
   for any of them to act on. The Strategy Lab is Phase 4, and a legitimate
   outcome of it is *"none of these setups have an edge"* — that is a finding,
   not a failure.
2. **Nothing submits an order to Alpaca yet.** The paper keys are verified and
   the account is live ($100k, `ACTIVE`), but only the *data* API is exercised.
   `BrokerAdapter` has one real implementation, `SimBroker`; the Alpaca paper
   adapter is the remaining piece of Phase 5. Everything downstream of a fill
   now exists, so that adapter is the last thing between here and a paper trade.
3. **History starts 2020-07-27, not 2015.** Measured, not requested: that is
   where Alpaca's IEX archive begins, and the SIP feed returns "subscription
   does not permit" on the free tier. ~6 years is enough for the splits the PIT
   layer is verified against and thin for anything wanting a pre-COVID regime in
   its sample. Any claim about behaviour across regimes is currently a claim
   about 2020 onward.
4. **Split announcements are late by construction.** Alpaca publishes no
   declaration date. The ingest derives the tightest bound the vendor's own
   dates support — the record date, typically 1–4 weeks before the ex-date — but
   Apple's split was really declared 2020-07-30 and we date it 2020-08-24. The
   error is always in the safe direction: it can withhold an adjustment a
   backtest was entitled to, never grant one it was not. A vendor with
   declaration dates would tighten it.
5. **One known bad bar.** SPY carries a single 2018-11-01 print — 200 shares,
   one trade, zero range — 20 months before the rest of its history. It is
   individually plausible, so the per-bar validator passes it, and only its
   isolation gives it away. It matters because a return computed from row
   adjacency would read a 20-month gap as one session. Phase 3 features must key
   off the trading calendar rather than adjacent rows; recorded here rather than
   discovered as an outlier in a backtest.
6. **Reconciliation is not scheduled.** The function exists and is tested;
   nothing calls it on a timer yet. An unreconciled ledger is only as good as
   the last time someone looked.
7. **The simulator's fill model is a model.** Realistic and deliberately
   pessimistic, but a model: it assumes a single intrabar path from a daily bar,
   no queue position, and no venue-specific behaviour. Its purpose is to stop a
   strategy looking better than it is, not to predict any individual fill.
8. **Free-tier data is IEX-only.** ~2–3% of consolidated volume, so volume,
   RVOL, and volume-confirmation signals are biased. Price, structure, and
   volatility setups validate fine; anything whose edge depends on volume needs
   a full-tape upgrade (Polygon, ~$79–199/mo) before its backtest means
   anything. Every bar and feature row records its `tape` so that upgrade
   recomputes cleanly.
9. **RLS policies are permissive when unset.** `vesti_current_user_id()`
   returning NULL means unrestricted — correct for migrations and the
   single-user deployment, but the connection pool must set
   `vesti.current_user_id` per request before multi-user ships.
10. **`ai_budgets` has no row by default.** `vesti_ai_budget_check()` returns no
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
npm test                  # everything: 189 assertions across five packages
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

Migrations are immutable once applied — the runner refuses to proceed if a file's
checksum changes, because silent schema drift between environments is how
look-ahead bugs and permission holes ship.
