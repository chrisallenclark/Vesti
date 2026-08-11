# packages/core — deterministic domain logic

Everything here is pure: no I/O, no network, no model calls, no clock it does
not own. That is what makes it testable to the standard the rest of the system
assumes.

```
risk/     Sizing engine with veto power over every order.
broker/   BrokerAdapter interface, execution gate, deterministic simulator.
market/   US equity trading calendar.
sim/      Seeded PRNG and synthetic price series with known ground truth.
```

**`risk/`** — `evaluate(intent, portfolio, market, limits)` returns a ruling and
the reasoning that produced it. Eleven steps, each of which can only reduce
size. An LLM produces an *intent*; only this produces a ruling; and the database
refuses any order whose quantity does not match one.

**`broker/`** — `guardedBroker(adapter, guards)` wraps any broker and refuses
orders without a valid, current, matching risk approval, or while the kill
switch is tripped. `SimBroker` fills deliberately pessimistically: no same-bar
signal-and-fill, spread and square-root impact, participation-capped partial
fills.

**`sim/`** — generated series retain the true continuous price of every session,
so the backtester can be checked against a known answer rather than against
plausibility. Prices are emitted raw; splits are announced before they go ex.

    npm test -w @vesti/core
