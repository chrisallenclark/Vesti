-- ============================================================================
-- 005 — Least-privilege roles, row-level security, and append-only enforcement.
--
-- Three separate protections, each closing a failure mode that code review
-- alone does not:
--
--   ROLE SEPARATION. The research and AI components run as a role with no write
--   access to orders, fills, or lots. A prompt injection that convinces the
--   model to "sell everything" produces a permission error, not a trade. Only
--   the execution service can write an order, and only it holds broker
--   credentials.
--
--   PIT ISOLATION. The backtest role gets EXECUTE on pit_* and SELECT on
--   nothing. Reading tomorrow's bar is not a discipline problem; it is a
--   privilege the role does not have.
--
--   APPEND-ONLY HISTORY. Theses, risk rulings, pre-trade records, and the audit
--   log reject UPDATE and DELETE at the table level. "Never silently rewrite
--   history" is enforced by the database, so a bug cannot violate it.
-- ============================================================================

-- ── Roles ───────────────────────────────────────────────────────────────────
-- CREATE ROLE has no IF NOT EXISTS, so each is guarded. Passwords are injected
-- from the environment by the migration runner at apply time — never committed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vesti_app') THEN
    CREATE ROLE vesti_app LOGIN PASSWORD '${VESTI_APP_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vesti_research') THEN
    CREATE ROLE vesti_research LOGIN PASSWORD '${VESTI_RESEARCH_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vesti_execution') THEN
    CREATE ROLE vesti_execution LOGIN PASSWORD '${VESTI_EXECUTION_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vesti_backtest') THEN
    CREATE ROLE vesti_backtest LOGIN PASSWORD '${VESTI_BACKTEST_PASSWORD}';
  END IF;
END
$$;

-- Start from zero for every role, then grant deliberately.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vesti_app, vesti_research, vesti_execution, vesti_backtest;

-- Nothing is readable by default; each grant below is a decision.
REVOKE ALL ON ALL TABLES IN SCHEMA public
  FROM vesti_app, vesti_research, vesti_execution, vesti_backtest;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public
  FROM vesti_app, vesti_research, vesti_execution, vesti_backtest;

-- ── vesti_app: the request path ─────────────────────────────────────────────
-- Reads everything the UI renders. Writes only things a person authors directly.
-- Cannot create an order; the app calls the execution service for that.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vesti_app;
GRANT INSERT, UPDATE ON journal_entries, users, mandates, risk_policies TO vesti_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vesti_app;

-- ── vesti_research: ingest + AI layer ───────────────────────────────────────
-- Owns evidence and derived analytics. Deliberately has no write path to
-- anything that moves money.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vesti_research;
GRANT INSERT, UPDATE ON
  sources, securities, security_identifiers, exchange_sessions,
  corporate_actions, bars_daily, bars_intraday, bar_features,
  strategies, strategy_versions, setups, setup_versions
  TO vesti_research;
GRANT INSERT ON audit_log, decision_snapshots TO vesti_research;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vesti_research;

-- ── vesti_execution: the only role that can trade ───────────────────────────
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vesti_execution;
GRANT INSERT, UPDATE ON
  orders, fills, lots, order_lot_allocations, cash_ledger,
  risk_evaluations, kill_switch_state, drawdown_state,
  pre_trade_records, post_trade_reviews
  TO vesti_execution;
GRANT INSERT ON audit_log, decision_snapshots TO vesti_execution;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vesti_execution;

-- ── vesti_backtest: PIT views only ──────────────────────────────────────────
-- No table grants at all. The only way in is through the SECURITY DEFINER
-- functions, which filter by observed_at and announced_at.
GRANT EXECUTE ON FUNCTION
  pit_universe(date),
  pit_split_factor(uuid, date, timestamptz),
  pit_bars_daily(timestamptz, uuid, date, date),
  pit_bars_intraday(timestamptz, text, uuid, timestamptz, timestamptz),
  pit_corporate_actions(timestamptz, uuid),
  pit_bar_features(timestamptz, text, text, uuid)
  TO vesti_backtest;

-- Future tables must not silently become readable by everyone.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO vesti_app, vesti_research, vesti_execution;

-- ── Append-only enforcement ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION vesti_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Write a new row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- Statement-level so it fires even on a zero-row UPDATE, and cannot be dodged
-- by a WHERE clause that happens to match nothing.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_log',
    'risk_evaluations',
    'pre_trade_records',
    'decision_snapshots',
    'strategy_versions',
    'setup_versions',
    'fills'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only
         BEFORE UPDATE OR DELETE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION vesti_reject_mutation()',
      t, t
    );
  END LOOP;
END
$$;

-- ── An order may not exist without an approving risk evaluation ─────────────
-- The LLM produces an intent; the risk engine produces the ruling; only a
-- matching approved ruling lets an order leave pending_risk.
CREATE OR REPLACE FUNCTION vesti_enforce_risk_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ev record;
BEGIN
  IF NEW.status = 'pending_risk' OR NEW.status = 'rejected_risk' THEN
    RETURN NEW;  -- pre-ruling states carry no evaluation yet
  END IF;

  IF NEW.risk_evaluation_id IS NULL THEN
    RAISE EXCEPTION
      'order % cannot enter status % without a risk evaluation', NEW.id, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO ev FROM risk_evaluations WHERE id = NEW.risk_evaluation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'risk evaluation % not found', NEW.risk_evaluation_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The evaluation must be for THIS order, not merely any approval on file.
  IF ev.decision = 'reject' THEN
    RAISE EXCEPTION 'risk evaluation % rejected this order', ev.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF ev.account_id <> NEW.account_id OR ev.mandate_id <> NEW.mandate_id
     OR ev.security_id <> NEW.security_id OR ev.side <> NEW.side THEN
    RAISE EXCEPTION
      'risk evaluation % does not match order % (account/mandate/security/side)',
      ev.id, NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.quantity > ev.approved_qty THEN
    RAISE EXCEPTION
      'order quantity % exceeds risk-approved quantity % (evaluation %)',
      NEW.quantity, ev.approved_qty, ev.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_risk_gate
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION vesti_enforce_risk_gate();

-- ── Row-level security ──────────────────────────────────────────────────────
-- Single-user today, so these policies are quiet. They exist now because
-- retrofitting RLS onto a populated multi-user database is where tenancy bugs
-- come from. Identity is carried in a session GUC set by the connection pool.
CREATE OR REPLACE FUNCTION vesti_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('vesti.current_user_id', true), '')::uuid;
$$;

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('users',           'id'),
      ('mandates',        'user_id'),
      ('accounts',        'user_id'),
      ('risk_policies',   'user_id'),
      ('strategies',      'user_id'),
      ('journal_entries', 'user_id')
    ) AS t(tbl, col)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', spec.tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', spec.tbl);
    EXECUTE format(
      'CREATE POLICY %I_owner ON %I
         USING (%I = vesti_current_user_id() OR vesti_current_user_id() IS NULL)
         WITH CHECK (%I = vesti_current_user_id() OR vesti_current_user_id() IS NULL)',
      spec.tbl, spec.tbl, spec.col, spec.col
    );
  END LOOP;
END
$$;

COMMENT ON FUNCTION vesti_current_user_id() IS
  'Reads vesti.current_user_id from the session. NULL (unset) means unrestricted, which is correct for migrations and the single-user deployment but must be set per-request once multi-user ships.';
