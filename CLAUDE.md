# Vesti — read this before doing anything

A private, evidence-driven investment and trading system for one person.

**What the owner wants, in his words:** an autonomous trading app that can day
trade *and* invest long-term, build real wealth, and learn from its wins and
mistakes.

Take that seriously and literally. This is meant to trade on its own and make
money — not to be a research toy, a dashboard, or a demo. Build toward a system
that actually places trades, actually compounds capital, and actually improves.

The discipline in this file exists **in service of that goal, not against it.**
Every safeguard here is what separates a system that compounds for years from
one that has a great six months and then gives it all back. The fastest way to
lose a lot of money is to build something that looks like it works.

Read `BUILD_STATUS.md` for where things stand and `ARCHITECTURE.md` for how it
works. `PRODUCT_DECISIONS.md` records why each significant choice was made; add
to it when you make another.

---

## The goal, in one paragraph

Three separate portfolios — **Active** (day trades and swings, minutes to 3
months), **Catalyst** (1–18 months), **Long-Term** (1–10+ years) — each with its
own capital, positions, and risk limits, all trading automatically against real
market prices. Paper first, so that after months of running we can look at three
equity curves and say honestly whether this works; then real capital, by the
staged progression in `ARCHITECTURE.md`. The objective is long-term
risk-adjusted wealth, not trade count and not a good-looking month.

---

## How this system is allowed to learn

"Learn from wins and mistakes" is a real requirement and also the most dangerous
one in the brief, because the obvious implementation ruins everything. A model
that adjusts its rules after a handful of good or bad trades is learning from
noise — it will find a pattern in ten outcomes, tighten around it, and produce
something that looks superb on the past and fails on the future. That is curve
fitting, and it is the most common way automated trading loses real money.

So learning happens, but on rails:

- **Every trade is recorded with what was believed *before* the outcome
  existed** (`pre_trade_records`), so the post-mortem cannot rewrite the thesis
  to match the result.
- **Learning is statistical, not anecdotal.** Expectancy is measured across a
  meaningful sample, broken down by market regime and setup — never inferred
  from a streak.
- **A model may only *propose* a new strategy version**, never edit a live one.
  The old version stays intact and comparable.
- **A proposal earns promotion by passing validation on data it has never
  seen**, evaluated by deterministic code, not by judgement.
- **Demotion is automatic** when a live strategy breaches its limits.

If you are ever about to change trading behaviour because of recent results,
that is the moment to stop and check this section.

---

## Non-negotiables

These came from the owner directly. Do not weaken any of them for convenience,
speed, or a passing test. If one genuinely blocks the task, stop and say so —
do not route around it.

1. **The risk engine has veto power.** A model produces an *intent*; only the
   deterministic engine produces a ruling; only a matching approval yields an
   order. No model may override a hard limit, ever.

2. **A tactical trade must never close a long-term investment.** The same
   ticker can be held in several mandates at once. Positions are specific tax
   lots owned by exactly one mandate. Never average cost. Never a shared
   position row.

3. **No look-ahead bias.** Prices are stored raw; adjustment is computed at
   query time from actions announced on or before the as-of date. There is no
   `adjusted_close` column and there never will be. Backtests read only through
   the `pit_*` functions.

4. **History is append-only.** Hypotheses are recorded before outcomes exist.
   Never silently rewrite, backfill, or "correct" a past record.

5. **Paper before real capital.** No live-trading credential belongs in this
   repo or any environment it runs in until the execution ladder says so.

6. **No model call in the request path.** Screens read precomputed rows. If a
   screen needs a model to render, the design is wrong.

7. **"No trade" is a valid answer, and so is "no edge found."** Cash is a
   position. A strategy that fails validation is a finding, not a failure to be
   engineered around.

8. **Least privilege is a boundary, not a convention.** Research components
   cannot trade. Secrets never reach client-side code.

---

## What counts as deviation

Things a well-meaning assistant does that quietly break this project:

- Adding an `adjusted_close` column, or adjusting prices at write time, because
  it is simpler.
- Using average cost instead of specific lots, because lots are fiddly.
- Skipping the risk evaluation "just for this test" or "just for the seed."
- Making a failing test pass by loosening the assertion instead of fixing the
  code. **If a test fails, the test is probably right.**
- Tuning strategy parameters until a backtest looks good. That is curve
  fitting, and it is the single easiest way to lose real money later.
- Reporting a component as working without running it.
- Filling optimistically in the simulator — same-bar fills, no spread, no
  impact, unlimited size.
- Adding a charting library. Small visuals are hand-built inline SVG by
  deliberate decision (D-013).
- Letting a model write to any table that moves money.

---

## How the owner wants to be talked to

Plainly, and without flattery. State what was actually verified versus what is
assumed. If something is broken, uncertain, or unproven, say so in the same
breath as the good news. A confident wrong answer here costs money, not time.

The owner is learning markets as this is built. Explain *why* a decision was
made, briefly, in ordinary language — not just what was done.

---

## UI

Mobile-first, dark-first, visual-first. Meaning is carried by the graphic —
rings, gauges, ladders, sparklines — with type as caption. Not a wall of text
and not a dense trading terminal. One card answers one question with one
graphic; detail lives behind a tap. Colour is semantic only.

---

## Before saying something is done

```bash
npm test          # every package; currently 159 tests
npm run typecheck # root packages + apps/web
```

Both must be green, and you must have actually run them. Postgres may need
starting first: `service postgresql start`.

Commit to the working branch with a message that explains *why*, not just what.
Do not open a pull request unless asked.
