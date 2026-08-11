-- ============================================================================
-- 010 — Equity curves and reconciliation history.
--
-- Two tables that exist because of what Phase 6 has to ANSWER, not because of
-- what it has to do.
--
--   EQUITY_SNAPSHOTS. "Does this make money?" is a question about a series, not
--   a balance. A per-mandate daily mark is the only thing that makes an equity
--   curve, a drawdown, a benchmark comparison or an attribution possible, and
--   it cannot be reconstructed later: cash and lots tell you where you are now,
--   and no amount of arithmetic recovers what a mandate was worth on a Tuesday
--   in March. If it is not recorded daily it is gone.
--
--   Per MANDATE rather than per account, because three mandates sharing one
--   account is the entire design. A single account-level curve would average
--   away exactly the comparison the system exists to make.
--
--   RECONCILIATION_RUNS. Reconciliation that nobody records is a function, not
--   a control. Writing every run down — including the clean ones — is what lets
--   the loop refuse to trade on a ledger that has not agreed with the broker
--   recently, and what makes "when did this drift start?" answerable rather
--   than a guess.
--
-- Both are append-only in spirit but NOT trigger-enforced: a snapshot is a
-- derived measurement, and a corrected mark after a late corporate action is a
-- legitimate rewrite. The upsert key makes re-running a day idempotent.
-- ============================================================================

CREATE TABLE equity_snapshots (
  account_id       uuid           NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mandate_id       uuid           NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  as_of            date           NOT NULL,

  -- Cash is this mandate's share of the ledger; positions are its lots marked
  -- at the session close. Equity is the sum, kept as its own column so a query
  -- for the curve does not have to re-derive it every time.
  cash             numeric(20, 6) NOT NULL,
  positions_value  numeric(20, 6) NOT NULL,
  equity           numeric(20, 6) NOT NULL,

  -- Realised P&L to date, so the curve can be split into what was banked and
  -- what is still open — a mandate up 8% on one unrealised position is a very
  -- different thing from one up 8% across thirty closed trades.
  realized_pnl     numeric(20, 6) NOT NULL DEFAULT 0,
  unrealized_pnl   numeric(20, 6) NOT NULL DEFAULT 0,

  open_risk        numeric(20, 6) NOT NULL DEFAULT 0,
  position_count   integer        NOT NULL DEFAULT 0,

  -- Which close the marks came from. A snapshot taken against stale bars is not
  -- wrong so much as differently dated, and knowing which is the difference
  -- between a gap in the curve and a lie in it.
  marked_from      date,
  created_at       timestamptz    NOT NULL DEFAULT now(),

  PRIMARY KEY (account_id, mandate_id, as_of)
);

CREATE INDEX equity_snapshots_curve_idx ON equity_snapshots (mandate_id, as_of);

COMMENT ON TABLE equity_snapshots IS
  'Daily per-mandate mark. Cannot be reconstructed after the fact — if a session is not recorded, that point on the equity curve is permanently lost.';

CREATE TABLE reconciliation_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ran_at            timestamptz NOT NULL DEFAULT now(),
  balanced          boolean     NOT NULL,
  positions_checked integer     NOT NULL DEFAULT 0,
  -- The full report, so a drift can be diagnosed from history rather than by
  -- trying to reproduce the state that caused it.
  discrepancies     jsonb       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX reconciliation_runs_recent_idx ON reconciliation_runs (account_id, ran_at DESC);

COMMENT ON TABLE reconciliation_runs IS
  'Every reconciliation, clean ones included. The loop refuses to trade when the most recent run is stale or unbalanced.';

GRANT INSERT, UPDATE ON equity_snapshots TO vesti_execution;
GRANT INSERT ON reconciliation_runs TO vesti_execution;
