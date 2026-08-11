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
depends on it being correct. **159 tests pass** across the four packages.

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
| **2** Data for all three mandates | Prices + corporate actions + calendars; **EDGAR XBRL fundamentals**; **catalyst calendar** (CT.gov, openFDA, earnings) | ⬜ |
| **3** Feature engines | Technical features + patterns (Active); fundamental quality/valuation features (Long-Term); catalyst proximity & magnitude features (Catalyst); forward labeling for all three | ⬜ |
| **4** Strategy Lab | Backtester, walk-forward, Monte Carlo, regime engine, benchmarks, trial ledger, promotion gates — **one strategy family per mandate**, validated identically | ⬜ |
| **5** Paper trading | `BrokerAdapter` + `SimBroker` + Alpaca paper, risk engine, order lifecycle, post-trade review, kill switch, reconciliation | 🔨 **core complete** — engine, simulator, and gate built and tested; Alpaca adapter and DB order lifecycle remain |
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

## Honest limitations

Worth stating plainly, because the gap between "foundations complete" and
"working system" is where optimism usually creeps in.

1. **Nothing decides what to trade.** The risk engine can size and veto, the
   simulator can fill, the gate can refuse — but no strategy produces an intent
   for any of them to act on. The Strategy Lab is Phase 4, and a legitimate
   outcome of it is *"none of these setups have an edge"* — that is a finding,
   not a failure.
2. **The order lifecycle is not yet wired to the database.** `SimBroker` keeps
   its own in-memory state. Writing fills into `lots`, `cash_ledger`, and
   `order_lot_allocations` under the specific-lot rules is the remaining half of
   Phase 5.
3. **No real market data is loaded.** The pipeline works end to end against the
   synthetic provider; the sandbox's network policy blocks every external host,
   so Alpaca ingestion has not been exercised against a live endpoint. That is an
   environment constraint, not a code gap — the provider interface is the only
   thing that changes.
4. **Day trading is not yet possible end to end.** The Active mandate is meant
   to day trade, and the schema is ready for it — `bars_intraday` and
   `pit_bars_intraday` exist — but two pieces are missing. There is no intraday
   ingestion yet (only daily bars), and the simulator's clock advances one bar
   per symbol per step with `day` orders expiring at the end of each step. That
   is correct for daily bars and wrong for minute bars, where a day order should
   survive until the session closes. The clock generalises naturally once bars
   carry a session boundary; the expiry rule is the part that has to change.

5. **The simulator's fill model is a model.** Realistic and deliberately
   pessimistic, but a model: it assumes a single intrabar path from a daily bar,
   no queue position, and no venue-specific behaviour. Its purpose is to stop a
   strategy looking better than it is, not to predict any individual fill.
6. **Free-tier data is IEX-only.** ~2–3% of consolidated volume, so volume,
   RVOL, and volume-confirmation signals are biased. Price, structure, and
   volatility setups validate fine; anything whose edge depends on volume needs
   a full-tape upgrade (Polygon, ~$79–199/mo) before its backtest means
   anything. Every bar and feature row records its `tape` so that upgrade
   recomputes cleanly.
7. **RLS policies are permissive when unset.** `vesti_current_user_id()`
   returning NULL means unrestricted — correct for migrations and the
   single-user deployment, but the connection pool must set
   `vesti.current_user_id` per request before multi-user ships.
8. **`ai_budgets` has no row by default.** `vesti_ai_budget_check()` returns no
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
```

Migrations are immutable once applied — the runner refuses to proceed if a file's
checksum changes, because silent schema drift between environments is how
look-ahead bugs and permission holes ship.
