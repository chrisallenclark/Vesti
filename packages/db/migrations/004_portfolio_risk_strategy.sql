-- ============================================================================
-- 004 — Mandates, lot-level positions, orders, risk, strategies, decisions.
--
-- Two invariants are enforced structurally here rather than in application code:
--
--   MANDATE ISOLATION. The same ticker can be a multi-year core holding and a
--   two-day tactical trade at the same time. Those are different capital, with
--   different theses and different exits, and a tactical stop must never be
--   able to sell the long-term shares. Positions are therefore tax LOTS, exits
--   name the specific lots they close, and a trigger rejects any allocation
--   whose lot belongs to a different mandate than the order.
--
--   NO ORDER WITHOUT AN APPROVED RISK EVALUATION. orders.risk_evaluation_id is
--   required the moment an order leaves 'pending_risk', and a trigger checks
--   that the referenced evaluation actually approved *this* order. An LLM can
--   produce an intent; only the risk engine can produce something submittable.
-- ============================================================================

-- ── Mandates and accounts ───────────────────────────────────────────────────
CREATE TABLE mandates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            mandate_kind NOT NULL,
  name            text         NOT NULL,
  -- Share of total capital this mandate is allowed. Enforced by the risk
  -- engine; stored here so allocation is configuration, not code.
  target_weight   numeric(6, 4) NOT NULL DEFAULT 0 CHECK (target_weight BETWEEN 0 AND 1),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind)
);
CREATE TRIGGER mandates_touch BEFORE UPDATE ON mandates
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

-- A broker account. `is_live` gates everything dangerous; the execution service
-- refuses live accounts below the L3 promotion gate.
CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker         text    NOT NULL,              -- 'sim' | 'alpaca' | 'ibkr'
  external_id    text,
  is_live        boolean NOT NULL DEFAULT false,
  base_currency  text    NOT NULL DEFAULT 'USD',
  opened_at      timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

-- ── Cash ─────────────────────────────────────────────────────────────────────
-- A ledger, not a balance column. Balance is a fold over entries, so cash is
-- always explicable and never silently drifts.
CREATE TABLE cash_ledger (
  id          bigserial PRIMARY KEY,
  account_id  uuid           NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mandate_id  uuid           REFERENCES mandates(id) ON DELETE RESTRICT,
  occurred_at timestamptz    NOT NULL DEFAULT now(),
  kind        text           NOT NULL CHECK (kind IN
                ('deposit','withdrawal','buy','sell','dividend','fee','interest','allocation')),
  amount      numeric(20, 6) NOT NULL,  -- signed: credits positive
  reference   text,
  created_at  timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX cash_ledger_account_idx ON cash_ledger (account_id, occurred_at);

-- ── Tax lots ────────────────────────────────────────────────────────────────
CREATE TABLE lots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NOT NULL and RESTRICT: a lot always belongs to exactly one mandate, and a
  -- mandate cannot be deleted out from under open positions.
  mandate_id     uuid NOT NULL REFERENCES mandates(id) ON DELETE RESTRICT,
  security_id    uuid NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,

  opened_at      timestamptz    NOT NULL,
  quantity       numeric(20, 8) NOT NULL CHECK (quantity > 0),
  remaining      numeric(20, 8) NOT NULL CHECK (remaining >= 0),
  cost_basis     numeric(20, 6) NOT NULL,  -- per share, net of fees

  -- The plan for this specific lot, captured at entry. Kept on the lot rather
  -- than derived later so a post-mortem compares against the real intent.
  strategy_version_id uuid,
  stop_price     numeric(20, 6),
  target_price   numeric(20, 6),
  thesis_version_id   uuid,

  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lots_remaining_within_quantity CHECK (remaining <= quantity),
  CONSTRAINT lots_closed_when_empty CHECK (
    (remaining = 0 AND closed_at IS NOT NULL) OR (remaining > 0 AND closed_at IS NULL)
  )
);
CREATE INDEX lots_open_idx ON lots (account_id, mandate_id, security_id) WHERE remaining > 0;
CREATE TRIGGER lots_touch BEFORE UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

-- ── Risk ────────────────────────────────────────────────────────────────────
CREATE TABLE risk_policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mandate_id   uuid         REFERENCES mandates(id) ON DELETE CASCADE,
  name         text         NOT NULL,
  -- Limits as data so they are auditable and versionable, not scattered through
  -- code. The risk engine reads these; nothing else may.
  limits       jsonb        NOT NULL,
  effective_at timestamptz  NOT NULL DEFAULT now(),
  created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX risk_policies_lookup_idx ON risk_policies (user_id, mandate_id, effective_at DESC);

-- Every risk ruling, kept forever. Append-only (enforced in 005).
CREATE TABLE risk_evaluations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid           NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mandate_id      uuid           NOT NULL REFERENCES mandates(id) ON DELETE RESTRICT,
  security_id     uuid           NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
  side            order_side     NOT NULL,

  requested_qty   numeric(20, 8) NOT NULL CHECK (requested_qty > 0),
  approved_qty    numeric(20, 8) NOT NULL CHECK (approved_qty >= 0),
  decision        risk_decision  NOT NULL,

  -- Which limit stopped or shrank it, and the inputs used. This is what makes
  -- "why was this trade rejected?" answerable months later.
  violations      jsonb          NOT NULL DEFAULT '[]'::jsonb,
  inputs          jsonb          NOT NULL DEFAULT '{}'::jsonb,
  policy_id       uuid           REFERENCES risk_policies(id),
  engine_version  text           NOT NULL,
  evaluated_at    timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT risk_evaluations_reject_is_zero
    CHECK (decision <> 'reject' OR approved_qty = 0),
  CONSTRAINT risk_evaluations_approved_within_requested
    CHECK (approved_qty <= requested_qty)
);
CREATE INDEX risk_evaluations_account_idx ON risk_evaluations (account_id, evaluated_at DESC);

-- Single-row-per-account switch, read by the execution service on every order
-- and on a timer. Tripping it is instant and does not require a deploy.
CREATE TABLE kill_switch_state (
  account_id   uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  is_tripped   boolean     NOT NULL DEFAULT false,
  reason       text,
  tripped_at   timestamptz,
  tripped_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER kill_switch_touch BEFORE UPDATE ON kill_switch_state
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

-- High-water mark tracking drives the drawdown risk ladder.
CREATE TABLE drawdown_state (
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mandate_id       uuid NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  high_water_mark  numeric(20, 6) NOT NULL,
  current_equity   numeric(20, 6) NOT NULL,
  as_of            timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, mandate_id)
);

-- ── Strategies and setups (versioned, append-only) ──────────────────────────
CREATE TABLE strategies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        text         NOT NULL,
  name        text         NOT NULL,
  mandate_kind mandate_kind NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE TABLE strategy_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id   uuid            NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  version       integer         NOT NULL,
  status        strategy_status NOT NULL DEFAULT 'experimental',

  spec          jsonb           NOT NULL,  -- declarative rules
  impl_hash     text,                      -- content hash of the Python module
  -- 'human' | 'ai_proposed'. An AI may write a row here, but promotion out of
  -- 'experimental' is a deterministic gate evaluation, never a model's opinion.
  authored_by   text            NOT NULL DEFAULT 'human',
  rationale     text,

  created_at    timestamptz     NOT NULL DEFAULT now(),
  UNIQUE (strategy_id, version)
);
CREATE INDEX strategy_versions_status_idx ON strategy_versions (status);

CREATE TABLE setups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE setup_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setup_id    uuid    NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  -- pattern + context predicate + entry + invalidation + exit, all declarative.
  spec        jsonb   NOT NULL,
  detector_hash text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (setup_id, version)
);

-- ── Orders and fills ────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid           NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mandate_id          uuid           NOT NULL REFERENCES mandates(id) ON DELETE RESTRICT,
  security_id         uuid           NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,

  side                order_side     NOT NULL,
  kind                order_kind     NOT NULL,
  quantity            numeric(20, 8) NOT NULL CHECK (quantity > 0),
  limit_price         numeric(20, 6),
  stop_price          numeric(20, 6),
  tif                 time_in_force  NOT NULL DEFAULT 'day',
  status              order_status   NOT NULL DEFAULT 'pending_risk',

  -- The risk engine's ruling. Required before the order may leave pending_risk.
  risk_evaluation_id  uuid REFERENCES risk_evaluations(id),
  strategy_version_id uuid REFERENCES strategy_versions(id),
  pre_trade_record_id uuid,   -- FK added after pre_trade_records exists

  broker_order_id     text,
  submitted_at        timestamptz,
  filled_quantity     numeric(20, 8) NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT orders_limit_price_required
    CHECK (kind NOT IN ('limit','stop_limit') OR limit_price IS NOT NULL),
  CONSTRAINT orders_stop_price_required
    CHECK (kind NOT IN ('stop','stop_limit') OR stop_price IS NOT NULL),
  CONSTRAINT orders_filled_within_quantity CHECK (filled_quantity <= quantity)
);
CREATE INDEX orders_account_idx ON orders (account_id, created_at DESC);
CREATE INDEX orders_open_idx ON orders (account_id, status)
  WHERE status IN ('pending_new','working','partially_filled');
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

CREATE TABLE fills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid           NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  filled_at    timestamptz    NOT NULL,
  quantity     numeric(20, 8) NOT NULL CHECK (quantity > 0),
  price        numeric(20, 6) NOT NULL CHECK (price > 0),
  fees         numeric(20, 6) NOT NULL DEFAULT 0,
  broker_fill_id text,
  created_at   timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX fills_order_idx ON fills (order_id);

-- Which lots a sell order closes. Specific-lot accounting, and the seam where
-- mandate isolation is enforced.
CREATE TABLE order_lot_allocations (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id  uuid           NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  lot_id    uuid           NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  quantity  numeric(20, 8) NOT NULL CHECK (quantity > 0),
  UNIQUE (order_id, lot_id)
);

-- THE mandate-isolation guard. A tactical Active exit physically cannot name a
-- Long-Term lot, even if application code has a bug.
CREATE OR REPLACE FUNCTION vesti_enforce_lot_mandate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_mandate uuid;
  lot_mandate   uuid;
  order_account uuid;
  lot_account   uuid;
BEGIN
  SELECT mandate_id, account_id INTO order_mandate, order_account
    FROM orders WHERE id = NEW.order_id;
  SELECT mandate_id, account_id INTO lot_mandate, lot_account
    FROM lots WHERE id = NEW.lot_id;

  IF order_mandate IS DISTINCT FROM lot_mandate THEN
    RAISE EXCEPTION
      'mandate isolation violated: order % is mandate %, lot % is mandate %',
      NEW.order_id, order_mandate, NEW.lot_id, lot_mandate
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF order_account IS DISTINCT FROM lot_account THEN
    RAISE EXCEPTION 'account mismatch: order % and lot % belong to different accounts',
      NEW.order_id, NEW.lot_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_lot_allocations_mandate_guard
  BEFORE INSERT OR UPDATE ON order_lot_allocations
  FOR EACH ROW EXECUTE FUNCTION vesti_enforce_lot_mandate();

-- ── Decision records ────────────────────────────────────────────────────────
-- Written BEFORE the order is submitted. This is what makes the system
-- falsifiable: the hypothesis is timestamped ahead of the outcome, so a
-- post-mortem cannot quietly rewrite what we believed at entry.
CREATE TABLE pre_trade_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mandate_id          uuid        NOT NULL REFERENCES mandates(id) ON DELETE RESTRICT,
  security_id         uuid        NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
  strategy_version_id uuid        REFERENCES strategy_versions(id),
  setup_version_id    uuid        REFERENCES setup_versions(id),

  recorded_at         timestamptz NOT NULL DEFAULT now(),
  side                order_side  NOT NULL,
  planned_quantity    numeric(20, 8) NOT NULL,
  planned_entry       numeric(20, 6),
  planned_stop        numeric(20, 6),
  planned_target      numeric(20, 6),
  planned_risk_amount numeric(20, 6),
  expected_hold       interval,

  thesis              text        NOT NULL,
  invalidation        text        NOT NULL,
  evidence            jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- source ids + claims
  market_regime       text,
  confidence          numeric(4, 3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),

  CONSTRAINT pre_trade_stop_differs_from_entry
    CHECK (planned_stop IS NULL OR planned_entry IS NULL OR planned_stop <> planned_entry)
);
CREATE INDEX pre_trade_records_security_idx ON pre_trade_records (security_id, recorded_at DESC);

ALTER TABLE orders
  ADD CONSTRAINT orders_pre_trade_record_fk
  FOREIGN KEY (pre_trade_record_id) REFERENCES pre_trade_records(id);

-- Exactly what the system knew at a decision point, so any decision is
-- reconstructable without trusting that upstream tables were never edited.
CREATE TABLE decision_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pre_trade_record_id uuid        REFERENCES pre_trade_records(id) ON DELETE CASCADE,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  as_of               timestamptz NOT NULL,
  data_hash           text        NOT NULL,   -- hash of the inputs used
  source_ids          uuid[]      NOT NULL DEFAULT '{}',
  model_id            text,
  prompt_version      text,
  strategy_version_id uuid REFERENCES strategy_versions(id),
  risk_evaluation_id  uuid REFERENCES risk_evaluations(id),
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE post_trade_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id              uuid        REFERENCES lots(id) ON DELETE CASCADE,
  pre_trade_record_id uuid        REFERENCES pre_trade_records(id),
  reviewed_at         timestamptz NOT NULL DEFAULT now(),

  realized_return     numeric(12, 6),
  r_multiple          numeric(12, 6),
  benchmark_return    numeric(12, 6),
  max_adverse_excursion numeric(12, 6),
  max_favorable_excursion numeric(12, 6),

  followed_plan       boolean,
  -- The distinction that matters: a good decision with a bad outcome is not a
  -- mistake, and a bad decision with a lucky outcome is not a success.
  decision_quality    text CHECK (decision_quality IN
                        ('good_decision','bad_decision','indeterminate')),
  lessons             text,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE journal_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author      text        NOT NULL CHECK (author IN ('human','system')),
  subject     text,
  body        text        NOT NULL,
  security_id uuid REFERENCES securities(id) ON DELETE SET NULL,
  lot_id      uuid REFERENCES lots(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_user_idx ON journal_entries (user_id, created_at DESC);
