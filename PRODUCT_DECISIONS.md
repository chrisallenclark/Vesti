# Product Decisions

Every entry records: the decision, why, what else was considered, and whether it
was **explicitly chosen** by the operator or **inferred** by the implementer. An
inferred decision is reversible on request; an explicit one is not changed
without asking.

---

## D-001 — Audience: private now, multi-user-ready later
**Date:** 2026-08-10 · **Explicitly chosen**

Every user-scoped table carries `user_id` and RLS from day one. No advice
surface, no tenancy UI, no subscription plumbing.

**Reasoning.** Retrofitting RLS onto a populated multi-user database is where
tenancy bugs come from. The upfront cost is a column and a policy; the retrofit
cost is a migration plus an audit.

**Alternatives.** Strictly single-user (simplest, but conversion is a real
migration). Full multi-tenant now (triggers investment-advice regulatory
analysis before anything works).

**Consequence.** The moment another person receives personalized recommendations
for compensation, US Investment Advisers Act analysis applies. Any such feature
sits behind a `MULTI_TENANT_ADVICE` flag and is flagged for legal review *before*
implementation.

---

## D-002 — Budget: start lean, scale on evidence
**Date:** 2026-08-10 · **Explicitly chosen**

~$60–130/mo. Free primary sources (EDGAR, ClinicalTrials.gov, openFDA,
USAspending) plus Alpaca's free tier for market data. Haiku/Sonnet-heavy routing
with prompt caching and the Batch API; Opus reserved for genuinely hard calls.

**Reasoning.** Alpaca's free tier includes 10 years of 1-minute bars — genuinely
enough history for pattern sample sizes. Cost tracking is instrumented from
Phase 0 so the upgrade decision is made from data rather than anxiety.

**Alternatives.** Polygon at $79–199/mo immediately (better data, but spending
before knowing what is limiting). Databento tick/L2 (~$199, only justified once a
strategy proves it needs microstructure).

**Known limitation.** IEX is ~2–3% of consolidated volume. Volume-derived
features are biased, so volume-confirmation setups cannot be honestly validated
until a full-tape upgrade. Recorded per-row via `bar_features.tape`.

---

## D-003 — Assets: US equities and ETFs only for v1
**Date:** 2026-08-10 · **Explicitly chosen**

**Reasoning.** Covers every mandate in the brief — biotech catalysts, semis,
defense, space, long-term compounders — at the lowest data cost and with the
simplest risk math. Options would add chains, IV surface, greeks, assignment, and
defined-risk sizing; crypto would break session logic, exchange calendars, and
daily-loss-limit windows with 24/7 markets.

**Alternatives.** Equities + options (useful for defined-risk catalyst plays;
substantially more complex risk engine). Everything (multiplies surface area
before anything is validated).

**Extension point.** `securities.asset_class` and a nullable
`instrument_terms jsonb` exist from the start, with a check constraint confining
terms to derivatives, so options are an additive change.

---

## D-004 — Frontend: Next.js PWA, API designed for a native add later
**Date:** 2026-08-10 · **Explicitly chosen** (after discussion of TestFlight)

**Reasoning.** ~80% of this project is backend. Next.js deploys in seconds where
native needs a build → upload → TestFlight cycle, and iteration speed matters
most in exactly the phase we are in. `lightweight-charts` is excellent on web and
its React Native port has meaningfully worse ergonomics for the custom overlays
the Active tab depends on.

TestFlight *would* have worked — internal testers (up to 100) need no App Review,
so App Store financial-app policy was never the blocker. Build economics were.

**Alternatives.** Expo native from the start (better feel, reliable background
push, weaker charting story, no web). Web-responsive only (defers the decision).

**Consequence.** Strict JSON API boundary under `/api/v1`; zero business logic in
React components, enforced by lint rule. Adding an Expo client later is a
frontend-only project. Known gap: PWAs cannot do reliable background work or
rich notification actions, so closed-app price alerts need native — revisited
after Phase 5.

---

## D-005 — Build order: trading-first
**Date:** 2026-08-10 · **Explicitly chosen**

Reach validated paper trading (Phases 0–6) before building the research and AI
layer (Phases 7–9).

**Reasoning.** Produces a falsifiable result soonest, front-loads the
deterministic components everything else depends on for correctness, and spends
least on AI during the phase where AI adds least. Backtesting needs no model
calls at all.

**Alternatives.** Research-first as originally specified (useful briefs early,
but a long stretch before anything is testable against market reality).
Parallel (everything sooner in wall-clock terms, nothing finished early, hardest
to course-correct).

---

## D-006 — Raw prices only; adjustment applied at query time
**Date:** 2026-08-10 · **Inferred**

`bars_daily` and `bars_intraday` store raw OHLCV. There is no `adjusted_close`
column. Adjustment is computed by `pit_bars_daily()` from `corporate_actions`
filtered to `announced_at <= as_of`.

**Reasoning.** An adjusted price series is a function of every split *after* the
bar. Storing it bakes the future into every historical row, and no amount of
careful querying extracts it again. This is the single largest look-ahead vector
in price data and it cannot be fixed cheaply later.

**Alternatives.** Store both raw and adjusted (adjusted goes stale after every
new action and invites accidental use). Store adjusted only (unrecoverable).

**Cost.** Adjustment is computed per query. If it becomes a bottleneck, the fix
is a materialized adjusted view keyed by as-of date — not an adjusted column.

---

## D-007 — Bitemporal facts: `observed_at` alongside `effective_at`
**Date:** 2026-08-10 · **Inferred**

**Reasoning.** A fundamentals row keyed by fiscal period silently leaks the
future: Q3 results were not knowable on the last day of Q3. Separating "when it
became true" from "when we could know it" is the only way a backtest can ask
what was actually available.

**Alternatives.** Single-timestamp facts (simpler, quietly wrong). An
event-sourced log (more general, much heavier for the benefit).

**Consequence.** Cannot be retrofitted cheaply, which is why it is in Phase 0.

---

## D-008 — Postgres role separation as the trading-authority boundary
**Date:** 2026-08-10 · **Inferred**

Four roles. `vesti_execution` is the sole writer of `orders`/`fills`/`lots`;
`vesti_backtest` holds no table grants at all and reaches data only through
`SECURITY DEFINER` PIT functions.

**Reasoning.** "The research component shouldn't trade" is a code review comment.
`permission denied for table orders` is a guarantee. Same for look-ahead: a role
that cannot read `bars_daily` cannot read tomorrow's bar regardless of what a
query says.

**Alternatives.** Application-layer authorization (one bug away from failure).
Separate databases per component (loses referential integrity and cross-domain
queries).

**Consequence.** `SECURITY DEFINER` functions must pin `search_path` — done on
all six PIT functions — or they become a privilege-escalation vector.

---

## D-009 — Specific-lot accounting for mandate isolation
**Date:** 2026-08-10 · **Inferred**

Positions are tax lots owned by exactly one mandate. Exits name specific lots via
`order_lot_allocations`, guarded by a trigger.

**Reasoning.** The same ticker may be a multi-year holding and a two-day trade at
once. Average-cost accounting with a mandate column cannot express that, and a
tactical stop would sell whatever shares came first. This is a real-money
correctness issue, not a reporting nicety.

**Alternatives.** Average cost with a mandate column (cannot represent the
requirement). Separate broker accounts per mandate (clean, but multiplies
account admin and fragments buying power).

**Open item.** The broker holds one omnibus position. Nightly reconciliation
against the sum of internal lots, with a hard alert on drift, is required in
Phase 5.

---

## D-010 — Conviction score never enters position sizing
**Date:** 2026-08-10 · **Inferred**

The 60-point score is retained as a communication device. Sizing consumes
measured expectancy, volatility, and liquidity only.

**Reasoning.** Six 0–10 buckets summed implies the categories are equally
weighted and linearly additive. Neither is defensible, and a number that looks
precise invites being used as though it were. The brief itself warns against
treating scores as probabilities.

**Alternatives.** Weighted score fitted to outcomes (needs a large labeled
history that does not exist yet; revisit once it does). Drop the score entirely
(loses a genuinely useful summary for the human).

---

## D-011 — Polyglot: TypeScript app, Python quant service
**Date:** 2026-08-10 · **Inferred**

**Reasoning.** Backtesting, walk-forward validation, Monte Carlo, MAE/MFE
labeling, and regime models are an order of magnitude cheaper and more correct
in numpy/pandas/scipy/statsmodels than hand-rolled TypeScript. Getting a
backtester subtly wrong is worse than operating two languages.

**Alternatives.** All-TypeScript (one language, but reimplementing statistical
machinery). All-Python (loses React Server Components, which is what makes
"screens read precomputed rows" the default).

**Consequence.** Shared contracts live in the database, not in a shared type
package. `vesti_ai_cost()` is implemented in SQL so both runtimes agree.

---

## D-012 — Jobs in Postgres rather than Redis
**Date:** 2026-08-10 · **Inferred**

`SELECT ... FOR UPDATE SKIP LOCKED` with leases and exponential backoff.

**Reasoning.** One durable store to operate and back up. Every queued unit of
work is an auditable row, which matters for a system whose central claim is that
decisions are reconstructable.

**Alternatives.** Redis/BullMQ (better throughput, another system to run,
non-durable by default). Cloud queue (vendor coupling for volumes this project
will not reach).

**Revisit if.** Queue depth or claim contention becomes a measured bottleneck —
not before.

---

## D-013 — Design system: dark-first, semantic colour only
**Date:** 2026-08-10 · **Explicitly chosen** (brief: Apple-like, Equinox-like)

Near-black surfaces (`#09090B`), warm brass accent (`#C8B08A`), desaturated jade
and clay for P&L, tabular figures throughout, one hero number per screen.

**Reasoning.** The failure mode for a trading UI is the standard dashboard:
dense grids, saturated red/green, badge soup. Discipline rules do the work —
colour is semantic only, no gradients, no shadows, no icon unless it replaces a
word, maximum three data points above the fold.

Tabular figures are not cosmetic: proportional numerals jitter as live values
update, which reads as instability in exactly the screen where calm matters.

**Accessibility is not traded for aesthetics.** WCAG AA on all text pairs, ≥44px
hit targets, and P&L never conveyed by colour alone — sign and direction glyph
always present.

---

## D-014 — Migrations are immutable once applied
**Date:** 2026-08-10 · **Inferred**

The runner records a checksum and refuses to proceed if an applied file changes.

**Reasoning.** Silent schema drift between environments is how look-ahead bugs
and permission holes ship. A refused migration is a loud, cheap failure; a
diverged schema is a quiet, expensive one.

**Alternatives.** Warn instead of refuse (the warning gets ignored). No checksum
(drift is undetectable).
