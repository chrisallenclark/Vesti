# Vesti — Architecture

An evidence-driven investment and trading intelligence system. Three independent
mandates, deterministic risk control, and a validation ladder that can conclude
"no edge found" and mean it.

The organising principle: **the database enforces the invariants that matter.**
Look-ahead prevention, trading authority, and immutable history are permissions
and constraints, not conventions a future change might quietly violate.

---

## System shape

```
┌──────────────┐   reads precomputed rows only    ┌──────────────────┐
│ Next.js PWA  │ ───────────────────────────────► │  Postgres        │
│ (Vercel)     │ ◄─ Realtime push (alerts, fills) │  (Supabase)      │
└──────────────┘                                   └────▲────▲───▲───┘
                                                        │    │   │
        ┌───────────────────────────────────────────────┘    │   │
        │                                                    │   │
┌───────┴────────┐  ┌───────────────────┐  ┌────────────────┴─┐ ┌┴──────────────┐
│ Ingest workers │  │ Quant service     │  │ Intelligence     │ │ Execution     │
│ prices, EDGAR, │  │ (Python)          │  │ layer (AI)       │ │ service       │
│ CT.gov, FDA,   │  │ features, patterns│  │ router, extract, │ │ risk engine + │
│ USAspending    │  │ backtest, MC,     │  │ thesis, briefs   │ │ BrokerAdapter │
│                │  │ regime, metrics   │  │ NEVER in req path│ │ SOLE TRADER   │
└────────────────┘  └───────────────────┘  └──────────────────┘ └───────────────┘
   vesti_research      vesti_backtest          vesti_research      vesti_execution
```

Four worker groups, four database roles. The role a component connects as is its
security boundary.

---

## The five invariants

Each is enforced by the database and covered by a test in
`packages/db/src/invariants.test.ts`.

### 1. No look-ahead bias

Two distinct leaks are closed:

**Facts we did not yet have.** Every externally-sourced fact carries
`observed_at` (when we could first have known it) alongside `effective_at` (when
it became true). The `pit_*` functions filter on `observed_at`.

**Adjustments we could not yet have made.** Price bars store **raw OHLCV only**.
There is no `adjusted_close` column and there never will be — an adjusted series
is a function of every split after the bar, so storing it bakes the future into
every historical row. Adjustment is applied at query time from
`corporate_actions`, using only actions with `announced_at <= as_of`.

A backtest standing on 2020-05-25 sees $100 for a stock that split 2-for-1 three
weeks later. On 2020-07-01 the same bar reads $50. Both are correct.

**Survivorship** is handled the same way: delisted securities stay in the master
with `delisted_at` set, and `pit_universe(date)` returns everything listed on
that date.

### 2. Only the execution service can trade

Four Postgres roles:

| Role | Reads | Writes | Cannot |
|---|---|---|---|
| `vesti_app` | everything | journal, user settings | touch orders |
| `vesti_research` | everything | evidence, securities, bars, features, strategies | touch orders, fills, lots |
| `vesti_execution` | everything | orders, fills, lots, cash, risk | — |
| `vesti_backtest` | **nothing** | nothing | read any base table |

A prompt injection that convinces a model to liquidate the portfolio produces
`permission denied for table orders`.

### 3. No order without an approved risk evaluation

`orders.risk_evaluation_id` is required the moment an order leaves
`pending_risk`, and the `orders_risk_gate` trigger verifies the evaluation was
for *this* account, mandate, security, and side, and that quantity does not
exceed what was approved.

An LLM produces an **intent**. The deterministic risk engine produces the
**ruling**. Only a matching approval yields a submittable order.

### 4. Mandate isolation

The same ticker can be a multi-year core holding and a two-day tactical trade
simultaneously. Those are different capital with different theses and different
exits.

Positions are **tax lots**, each owned by exactly one mandate. Exits name the
specific lots they close via `order_lot_allocations`, and the
`order_lot_allocations_mandate_guard` trigger rejects any allocation whose lot
belongs to a different mandate than the order. A tactical stop physically cannot
sell long-term shares.

### 5. History is append-only

`audit_log`, `risk_evaluations`, `pre_trade_records`, `decision_snapshots`,
`strategy_versions`, `setup_versions`, and `fills` reject `UPDATE` and `DELETE`
at the table level.

`audit_log` is additionally **hash-chained**: each row commits to the previous
row's hash, so tampering requires rewriting every subsequent row.
`vesti_verify_audit_chain()` returns the first divergence.

`pre_trade_records` is the falsifiability mechanism — the hypothesis is
timestamped *before* the outcome exists, so a post-mortem cannot rewrite what we
believed at entry.

---

## Repository layout

```
apps/web/            Next.js 15 PWA. Presentation only — no domain logic.
packages/db/         Migrations, migration runner, invariant tests.
packages/core/       Domain types and the deterministic risk engine.
services/quant/      Python: features, patterns, backtest, Monte Carlo.
docs/                Long-form design notes.
```

**API-first constraint.** All domain logic sits behind versioned JSON handlers
under `/api/v1`; components display, never compute. This keeps a future
Expo/TestFlight client a frontend-only project rather than a rewrite.

---

## Data model

Groups, in dependency order. Full DDL in `packages/db/migrations/`.

| Migration | Contents |
|---|---|
| `001_foundation` | Extensions, enums, users, hash-chained `audit_log` |
| `002_reference_and_market_data` | `sources`, `securities`, `exchange_sessions`, `corporate_actions`, partitioned `bars_daily` / `bars_intraday` / `bar_features` |
| `003_pit_layer` | `pit_universe`, `pit_bars_daily`, `pit_bars_intraday`, `pit_corporate_actions`, `pit_bar_features`, `pit_split_factor` |
| `004_portfolio_risk_strategy` | `mandates`, `accounts`, `lots`, `orders`, `fills`, `cash_ledger`, risk tables, strategy/setup versioning, decision records |
| `005_roles_rls_immutability` | Four roles, grants, RLS policies, append-only triggers, the risk gate |
| `006_jobs_and_ai_ledger` | `jobs` queue, `ai_calls`, `ai_model_pricing`, `ai_budgets` |

**Partitioning.** `bars_daily` by year; `bars_intraday` and `bar_features` by
month (1-minute data is the volume driver). `DEFAULT` partitions catch
out-of-range inserts so a 2am ingest never fails on a missing partition.

**Tape provenance.** Every bar and feature row carries `tape`. The free Alpaca
tier is IEX-only (~2–3% of consolidated volume), so volume-derived features are
biased. Recording it per-row means a later full-tape upgrade recomputes exactly
the affected rows instead of silently invalidating labeled history.

---

## AI architecture

Strictly **write-behind**. No user-facing read path may call a model; every
screen reads precomputed rows.

| Tier | Model | Work |
|---|---|---|
| Cheap | `claude-haiku-4-5` | classification, dedup, change detection, extraction, triage |
| Standard | `claude-sonnet-5` | news impact, filing summaries, routine updates, explanations |
| Deep | `claude-opus-5` | clinical readouts, thesis change/break, valuation, weekly committee |

Controls: structured outputs on every extraction; prompt caching with a stable
company-dossier prefix; the Batch API (50% off) for nightly work; content
hashing so unchanged documents never reach a model.

`vesti_ai_budget_check()` is consulted **before** dispatch — the budget is a
gate, not a report. `vesti_ai_cost()` computes cost in SQL so TypeScript and
Python agree.

**No self-modification.** A model may write a `strategy_versions` row with
`authored_by = 'ai_proposed'`. Promotion out of `experimental` is a deterministic
gate evaluation.

---

## Risk engine

A pure function with zero model calls:

```
evaluate(order_intent, portfolio_state, policies, market_state)
  -> { decision: APPROVE | REDUCE | REJECT, size, violations[], reasoning[] }
```

Sizing pipeline — each step may only *reduce* size: base fixed-fractional risk →
volatility adjustment (ATR stop distance) → conviction tier multiplier →
drawdown ladder → correlation/heat cap → liquidity cap (% ADV) → event-risk cap
→ hard ceilings → survival constraint (Monte Carlo P(drawdown > limit)).

Percentages apply to *current* equity, so dollar risk compounds with the account
— but there is no "house money" bucket and no risk increase after a winning
streak absent new statistical evidence.

The conviction score is a **communication device only**. Six 0–10 buckets summed
implies equal weighting and linear additivity; neither is defensible, so it never
enters sizing. Sizing consumes measured expectancy, volatility, and liquidity.

---

## Validation ladder

In-sample fit → walk-forward (rolling, anchored) → regime-stratified breakdown →
Monte Carlo trade-sequence bootstrap → **single-use locked out-of-sample
holdout** → benchmark and risk-adjusted comparison.

`experiment_trials` tracks every trial against a data segment so reported Sharpe
can be deflated by trial count. Without this, a Strategy Lab that tries many
variants manufactures false edges by construction.

Promotion state machine: `experimental → validating → paper_approved →
live_limited → live_scaled`, plus `paused` / `retired`. Demotion is automatic on
breach.

---

## Local development

```bash
service postgresql start
createdb vesti
cp .env.example .env          # fill in role passwords
npm install
npm run db:migrate
npm run db:test               # 25 invariant assertions, fresh database
```

`npm run db:test` drops and recreates `vesti_test`, applies every migration from
nothing, and asserts the invariants. A passing suite means the migrations
*produce* these guarantees — not that a hand-patched database happens to have
them.
