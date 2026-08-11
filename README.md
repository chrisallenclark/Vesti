# Vesti

An evidence-driven AI investment and trading intelligence system. Three separate
mandates (Active / Catalyst / Long-Term), deterministic risk control, and a
validation ladder honest enough to conclude "no edge found."

Paper trading before real capital. Objective gates before autonomy.

> **Status: Phase 0 complete.** The database enforces the invariants; nothing can
> trade yet and no strategy exists. See [BUILD_STATUS.md](./BUILD_STATUS.md) —
> including its *Honest limitations* section.

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
apps/web/            Next.js 15 PWA. Presentation only — no domain logic.
packages/db/         Migrations, migration runner, invariant tests.   [Phase 0 ✅]
packages/core/       Domain types and the deterministic risk engine.
services/quant/      Python: features, patterns, backtest, Monte Carlo.
```

---

## A note on scope

This is a private tool for managing one person's own investments. Functionality
appropriate for that is not automatically appropriate to offer to others —
delivering personalized recommendations to a third party for compensation
triggers investment-advice regulation. Any such feature sits behind a flag and
gets legal review before implementation, not after.
