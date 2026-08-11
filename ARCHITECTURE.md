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
`packages/db/src/invariants.test.ts`. Invariants 1 and 3 are additionally
enforced above the database — see *Execution* below.

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

**`observed_at` is the session's own close, not the download time.** A daily bar
was knowable to anyone the evening it printed, so a backfill records that rather
than the moment the job happened to run. Stamping it with `now()` would make an
entire backfilled history invisible to every as-of date before today — every
backtest silently returning zero bars. A genuine *revision* is the exception and
does record publication time, because a corrected figure really was not available
until it was published.

This is verified end to end rather than asserted, and twice over. A generated
series with known ground truth is written through the real ingestion path and
read back through the real PIT functions, and the reconstructed continuous price
must match the truth to within the cent the vendor rounds to. That test can only
fail if the code is wrong about our own fiction, so a second one ingests real
bars and real corporate actions and compares the reconstruction to **the
vendor's own split-adjusted series**, fetched by a separate implementation. Six
thousand sessions, nine real splits, two of them on one name so the factors have
to compound.

**Alpaca publishes no declaration date**, so announcement is taken as the
earliest date it does publish that cannot precede one — record, payable, process,
ex. That is late rather than early, always: it can withhold an adjustment a
backtest was entitled to, never grant one it was not.

**Survivorship** is handled the same way: delisted securities stay in the master
with `delisted_at` set, and `pit_universe(date)` returns everything listed on
that date. EDGAR's ticker file lists only currently-listed companies, so the CIK
is recorded on `security_identifiers` at first sight — once a name drops out of
that file its ticker can never be resolved again, and a survivorship-safe
fundamental history depends on having written the mapping down while it was
still there.

**Fundamentals are the sharpest case of all this.** A price is knowable the
instant it prints; a financial fact describes a period that ended weeks before
anyone outside the company saw it. `fundamental_facts` therefore separates
`period_end` (when it became true) from `filed_at` (when it became knowable),
and keeps every restatement rather than overwriting — a company revising 2022 in
2023 must not change what a backtest standing in early 2023 can see.
`pit_fundamental_facts()` returns the newest version filed by the as-of instant,
which is the only reading that is correct at every point in the past as well as
now.

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

The same rule is enforced a second time at the broker boundary by
`guardedBroker`, which wraps *any* adapter and refuses an order that has no
evaluation, presents an unknown or expired one, presents one issued for a
different symbol or side, exceeds the approved quantity, or arrives while the
kill switch is tripped. It is a wrapper rather than a rule each adapter
implements, so adding a broker cannot reintroduce the hole — and there is no way
to reach the inner adapter from outside it.

Cancellation is deliberately never gated: blocking a cancel during a kill-switch
event would trap working orders in the market at exactly the moment someone
decided to stop trading.

### 4. Mandate isolation

The same ticker can be a multi-year core holding and a two-day tactical trade
simultaneously. Those are different capital with different theses and different
exits.

Positions are **tax lots**, each owned by exactly one mandate. Exits name the
specific lots they close via `order_lot_allocations`, and the
`order_lot_allocations_mandate_guard` trigger rejects any allocation whose lot
belongs to a different mandate than the order. A tactical stop physically cannot
sell long-term shares.

Enforced twice, deliberately. `packages/execution/src/lots.ts` scopes every lot
query to the *order's* mandate, so an exit never sees another mandate's shares —
that is why the rule holds in practice. The trigger is why a bug there cannot
quietly break it, and a test writes an allocation directly, past every line of
application code, to confirm the database still refuses.

The concrete case: one ticker, 500 shares held long-term and 40 held tactically.
An Active exit for 100 fails, though the account holds 540 and the broker would
sell them. Code that asks "does the account hold 100?" closes a multi-year
position to satisfy a two-day trade and books the gain to the wrong thesis.

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
apps/web/            Next.js 16 PWA. Presentation only — no domain logic.
packages/db/         Migrations, migration runner, invariant tests.
packages/core/       Domain logic, all pure and all tested:
                       risk/     deterministic sizing engine with veto power
                       broker/   BrokerAdapter, execution gate, SimBroker
                       market/   US equity trading calendar
                       sim/      seeded PRNG, synthetic series with ground truth
packages/ingest/     Market data providers and the bitemporal write path:
                       alpaca.ts       daily bars + corporate actions
                       edgar.ts        SEC XBRL company facts, concept aliasing
                       fundamentals.ts bitemporal fact writes, restatement-aware
packages/execution/  The order lifecycle against the database and the venue:
                       ledger.ts     intent -> ruling -> submission -> fill
                       lots.ts       specific-lot selection, mandate-scoped
                       alpaca.ts     BrokerAdapter over Alpaca paper/live
                       fills.ts      trade_updates stream + polling reconciler
                       selfcross.ts  two mandates, one symbol, opposite sides
                       reconcile.ts  our lots vs the broker's omnibus count
                       paper.ts      the whole chain, end to end, no doubles
services/quant/      Python: features, patterns, backtest, Monte Carlo.
docs/                Long-form design notes.
```

**API-first constraint.** All domain logic sits behind versioned JSON handlers
under `/api/v1`; components display, never compute. This keeps a future
Expo/TestFlight client a frontend-only project rather than a rewrite.

---

## Execution

Three components, all pure and all deterministic, sitting between a strategy's
intent and a venue.

**Risk engine** (`packages/core/src/risk/`). `evaluate(intent, portfolio,
market, limits)` returns an approve/reduce/reject ruling with the reasoning that
produced it. Eleven sizing steps, each of which can only *reduce*: base
fractional risk, volatility, conviction tier (bounded, never unbounded),
drawdown ladder, portfolio heat, concentration caps, liquidity, event risk, cash
floor. `Math.floor` is applied last, so rounding cannot push a position back
above a cap. Sells are always approved — blocking an exit would trap the very
position causing the breach. Verified by hand-written adversarial cases plus a
property test over 4,000 seeded scenarios asserting no hard cap is ever exceeded.

**Broker adapter** (`packages/core/src/broker/`). One interface, three
implementations over the project's life: `SimBroker`, Alpaca paper, Alpaca live.
A broker deliberately does not know about mandates — a real one holds a single
omnibus position per symbol with one average cost, which is exactly why our
specific-lot ledger exists alongside it and gets reconciled against it.

**Order ledger** (`packages/execution/`). Every fill's whole effect in one
transaction: a lot opened or consumed, cash moved, the order advanced. Three
properties it is built around — fills are idempotent, because brokers replay and
reapplying one manufactures a position that never existed; exits consume only
their own mandate's lots; and cash is a ledger of signed entries rather than a
balance, so it can be explained rather than merely reported.

**Fills from a real venue** arrive asynchronously, so `BrokerAdapter` has no
method that could return them. Two sources run together: the `trade_updates`
stream, and a poller that re-reads open orders. Both post through one cumulative
path — the broker reports a running total, and the ledger computes the increment
itself **while holding the order lock**. That is what makes running both free:
whichever arrives second finds nothing left to do. Posting each under its own
identifier instead would book a 40-share partial twice, and the overfill check
would not catch it, because 80 is still under a 100-share order.

The redundancy is not theoretical. On the first live paper order the stream
delivered nothing — Alpaca sends JSON inside binary websocket frames — and the
poller caught the fill.

Reconciliation compares our per-mandate lots and cash to the broker's own count.
Both sides come from different code over different state, which is what makes
agreement evidence instead of a tautology. It reports rather than repairs: a
drift means a fill we missed, one applied twice, or an unprocessed corporate
action, and overwriting either number destroys what distinguishes them.

**The simulator fills pessimistically, on purpose.** No same-bar signal and
fill: an order submitted on session T is not eligible until T+1. Resting limits
must be traded *through*, not merely touched. Stops gap. Triggered stop-limits
that never see their limit do not fill. Rounding always goes against the trader.
Fills are capped at a participation limit per bar, so a strategy that only works
at sizes the tape cannot absorb reveals itself here rather than in production.
Market impact follows the square-root law, which matters most in the regime a
linear model gets dangerously wrong — large orders.

No randomness anywhere: same orders, same bars, same fills, always. A failing
backtest that cannot be reproduced cannot be debugged.

---

## Verification strategy

The deterministic core is tested against **known ground truth**, not against
plausibility.

A seeded generator produces raw OHLCV, splits and dividends while retaining the
true split-continuous price of every session. Because the correct answer exists
before the test runs, an adjustment applied in the wrong direction or a bar
alignment off by one *fails* rather than looking like a mediocre strategy. The
generator emits raw prints (a 4:1 split quarters the price and quadruples the
volume), announces every action strictly before its ex-date, and builds each bar
from a simulated intrabar path so high and low genuinely bound open and close —
data that could not exist teaches nothing.

It also means the whole pipeline runs offline. Swapping in a real vendor is a
change of one constructor.

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
| `007_synthetic_source` | `sources` row for generated data, tiered lowest |
| `008_partition_provisioning` | Partition functions as `SECURITY DEFINER` |
| `009_fill_idempotency` | Deduplication key for replayed broker fills |
| `010_equity_and_reconciliation` | `equity_snapshots`, `reconciliation_runs` |
| `011_fundamentals` | Bitemporal `fundamental_facts` + `pit_fundamental_facts()` |

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
