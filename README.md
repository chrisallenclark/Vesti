# Vesti

An evidence-driven AI investment and trading intelligence system. Three separate
mandates (Active / Catalyst / Long-Term), deterministic risk control, and a
validation ladder honest enough to conclude "no edge found."

Paper trading before real capital. Objective gates before autonomy.

> **Status: the DAY engine trades on paper, autonomously, and you can watch it.**
> A worker runs through the session on real market data; entries and exits go
> through the deterministic risk engine and the execution gate to Alpaca PAPER,
> fills come back into the ledger, and the dashboard shows it happening. The
> strategy behind it is **unvalidated** — it exists so the machinery has
> something real to run, not because it has an edge. CATALYST and WEALTH are not
> built. See [BUILD_STATUS.md](./BUILD_STATUS.md), including its *Honest
> limitations*.

---

## Watching it trade

Two processes against the same database. The dashboard is read-only and holds no
broker credential.

```bash
npm run worker -w @vesti/execution   # the DAY worker — paper only, refuses otherwise
npm run dev    -w @vesti/web         # the desk, at localhost:3000
```

The desk shows the mode, portfolio value, today's P&L, cash and buying power,
open positions with the stop and target recorded at entry, working orders, what
the trader is thinking as it thinks it, the journal, and a kill switch. It polls
every three seconds; nothing needs refreshing.

Status is corrected by heartbeat age rather than read from the worker's last row
— a process that dies stops writing rather than writing "stopped", so a
dashboard that trusts the row shows RUNNING for something that has not existed
since 10:40.

Before a session, or during one when it has not traded and you want to know why:

```bash
npm run preflight -w @vesti/execution
```

Every line is a live round trip — authentication, balances, positions, working
orders, the venue clock, the database, the feed — and it finishes by running the
real strategy over the real feed and printing what each rule concluded about
each symbol. It is strictly read-only, so it is safe to run while the worker is
running.

### On your phone

The desk is a normal web app, so putting it on a phone means hosting it. It is
built to deploy on Vercel with no configuration beyond three settings:

| Setting | Value |
|---|---|
| Root directory | `apps/web` |
| `DATABASE_URL_APP` | the `vesti_app` URL from `.env` — **not** the execution one |
| `VESTI_PASSCODE` | any long phrase you choose |

Then open `https://<your-app>.vercel.app/?passcode=<your passcode>` once on the
phone and use **Share -> Add to Home Screen**. It opens without browser chrome
and keeps you signed in for a month.

**`VESTI_PASSCODE` is not optional.** This page shows a real portfolio and can
halt a real trading loop, and a URL nobody has guessed yet is not a secret — it
is an unlocked door in a quiet street. Without the passcode set, the gate in
`middleware.ts` is open. With it set, everything except the icons answers 404
until the right one is presented, and the cookie stored afterwards is an HMAC
rather than the passcode itself.

The app connects as `vesti_app`, which cannot write orders, fills or lots and
holds no broker credential. The worst a stolen session can do is read, and trip
the kill switch — which only ever stops trading.

Unattended, the same worker runs in GitHub Actions through each session
(`intraday.yml`). `workflow_dispatch` is refused for this repository's token, so
every workflow can also be started by committing its request file under
`.github/`.

**Paper only.** The worker refuses to start unless the trading URL is Alpaca's
paper host, `TRADING_MODE` is `PAPER`, and the account row says `is_live = false`.
Live autonomous trading is not enabled and will not be without a deliberate,
separate decision.

---

## The idea

Most "AI trading" systems are excellent at explaining yesterday. This one records
its hypothesis **before** the outcome exists, measures what actually happened,
and compares against a benchmark — so the question "does this add risk-adjusted
value?" has an answer rather than a narrative.

Five invariants make that claim checkable, and each is enforced by the database
rather than by convention:

| Invariant | Mechanism |
|---|---|
| No look-ahead bias | Raw prices only; adjustment applied at query time from actions announced by the as-of date. Backtest role cannot read base tables. |
| Only the execution service trades | Postgres role separation. Research and AI components get `permission denied` on `orders`. |
| No order without risk approval | Trigger verifies the risk evaluation matches this order and quantity is within what was approved. |
| Mandate isolation | Positions are tax lots owned by one mandate; a tactical stop cannot sell long-term shares. |
| History is append-only | `UPDATE`/`DELETE` rejected on decision records; `audit_log` is hash-chained. |

All five are covered by 25 assertions in `packages/db/src/invariants.test.ts`,
run against a database built from nothing.

---

## Quick start

### Without a terminal

Setting up from a laptop means a shell whose exported variables can disagree
with its config file, which is where most of the failures came from. Running it
on a clean runner removes that whole class of problem.

Add three repository secrets — **Settings → Secrets and variables → Actions →
New repository secret**:

| Secret | Value |
|---|---|
| `DATABASE_URL` | the connection string from your database dashboard |
| `ALPACA_API_KEY_ID` | starts with `PK` |
| `ALPACA_API_SECRET_KEY` | the longer value, shown once when the key is created |

Then **Actions → Set up and ingest → Run workflow**. It migrates and loads about
ten years of prices, corporate actions and EDGAR fundamentals, and finishes by
printing what actually landed. Tick `skip_market_data` to migrate before you
have Alpaca keys.

Secrets are encrypted, unreadable after saving, and masked in logs. They are the
right home for these values — unlike `.env.example`, which is committed.

### From a terminal

Any Postgres will do — a hosted one (Neon, Supabase, RDS) or a local one. Have
its connection string ready, plus free [Alpaca](https://alpaca.markets) API keys.

```bash
npm install
npm run setup
```

`setup` asks for the database connection string and the Alpaca keys, then does
the rest: derives the four role URLs, generates and applies the role passwords,
proves the connection, migrates, and ingests ten years of prices, corporate
actions and EDGAR fundamentals. It is idempotent — run it again after rotating a
credential and it repairs the rest. `npm run setup -- --no-ingest` stops after
migrating.

Real values go in `.env`, which is gitignored. **Never put them in
`.env.example`** — that file is committed, and a credential that reaches a
remote stays in the history even after it is deleted.

<details>
<summary>Doing it by hand</summary>

```bash
service postgresql start
createdb vesti

cp .env.example .env      # fill in DATABASE_URL and the four role passwords
npm install
npm run db:migrate
npm run db:test           # 25 invariant assertions
```

The role passwords in `.env` must match the roles in the database. Migration 005
creates them behind `IF NOT EXISTS`, so it sets each password exactly once per
cluster and silently ignores a later change — the mismatch surfaces much later as
`password authentication failed`. `npm run setup` re-applies them on every run,
which is the main reason to prefer it.

</details>

---

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System shape, the five invariants, data model, AI routing, risk engine, validation ladder |
| [BUILD_STATUS.md](./BUILD_STATUS.md) | Phase table, what Phase 0 delivered, verified behaviour, honest limitations |
| [PRODUCT_DECISIONS.md](./PRODUCT_DECISIONS.md) | Every decision with reasoning, alternatives, and whether it was chosen or inferred |

---

## Layout

```
apps/web/            Next.js PWA. The desk. Presentation only — no domain logic,
                     no broker credential, and no write path to orders.
packages/db/         Migrations, migration runner, invariant tests.
packages/core/       Pure domain: risk engine, strategies, calendar. No I/O.
packages/execution/  The worker, the ledger, the Alpaca adapter, reconciliation.
packages/ingest/     Market data and evidence into the point-in-time layer.
packages/lab/        Backtester.
services/quant/      Python: features, patterns, Monte Carlo.
```

---

## A note on scope

This is a private tool for managing one person's own investments. Functionality
appropriate for that is not automatically appropriate to offer to others —
delivering personalized recommendations to a third party for compensation
triggers investment-advice regulation. Any such feature sits behind a flag and
gets legal review before implementation, not after.
