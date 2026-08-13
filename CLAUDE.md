# Vesti — instructions for future sessions

A private AI investing and trading application for one person. Read this before
changing anything; it records the decisions that are expensive to rediscover.

## What this is

Three eventual engines, each with its own horizon and its own mandate:

| Engine | Mandate (`mandate_kind`) | Horizon | Status |
|---|---|---|---|
| **DAY** | `active` | minutes to hours | first autonomous engine, running on paper |
| **CATALYST** | `catalyst` | days to ~18 months | not built |
| **WEALTH** | `long_term` | multi-year | not built |

Trades are labelled by engine in `trade_decisions.engine`, so the architecture
already carries all three. Do not delay DAY for the other two.

## The current milestone

One autonomous paper-trading loop, working end to end and observable:

```
real market data → strategy → risk engine → execution gate → Alpaca PAPER
  → fill → ledger → dashboard → live P&L → journal
```

Until that loop is solid, do not prioritise new features. In particular do not
add: more AI agents, SEC/ClinicalTrials pipelines, options, crypto, sentiment,
portfolio optimisation, backtesting infrastructure beyond what exists, or more
strategies. One strategy working beats ten half-working.

## Paper safety is mandatory

**Live autonomous trading is not enabled and must never be enabled without an
explicit, separate decision from the owner.** Nothing in a task like "make it
trade better" authorises it.

The worker refuses to start unless all three hold:

1. `ALPACA_TRADING_BASE_URL` is the paper host (`paper-api.alpaca.markets`)
2. `TRADING_MODE` is `PAPER`
3. the `accounts` row has `is_live = false`

`session.ts` and `paper.ts` enforce the URL check independently. Keep all of
these. Live-trading support may stay in the code; PAPER stays the only enabled
execution mode.

## Risk rules are deterministic and live outside the AI layer

A strategy proposes an intent and a stop. It never chooses size. `packages/core/src/risk/engine.ts`
decides, and `guardedBroker` refuses any order that does not match a stored risk
approval. A database trigger refuses an order that has no approving evaluation
at all. **An AI component must never be able to size, approve or bypass a
trade.** If a change would let it, the change is wrong.

The kill switch halts new orders. It can be tripped from anywhere, including the
dashboard; resuming requires quoting the trip reason back through the execution
CLI.

## Role separation is a security boundary

Four Postgres roles, each with the least privilege it can work with:

- `vesti_app` — the web app. SELECT plus a handful of writes. **Cannot write
  `orders`, `fills` or `lots`.** Verify by trying: it gets `permission denied`.
- `vesti_research` — ingest and the AI layer. Cannot trade.
- `vesti_execution` — the only writer of orders, fills, lots and cash.
- `vesti_backtest` — point-in-time views only.

Never hand the web app the execution or backtest URL, and never give the request
path a broker credential. When the page needs live prices, the worker writes
them to `broker_snapshots` and the page reads that table.

## The five invariants

Enforced by the database, not by convention, and covered by
`packages/db/src/invariants.test.ts`:

1. No look-ahead — raw prices stored; adjustment applied at query time from
   actions announced by the as-of date.
2. Only the execution service trades — role separation.
3. No order without a matching risk approval — trigger.
4. Mandate isolation — lots belong to one mandate; an exit cannot reach another's.
5. History is append-only — decision records reject UPDATE/DELETE; `audit_log`
   is hash-chained.

Do not weaken any of them to make a test pass.

## Autonomous trading must be observable

A worker that has silently stopped trading looks exactly like a quiet market.
Three things keep them distinguishable, and all three are load-bearing:

- `worker_state` — a heartbeat with per-component health. A dead worker does not
  write "stopped", it stops writing, so **status is corrected by heartbeat age**
  rather than read from the row.
- `activity_log` — what it saw, decided and refused. The refusals matter more
  than the fills: a strategy judged only on the trades it took is judged on a
  filtered sample.
- `trade_decisions` — the thesis behind each order, captured at intent. None of
  it is recoverable afterwards.

Never render a state the data does not support.

## Idempotence

The worker is restarted routinely — job timeouts, handovers, crashes — so
restart safety is a correctness property, not a nicety:

- every order carries our uuid as `client_order_id`; a duplicate submission is
  refused by the venue and resolved by reading back the order that exists
- fills post cumulatively under a row lock, so the stream and the poller
  describing the same shares cannot book them twice
- `tradedToday` is counted from **orders**, not fills, so a submitted-but-unfilled
  order still uses its shot
- the engine holds nothing across cycles that would be wrong if the process died
- **only one worker may trade an account, and the database decides which.** The
  heartbeat is a lease: whoever wrote it most recently owns the account, a
  worker that finds another id beating within three minutes refuses to start,
  and a stale lease is takeable so a wedged predecessor is recoverable without a
  human. Do not move this back into a CI concurrency group — that guard
  disappears the moment a worker is started by hand, and it lets a broken run
  hold the account for its whole timeout.

## Everything that talks to the network needs a timeout

`fetch` has no default timeout, and a socket that is open but silent never
rejects. The worker's loop is sequential, so one stalled request stops the whole
session while the process goes on looking healthy — which is exactly what the
first live run did, freezing at twelve cycles with the job still green. Every
outbound request carries a timeout, and the cycle itself has a watchdog. Any new
call that leaves the process needs the same, or it reintroduces the failure.

## Talking to the owner

The owner is not a developer and does not live in a terminal. Every instruction
must say **where** it happens, not just what to type: which website, which
button, which folder, which app. "Run `npm run setup`" is not an instruction —
"in Terminal on your Mac, in the Vesti folder, type this" is.

Prefer a path that needs no terminal at all where one exists (a GitHub Actions
run triggered by committing a request file, a setting in a hosting dashboard).
When a terminal is genuinely unavoidable, say so plainly, say it is needed once,
and give the exact location.

## Do not over-engineer

Prefer simple over clever, working over abstract, observable over magical,
deterministic over unpredictable, end-to-end over isolated. Every new service,
abstraction, dependency, table or layer needs a concrete reason. Do not
introduce queues, brokers, containers or microservices without one. Do not
rewrite working code because you would have architected it differently.

Build and verify a vertical slice before widening it.

## Never expose secrets

`.env` is gitignored and holds the real values; `.env.example` is committed and
must never hold one. Credentials live in GitHub Actions secrets. A secret that
reaches a remote stays in the history after deletion — rotate, do not just edit.
Never log a key, never send one to the browser, never put one in a commit.

## Running it

```bash
npm run setup                                    # database, roles, migrations
npm run worker  -w @vesti/execution              # the DAY worker (paper)
npm run dev     -w @vesti/web                    # the dashboard, localhost:3000
npm run session -w @vesti/execution -- --status  # standing, capital, strategies
npm run session -w @vesti/execution -- --halt "reason"
npm run session -w @vesti/execution -- --resume "reason"
npm test                                         # needs Postgres; no internet
```

Unattended, everything runs in GitHub Actions: `intraday.yml` (the DAY worker
through the session), `paper.yml` (the daily swing session after the close),
`promote.yml` (move a strategy along the ladder), `preflight.yml` (read-only
integration check), `ingest.yml`.

**Two facts about how these actually get started, both of which are easy to
assume wrong:**

- `workflow_dispatch` is refused for this repository's token. Every workflow can
  therefore also be started by committing its request file under `.github/`
  (`intraday-request`, `paper-request`, `promote-request`, `preflight-request`).
  That file trigger is the mechanism that works; the dispatch button is not.
- **`on: schedule` only ever runs from the DEFAULT branch.** As of this writing
  `main` is an empty initial commit with no workflows on it, so no cron in this
  repository has ever fired — every run to date was push-triggered from a
  feature branch. Until this work is merged to `main`, the worker does not start
  itself and each session must be kicked off by committing a request file. Do
  not tell the owner a schedule will pick something up without checking what is
  actually on `main`.

One consequence worth planning around: a job is capped at six hours and the
session is six and a half, so one run cannot cover a whole day. The morning run
hits its timeout before the strategy's 15:45 ET flatten, and a successor has to
be queued (the shared `paper-` concurrency group starts it as the first ends) or
an intraday position is carried overnight with gap risk nothing sized for.

## Strategy promotion

A strategy's rules live in code and are reviewable; whether it may trade is
database state that changes without a deploy. The loop trades only at
`paper_approved` or above. Promotion moves one rung at a time and always records
a rationale.

Both strategies currently registered are **unvalidated** — no backtest, no
walk-forward, no regime stratification. They exist so the machinery has
something real to run. Whatever they earn or lose over a few weeks is not
evidence of an edge, and the code says so at length. Do not quietly reframe paper
P&L as validation.
