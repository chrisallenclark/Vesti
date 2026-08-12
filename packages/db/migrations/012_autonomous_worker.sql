-- ============================================================================
-- 012 — What an autonomous worker has to write down.
--
-- Everything before this migration describes a system that decides once a day
-- and is read afterwards. A worker that runs THROUGH a session is watched while
-- it runs, and being watchable is a storage problem: a process that is thinking
-- correctly and a process that is wedged look identical from outside unless it
-- says so on a schedule.
--
-- Three tables, each answering a question the existing schema cannot.
--
--   WORKER_STATE — "is it alive, and is it healthy?" One row per worker, upsert
--   on every cycle. Deliberately NOT append-only and deliberately NOT a log:
--   the dashboard asks for current state on a timer, and a query that has to
--   scan history to find the newest heartbeat gets slower exactly as the
--   session it is watching gets longer. History of what the worker DID lives in
--   activity_log; this is only what it IS.
--
--   Component health is stored per component rather than as one status, because
--   "ERROR" tells an operator nothing about whether to restart the worker or go
--   look at the venue. Alpaca up and market data down is a specific, actionable
--   state and the schema keeps it distinguishable.
--
--   ACTIVITY_LOG — "what is it thinking?" Every scan, refusal, signal, risk
--   ruling, submission and fill, in the words of the rule that produced it. The
--   expensive thing to lose is the REFUSALS: a strategy judged only on the
--   trades it took is judged on a filtered sample, and "why didn't it buy that"
--   is unanswerable after the fact unless the answer was written down when it
--   was still true.
--
--   Append-only by trigger, like the other decision records. A feed that can be
--   edited is a feed that can be made to agree with whatever happened.
--
--   TRADE_DECISIONS — "why is this position on?" One row per order, holding the
--   thesis at the moment of the intent: engine, strategy, signal, entry reason,
--   stop, target, risk amount. All of it is knowable only before submission and
--   none of it is recoverable afterwards — the order row records that 6 shares
--   were bought, never that they were bought because price reclaimed VWAP on
--   1.8x volume with the stop under the opening range.
--
--   Separate from `orders` rather than columns on it because `orders` is the
--   execution record and this is the reasoning record. They have different
--   writers in the long run (the AI layer will author theses; it must never
--   touch orders) and different retention: an order is a fact, a thesis is a
--   claim.
-- ============================================================================

-- ── Worker liveness ─────────────────────────────────────────────────────────

CREATE TYPE worker_status AS ENUM ('starting', 'running', 'idle', 'halted', 'error', 'stopped');

CREATE TABLE worker_state (
  account_id      uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Which loop this is. 'day' now; 'catalyst' and 'wealth' when they exist.
  engine          text          NOT NULL,

  status          worker_status NOT NULL DEFAULT 'starting',
  -- Belt and braces on the paper boundary. The worker writes what it believes
  -- it is, so a dashboard showing PAPER is showing the worker's own claim
  -- rather than a constant compiled into the page.
  trading_mode    text          NOT NULL CHECK (trading_mode IN ('paper', 'live')),
  -- The process incarnation. Changes on every restart, which is how a restart
  -- becomes visible rather than being inferred from a gap in the heartbeats.
  worker_id       text          NOT NULL,
  started_at      timestamptz   NOT NULL DEFAULT now(),

  -- Component health, each with the instant it was last known good. A boolean
  -- alone cannot distinguish "connected" from "was connected an hour ago".
  alpaca_ok       boolean       NOT NULL DEFAULT false,
  market_data_ok  boolean       NOT NULL DEFAULT false,
  database_ok     boolean       NOT NULL DEFAULT true,
  market_open     boolean       NOT NULL DEFAULT false,
  strategy_active boolean       NOT NULL DEFAULT false,
  kill_switch     boolean       NOT NULL DEFAULT false,

  last_beat_at    timestamptz   NOT NULL DEFAULT now(),
  last_data_at    timestamptz,
  last_eval_at    timestamptz,
  last_order_at   timestamptz,

  -- The most recent error and when it happened, kept even after recovery. A
  -- worker that is running now but threw four times in the last minute is not
  -- healthy, and clearing the field on success would hide that.
  last_error      text,
  last_error_at   timestamptz,

  cycles          bigint        NOT NULL DEFAULT 0,
  -- Free-form, for whatever a given engine needs to show. Kept out of columns
  -- because the shape differs per engine and none of it is queried.
  detail          jsonb         NOT NULL DEFAULT '{}'::jsonb,

  PRIMARY KEY (account_id, engine)
);

COMMENT ON TABLE worker_state IS
  'Current liveness of each autonomous engine. Upserted every cycle. A stale last_beat_at is the signal that the worker is gone — the row itself never says so.';

-- ── The activity feed ───────────────────────────────────────────────────────

CREATE TYPE activity_level AS ENUM ('debug', 'info', 'signal', 'warn', 'error');

CREATE TABLE activity_log (
  id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  occurred_at timestamptz   NOT NULL DEFAULT now(),

  engine      text          NOT NULL,
  level       activity_level NOT NULL DEFAULT 'info',
  -- A stable machine key ('scan', 'signal', 'risk_approved', 'risk_refused',
  -- 'order_submitted', 'fill', 'position_opened', 'position_closed', 'halt').
  -- The dashboard groups and colours on this; `message` is for humans only.
  kind        text          NOT NULL,
  symbol      text,
  message     text          NOT NULL,

  -- Links back to the execution record when there is one, so a feed entry can
  -- be opened into the order it describes.
  order_id    uuid          REFERENCES orders(id) ON DELETE SET NULL,
  detail      jsonb         NOT NULL DEFAULT '{}'::jsonb
);

-- The feed is always read newest-first for one account, and almost always for
-- today only.
CREATE INDEX activity_log_feed_idx ON activity_log (account_id, occurred_at DESC);
CREATE INDEX activity_log_symbol_idx ON activity_log (account_id, symbol, occurred_at DESC)
  WHERE symbol IS NOT NULL;

COMMENT ON TABLE activity_log IS
  'What the autonomous loop saw, decided and refused, as it happened. Refusals matter more than fills: a strategy judged only on the trades it took is judged on a filtered sample.';

-- ── The decision record ─────────────────────────────────────────────────────

CREATE TABLE trade_decisions (
  order_id        uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  account_id      uuid           NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- DAY / CATALYST / WEALTH. Stored as the mandate kind the engine trades for,
  -- so a trade can be attributed to an engine without joining through the
  -- strategy registry.
  engine          text           NOT NULL,
  strategy_key    text           NOT NULL,
  strategy_version integer       NOT NULL,
  trading_mode    text           NOT NULL CHECK (trading_mode IN ('paper', 'live')),

  intent          text           NOT NULL CHECK (intent IN ('entry', 'exit')),
  -- The rule that fired, in its own words. Array rather than prose so the
  -- individual conditions stay separable.
  reasons         text[]         NOT NULL DEFAULT '{}',
  -- Everything the strategy was looking at. The only way to re-derive a
  -- decision later without re-fetching a market that has moved on.
  signal          jsonb          NOT NULL DEFAULT '{}'::jsonb,

  reference_price numeric(20, 6),
  stop_price      numeric(20, 6),
  target_price    numeric(20, 6),
  risk_amount     numeric(20, 6),
  confidence      numeric(6, 4),

  -- Set on exits: which rule closed it. Null on entries.
  exit_reason     text,
  decided_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX trade_decisions_account_idx ON trade_decisions (account_id, decided_at DESC);

COMMENT ON TABLE trade_decisions IS
  'The thesis behind one order, captured at intent. Knowable only before submission and not recoverable afterwards.';

-- Append-only, like every other decision record in this schema. Statement-level
-- and using 005's guard, so the enforcement is the same one rather than a
-- second implementation of it that could drift.
CREATE TRIGGER trade_decisions_append_only
  BEFORE UPDATE OR DELETE ON trade_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION vesti_reject_mutation();

CREATE TRIGGER activity_log_append_only
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH STATEMENT EXECUTE FUNCTION vesti_reject_mutation();

-- ── The journal ─────────────────────────────────────────────────────────────
--
-- One row per closed (or open) position leg, assembled from the records that
-- already exist. A view rather than a table because every column is derivable
-- and a materialised copy would be a second source of truth for the one
-- question the system exists to answer.

CREATE VIEW trade_journal AS
SELECT
  o.id                                          AS order_id,
  o.account_id,
  s.symbol,
  m.kind                                        AS mandate,
  d.engine,
  d.strategy_key,
  d.trading_mode,
  d.intent,
  o.side,
  o.quantity,
  o.filled_quantity,
  o.broker_order_id,
  o.status,
  d.reasons,
  d.signal,
  d.reference_price,
  d.stop_price,
  d.target_price,
  d.risk_amount,
  d.confidence,
  d.exit_reason,
  d.decided_at,
  o.submitted_at,
  f.avg_price                                   AS fill_price,
  f.filled_at,
  f.avg_price * o.filled_quantity               AS notional,
  -- Realised P&L exists only on the exit leg: it is proceeds less the basis of
  -- the specific lots this order consumed.
  r.realized_pnl,
  r.holding_seconds
FROM orders o
JOIN securities s ON s.id = o.security_id
JOIN mandates   m ON m.id = o.mandate_id
LEFT JOIN trade_decisions d ON d.order_id = o.id
LEFT JOIN LATERAL (
  SELECT sum(quantity * price) / nullif(sum(quantity), 0) AS avg_price,
         max(filled_at)                                   AS filled_at
    FROM fills WHERE order_id = o.id
) f ON true
LEFT JOIN LATERAL (
  SELECT sum(ola.quantity * (f2.price - l.cost_basis))          AS realized_pnl,
         max(extract(epoch FROM (f2.filled_at - l.opened_at)))  AS holding_seconds
    FROM order_lot_allocations ola
    JOIN lots l ON l.id = ola.lot_id
    JOIN LATERAL (
      SELECT sum(quantity * price) / nullif(sum(quantity), 0) AS price,
             max(filled_at)                                   AS filled_at
        FROM fills WHERE order_id = o.id
    ) f2 ON true
   WHERE ola.order_id = o.id
) r ON true;

COMMENT ON VIEW trade_journal IS
  'Every order with its thesis, its fill and its realised outcome. Derived — there is no second copy of any of this.';

-- ── Grants ──────────────────────────────────────────────────────────────────
--
-- SELECT arrives through the default privileges installed by 005. Only the
-- write paths need naming, and only the execution role gets them: the worker is
-- the only thing that has anything true to say about its own liveness.

GRANT INSERT, UPDATE ON worker_state    TO vesti_execution;
GRANT INSERT          ON activity_log   TO vesti_execution;
GRANT INSERT          ON trade_decisions TO vesti_execution;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vesti_execution;

-- The app needs to read the view explicitly; a view's privileges are its own
-- and are not covered by the default privileges on tables.
GRANT SELECT ON trade_journal TO vesti_app, vesti_research, vesti_execution;
