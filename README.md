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

```bash
service postgresql start
createdb vesti

cp .env.example .env      # fill in the four role passwords
npm install
npm run db:migrate
npm run db:test           # 25 invariant assertions
```

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
