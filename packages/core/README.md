# packages/core — domain types and the risk engine

Lands in **Phase 5** (types earlier, as Phase 1 needs them).

Home of the deterministic risk engine:

    evaluate(order_intent, portfolio_state, policies, market_state)
      -> { decision, size, violations[], reasoning[] }

Zero model calls. An LLM produces an intent; only this produces a ruling. Every
call persists a `risk_evaluations` row, and the database refuses any order whose
evaluation does not match it.
