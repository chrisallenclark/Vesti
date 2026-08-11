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

> **This decision stands, and its reasoning holds — see D-032.** An earlier note
> here claimed the free tier had only ~6 years of IEX history and no SIP. That
> note was wrong: the free tier serves the full consolidated tape from
> 2016-01-04, so "10 years, enough for sample sizes" is substantially right. The
> *Known limitation* above is now avoidable rather than inherent — history is
> fetched from SIP, and IEX applies only to the real-time path. D-021 records the
> mistaken reading; D-032 records the measurement that replaced it.

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
all seven PIT functions, including `pit_fundamental_facts` — or they become a
privilege-escalation vector.

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

---

## D-015 — A backfilled bar is dated to its own session close, not to download time
**Date:** 2026-08-11 · **Inferred** (discovered by a failing test)

`observed_at` on a first insert is `least(now(), session_date 22:00 UTC)`. Only a
genuine *revision* gets `now()`.

**Reasoning.** The PIT layer asks "could this have been known then?", not "when
did this machine fetch it". Stamping a ten-year backfill with the moment the
download ran makes the entire history invisible to every as-of date before today
— every backtest silently returns zero bars. The price that printed on a given
session was knowable to anyone that evening, so that is what gets recorded.

A revision is the real exception and keeps `now()`: a corrected figure genuinely
was not available until the vendor published it.

22:00 UTC is after the 4pm ET close in either DST offset. Erring *late* is the
safe direction — it can withhold data from a backtest, never leak it early.

**How it surfaced.** The first end-to-end PIT test returned zero rows. The
database was right and the ingestion semantics were wrong.

---

## D-016 — Partition provisioning is a delegated capability, not a schema grant
**Date:** 2026-08-11 · **Inferred**

`vesti_ensure_daily_partition` / `vesti_ensure_intraday_partition` are
`SECURITY DEFINER` with a pinned `search_path`, executable only by
`vesti_research`.

**Reasoning.** Ingest must create the partition a batch lands in, but
`CREATE TABLE ... PARTITION OF` runs with the caller's privileges. The obvious
fix — `GRANT CREATE ON SCHEMA public TO vesti_research` — hands the role most
exposed to untrusted external feeds the ability to create arbitrary objects in
the schema everything resolves against. The narrow grant gives it exactly one
capability instead: create a correctly-shaped partition of a table it already
writes to.

**Alternatives.** Pre-create decades of partitions (wasteful, and still fails at
the boundary). Run a privileged provisioning job separately (a second moving
part, and ingest fails until it runs).

---

## D-017 — Synthetic market data is a first-class source with known ground truth
**Date:** 2026-08-11 · **Explicitly chosen**

A deterministic seeded generator produces raw OHLCV, splits, and dividends, and
retains the true continuous price of every session. It has its own `sources` row
(`tier4_social`, the lowest tier) and every bar is tagged `tape = 'synthetic'`.

**Reasoning.** A backtester checked only against real prices can be checked for
*plausibility* and nothing more — there is no independent answer to compare
against, so an adjustment applied in the wrong direction or a bar alignment off
by one looks exactly like a mediocre strategy. With generated data the correct
answer exists before the test runs.

It also unblocks the entire pipeline offline: no key, no network, no vendor.
Real data becomes a config change — swap the provider, re-run.

Three properties are load-bearing: prices are emitted **raw** (a 4:1 split
quarters the print and quadruples the volume); every action is announced
strictly **before** its ex-date; and bars are built from a simulated intrabar
path so high and low genuinely bound open and close. Data that could not exist
teaches nothing.

---

## D-018 — The execution gate is a wrapper, not a rule each broker implements
**Date:** 2026-08-11 · **Explicitly chosen**

`guardedBroker(inner, guards)` wraps any `BrokerAdapter` and refuses orders on
five grounds: kill switch tripped, no risk evaluation, unknown evaluation, an
evaluation for a different symbol or side, a quantity above the approved size,
or an expired approval.

**Reasoning.** If each adapter checked for itself, adding a broker would mean
re-deriving the safety properties, and forgetting a check would be a silent hole
rather than a structural impossibility. There is deliberately no way to reach
the inner adapter from outside the wrapper — a guard you can route around is a
suggestion.

**Cancellation is never gated.** Blocking a cancel during a kill-switch event
would trap working orders in the market at exactly the moment someone decided to
stop trading.

---

## D-019 — Fill assumptions are deliberately pessimistic
**Date:** 2026-08-11 · **Explicitly chosen** (brief: "no same-bar signal-and-fill")

The `SimBroker` fills worse than reality would in several specific ways:

- **No same-bar signal and fill.** An order submitted on session T is not
  eligible until T+1. A strategy that decides from a bar's close cannot also
  transact inside it. This one rule separates most impressive backtests from
  most honest ones.
- **A resting limit must be traded *through*, not merely touched** — touching
  your price does not clear the queue ahead of you. A gap in your favour is
  honoured, because a market that opens past your limit does fill you there.
- **A stop is not a guarantee.** A gap past the stop fills at the open, below it.
- **A triggered stop-limit that never sees its limit does not fill** — the way
  stop-limits actually fail people in fast markets.
- **Rounding always goes against the trader**, in both directions.
- **Fills are capped at a participation limit per bar.** A `day` order the tape
  could not absorb expires partially filled.

**Reasoning.** A backtest is an argument that a strategy works, and the cheapest
way to win it dishonestly is to fill optimistically. Every assumption here is
chosen so that a strategy which survives is more likely to survive contact with
a real venue.

**Determinism over realism-by-jitter.** No randomness in fills: same orders,
same bars, same results, always. A failing backtest that cannot be reproduced
cannot be debugged.

---

## D-020 — Market impact follows the square-root law
**Date:** 2026-08-11 · **Inferred**

Impact ≈ price × ATR-fraction × √(quantity / bar volume).

**Reasoning.** Impact is empirically concave in size, not linear. A linear model
over-penalises small orders and — far more dangerously — *under*-penalises large
ones, which is precisely the regime where a strategy's capacity limit lives. The
square-root form is the standard empirical result and is physically motivated.

**Consequence.** A strategy that only works at sizes the tape cannot absorb
reveals itself in the backtest instead of in production.

---

## D-021 — Correction to D-002: the free tier does not have 10 years of history
**Date:** 2026-08-11 · **Inferred** · **WITHDRAWN the same day — superseded by D-032**

> **This entry was wrong and is kept only so the error is legible.** It measured
> one feed, read a recency restriction as a feed restriction, and concluded the
> free tier lacked history it in fact has. Everything below is the mistaken
> reading; D-032 has the measurement. Nothing should cite this entry as support.

D-002 was chosen partly on the grounds that "Alpaca's free tier includes 10 years
of 1-minute bars — genuinely enough history for pattern sample sizes." **That
premise is false.** Measured against the live API: the IEX daily archive begins
**2020-07-27**, and the SIP feed returns `subscription does not permit querying
recent SIP data` on this tier.

So the free tier supplies roughly **six years** of daily history, not ten, and
none of it predates COVID.

**Why this is being raised rather than absorbed.** D-002 is an *explicitly
chosen* decision and the reasoning under it is now known to be wrong. The
decision may still be correct — starting lean and upgrading on evidence does not
depend on the exact history depth — but it should be re-affirmed knowingly
rather than left resting on a number that does not hold.

**What it costs.** Every backtest sample begins mid-2020. There is no 2008, no
2018Q4, no February 2020 in any of it, so a strategy cannot be stratified across
a real bear regime and "survived a drawdown" cannot be tested at all. Combined
with the existing IEX volume caveat, the honest reading is that the current data
supports *structure and volatility* research and cannot support regime or
volume-dependent claims.

**Options, for the operator.** Accept it and defer (free, and Phase 4 must then
report regime coverage as a known gap). Upgrade to Polygon at ~$79–199/mo, which
D-002 already priced. Backfill deeper daily history from a cheaper one-off
source purely for regime work.

---

## D-022 — Corporate-action announcements use the earliest defensible vendor date
**Date:** 2026-08-11 · **Inferred** (discovered against real data)

`announced_at` for a split is the minimum of the record, payable, process and ex
dates the vendor supplies, rather than `process_date` alone.

**Reasoning.** Alpaca publishes no declaration date, and its `process_date`
turned out to equal the ex-date on *every* split observed. Taken at face value
that told the PIT layer Apple's 4:1 became knowable on the morning it took
effect — a month after the market was told — so every backtest inside the
announcement window read a price series no trader ever saw. Every other date the
vendor does give is bounded below by the declaration (a board declares first,
then record, payable and ex dates are set off it), so the minimum is the
tightest bound that cannot precede the announcement.

Taking a minimum also guarantees `announced_at <= ex_date`, so a vendor row with
a late `process_date` cannot trip the validator and vanish from the adjustment. A
silently missing split leaves an unexplained 75% overnight collapse in the series.

**Still late, never early.** Apple's split was really declared 2020-07-30 and
this dates it 2020-08-24. The error can only withhold an adjustment a backtest
was entitled to.

**Revisit if** a vendor with declaration dates is adopted.

---

## D-023 — Fills are posted from cumulative broker state, not discrete executions
**Date:** 2026-08-11 · **Inferred**

Both fill sources — the `trade_updates` stream and the polling reconciler — call
`postCumulativeFill`, which computes the increment against `filled_quantity`
*while holding the order row lock*. The deduplication key is the cumulative
quantity, not the venue's execution id.

**Reasoning.** A stream event and a poll describe the same economic fill. Keyed
separately — the venue's execution id on one side, a synthesized id on the other
— they do not collide, and a 40-share partial reported by both enters the ledger
as 80. The overfill check does not save you, because 80 is still under a
100-share order. Cumulative quantity is strictly increasing within an order, so
it names the increment uniquely whoever reports it, and computing the delta under
the lock makes the second reporter find nothing to do.

**Consequence.** It also heals gaps: a fill missed entirely while the process was
down appears as one increment at the blended price of exactly those shares, which
is the correct number rather than an approximation. The venue's execution id is
recorded in the audit trail but is deliberately not the key.

**Alternatives.** Stream only (loses everything that happens while disconnected —
and on the first live order the stream delivered nothing at all). Poll only
(coarser and slower to see a fill). One source with the other disabled (whichever
is chosen is a single point of failure for a position nobody is accounting for).

---

## D-024 — Deduplication runs before the order-state and quantity checks
**Date:** 2026-08-11 · **Inferred** (found by a failing test)

**Reasoning.** The commonest replay is the *final* fill of an order: the broker
sends it, we post it, the order goes to `filled`, and the same fill arrives again
down a reconnecting socket. Checking state first rejects that as "this order is
filled and cannot take a fill" and checking quantity first calls it an overfill —
both errors, for an event that needs no action. Only after establishing that a
fill is genuinely new is it meaningful to ask whether the order can accept it.

---

## D-025 — Capital is asserted by a human, never inferred from the broker
**Date:** 2026-08-11 · **Inferred**

`--deposit` records an external contribution and splits it across mandates by
target weight, double-entry. There is deliberately no "read the broker's cash and
make ours match".

**Reasoning.** An unrecorded fill and a genuine deposit both look like "our
number is too low". A command that silently corrects the total would erase
exactly the evidence that distinguishes them — which is the drift reconciliation
exists to catch. Asserting the deposit once gives reconciliation something real
to check against.

**How it surfaced.** The equity curve read zeros. The ledger recorded only flows
we caused, so an account funded with $100,000 at the broker showed three mandates
worth nothing, and the measurement Phase 6 exists to produce was structurally
unable to be right.

---

## D-026 — A strategy trades only at `paper_approved`, and the trading role cannot promote
**Date:** 2026-08-11 · **Inferred**

Strategy rules live in code; standing lives in `strategy_versions`. The loop
considers a strategy only at `paper_approved` or above. Promotion moves one rung
at a time, requires a rationale, and cannot reach live at all by this route.
`vesti_execution` has no write access to `strategies`, so the registry connects
as `vesti_research`.

**Reasoning.** Rules must be reviewable and versioned; whether something is
allowed to trade is an operational state that has to change at 3pm without a
deploy. And an execution service able to authorise its own strategies would make
the ladder decorative — the same argument as D-008, applied to promotion rather
than to orders.

**Consequence.** With nothing promoted the loop runs, marks equity and opens
nothing. That is the correct behaviour for a system whose Strategy Lab does not
exist yet, not a failure to act.

---

## D-027 — Resetting the kill switch requires quoting back the reason
**Date:** 2026-08-11 · **Inferred**

Tripping is one statement and takes effect on the next order. Resetting must pass
the exact reason the switch was tripped for. A second trip does not overwrite the
first reason.

**Reasoning.** The way a kill switch fails is not failing to stop — it is being
cleared by whoever is most inconvenienced by it, before anybody has established
what happened. Quoting the reason back is the cheapest possible evidence that
somebody read it. Keeping the first reason stops an automatic re-trip burying the
human note that says what actually went wrong.

---

## D-028 — Self-crossing mandates are detected, not netted
**Date:** 2026-08-11 · **Inferred, and deliberately incomplete**

Active selling a ticker while Long-Term buys it is coherent under D-009 and is a
wash trade at a single omnibus broker account. `selfcross.ts` refuses before
submission rather than letting the venue reject it cryptically.

**Reasoning for stopping there.** The real answer is to net internally — cross
the shares between mandates at the prevailing price and send only the residual —
and that changes what a fill *means*, because an internal cross has no broker
fill to reconcile against. That is a design decision about the reconciliation
invariant, not a detail, and it belongs with the Phase 6 execution loop rather
than smuggled in beside it.

**Open item.** Until netted, two mandates cannot act on the same name in opposite
directions on the same session. The second one is refused.

---

## D-029 — XBRL facts store raw tags; concept aliasing resolves at read time
**Date:** 2026-08-11 · **Inferred**

`fundamental_facts` stores the filer's own us-gaap concept. The mapping from
`revenue` to `RevenueFromContractWithCustomerExcludingAssessedTax` /
`Revenues` / `SalesRevenueNet` lives in code, preference-ordered, applied on read.

**Reasoning.** Exactly D-006's argument in a different domain. Filers change tags
between years and some emit several at once; canonicalising at write time bakes
one interpretation into permanent storage, and revising it would mean
re-ingesting a decade of filings. Storing raw keeps the revision cheap.

**Related.** `observed_at` is 22:00 UTC on the filing date, matching D-015 —
filings are accepted through the afternoon, so midnight would claim the market
knew a 10-K before it opened that morning.

---

## D-030 — The CIK is recorded on first sight, because EDGAR's ticker file is survivorship-biased
**Date:** 2026-08-11 · **Inferred**

**Reasoning.** `company_tickers.json` lists only currently-listed companies. Once
a name delists it drops out and its ticker can never be resolved to a filer
again — so a survivorship-safe fundamental history depends on having written the
mapping down while the company was still there. Same failure mode D-006 and
`pit_universe` guard against, arriving through a different door.

---

## D-031 — `SimBroker` refuses time-in-force values it cannot model honestly
**Date:** 2026-08-11 · **Inferred**

`TimeInForce` widened to the six the database and real venues accept. The
simulator models `day` and `gtc` and rejects `ioc`, `fok`, `opg` and `cls`.

**Reasoning.** The simulator matches once per session against a daily bar and has
no way to express "fill this instant or cancel". Treating an unrecognised value
as GTC would let an immediate-or-cancel order rest for weeks in a backtest —
which is not a small inaccuracy but a different, better-looking strategy than the
one written. Consistent with D-019: when the model cannot be honest, it refuses
rather than approximates.

**Revisit when** intraday bars are available to the simulator.

---

## D-032 — History comes from the consolidated tape; IEX is only for real time
**Date:** 2026-08-11 · **Inferred** (measured; supersedes D-021 and restores D-002)

`AlpacaProvider` defaults to `feed=sip` and holds the `end` of a SIP request
sixteen minutes behind now. IEX becomes an explicit opt-in (`ALPACA_FEED=iex`)
for the real-time path.

**Reasoning.** D-021 claimed the free tier had ~6 years of partial-tape history
and no SIP. Both halves were wrong, and the error was one request away from being
caught. What the free plan withholds is *recent* SIP — roughly the last fifteen
minutes — not SIP. The restriction is enforced in a way that disguises itself:
an `end` inside that window does not truncate the response, it rejects the whole
request with `subscription does not permit querying recent SIP data`. A daily
backfill ends at today by construction, so every SIP request made the natural way
failed, and the wording of the failure invited exactly the conclusion D-021 drew —
that the tape was a paid feature.

Measured through `AlpacaProvider` after clamping, one symbol, same free keys:

| | sessions | range | 2020-03-16 volume |
|---|---|---|---|
| `sip` | 2,666 | 2016-01-04 → today | 86,579,210 |
| `iex` | 1,518 | 2020-07-27 → today | absent |

**What this changes.** Roughly ten and a half years of history rather than six,
and consolidated volume rather than ~2–3% of it. The regime gap D-021 warned
about does not exist: 2018Q4, the February–March 2020 crash, and 2022 are all
present, so a strategy can be stratified across a real bear market and a drawdown
claim can be tested. The volume caveat in D-002 stops being an inherent property
of the budget and becomes a property of the real-time path alone. No spend is
required to get any of this.

**Cost of being wrong the other way.** Clamping silently withholds bars inside
the delay window. Those are the current session's, which the PIT layer refuses to
serve before its close in any case, so nothing downstream can observe the
difference. Tape is still recorded per row, so a mixed IEX/SIP history stays
honest and recomputable.

**Revisit when** the live path needs sub-15-minute consolidated quotes — that is
what Alpaca's paid tier actually sells, and it is a Phase 5 execution question,
not a research-data one.

---

## D-033 — A filer with no XBRL facts is absent, not failed
**Date:** 2026-08-11 · **Inferred**

`fetchCompanyFacts` returns `null` on a 404 instead of throwing, and the CLI
skips that symbol and counts it. Every other status still throws.

**Reasoning.** An ETF has a CIK and appears in EDGAR's ticker file, but files no
company facts, so `companyfacts` 404s. Treating that as an error aborts the run
at whichever ETF sorts first and loses every filer after it — which is what a
real universe run did, stopping at SPY and taking eight companies with it. A
universe legitimately contains ETFs, so their absence is a normal outcome.

**Why not blanket-catch.** A 403 is the missing-contact refusal and a 429 is the
rate limit. Both must stop the run: read as "this company has no financials",
they would write an empty history for a company that has one.

---

## D-034 — A truncated filing history is reported, never repaired by guess
**Date:** 2026-08-11 · **Inferred**

When a filer's facts span under two years, ingestion prints a warning naming the
CIK and pointing at EDGAR company search. It does not attempt to find the
predecessor.

**Reasoning.** EDGAR's ticker file resolves a ticker to whichever entity
currently files under it, and a reorganization makes that a new CIK with a new
history. Measured: `XOM` resolves to *ExxonMobil Holdings Corp* (CIK
0002115436), whose entire history is 63 facts filed on a single day, while
*Exxon Mobil Corporation* (CIK 0000034088) holds 20,629 fact rows. Nothing
downstream can detect this — the facts are real, consistent, and pass every
validator; there are just almost none, and a quality screen reads that as a
company with no track record rather than a resolution error. D-030 then persists
the mapping.

**Why not resolve it automatically.** Successor linkage is not in
`companyfacts`, so any automatic repair would be a guess written into a
permanent identifier. A wrong CIK silently attached to a real company is worse
than a warning the operator answers once.

**Consequence.** Reorganized tickers need their CIK corrected by hand before
their fundamentals mean anything. `XOM` is currently one of them.
