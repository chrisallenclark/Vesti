# Build Status

Updated at every phase boundary. Ordered **trading-first**: reach validated paper
trading before building the research/AI layer.

---

## Where things stand

**Phase 0 (Foundations) — complete.** The database enforces every invariant the
rest of the system depends on. 25 automated assertions pass against a database
built from nothing.

Nothing is tradable yet, and no strategy exists. That is expected at this stage —
see *Honest limitations* below.

---

## Phases

| Phase | Deliverable | Status |
|---|---|---|
| **0** Foundations | Schema, bitemporal PIT layer, roles + RLS, immutability, job runner, AI cost ledger, docs | ✅ **complete** |
| **1** Portfolio spine + design system | Auth, mandates, accounts, lot-level positions, manual entry, risk settings, journal, mobile shell, component library | ⬜ next |
| **2** Market data | Securities master, daily + 1-minute bars, corporate actions, calendars, survivorship-safe universe | ⬜ |
| **3** Technical engine | Feature computation, pattern detectors, multi-timeframe alignment, forward labeling (R/MAE/MFE), charts | ⬜ |
| **4** Strategy Lab | Backtester, walk-forward, Monte Carlo, regime engine, benchmarks, trial ledger, promotion gates | ⬜ |
| **5** Paper trading | `BrokerAdapter` + `SimBroker`, risk engine, order lifecycle, post-trade review, kill switch, reconciliation | ⬜ |
| **6** Autonomous paper | Signal → construction → risk → execution loop, continuous evaluation, calibration scoring | ⬜ |
| **7** Evidence pipeline | EDGAR, ClinicalTrials.gov, openFDA, USAspending, IR/news, change detection, source tiering | ⬜ |
| **8** AI intelligence | Model router, structured extraction, thesis versioning, conviction/opportunity scoring, briefs, alerts | ⬜ |
| **9** Discovery & graph | Opportunity discovery, second-order relationships, knowledge graph, "What did I notice?" | ⬜ |
| **10** Controlled live | Alpaca live adapter, L3 human-approved, then L4 tiny autonomous | ⬜ |

Phases 3 and 4 overlap naturally. Phase 7 has no dependency on 3–6 and can start
early if catalyst tracking is wanted sooner.

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

1. **Nothing can trade.** No broker adapter, no risk engine implementation, no
   order lifecycle. Phase 5.
2. **No strategy exists.** The Strategy Lab is Phase 4. A legitimate outcome of
   it is *"none of these setups have an edge"* — that is a finding, not a
   failure.
3. **No market data is loaded.** The schema is ready; ingestion is Phase 2.
4. **Free-tier data is IEX-only.** ~2–3% of consolidated volume, so volume,
   RVOL, and volume-confirmation signals are biased. Price, structure, and
   volatility setups validate fine; anything whose edge depends on volume needs
   a full-tape upgrade (Polygon, ~$79–199/mo) before its backtest means
   anything. Every bar and feature row records its `tape` so that upgrade
   recomputes cleanly.
5. **RLS policies are permissive when unset.** `vesti_current_user_id()`
   returning NULL means unrestricted — correct for migrations and the
   single-user deployment, but the connection pool must set
   `vesti.current_user_id` per request before multi-user ships.
6. **`ai_budgets` has no row by default.** `vesti_ai_budget_check()` returns no
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
