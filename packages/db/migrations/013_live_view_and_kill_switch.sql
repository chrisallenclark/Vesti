-- ============================================================================
-- 013 — What the dashboard needs, without giving it what it must not have.
--
-- Two additions, both shaped by the same constraint: the web app connects as
-- `vesti_app`, which cannot write orders and does not hold broker credentials.
-- That is a boundary worth keeping, so the answer to "the page needs live
-- prices" and "the page needs a kill switch" cannot be "give the page an API
-- key" or "grant it UPDATE".
--
--   BROKER_SNAPSHOTS. Live equity, buying power and open positions as the
--   broker itself reports them, written by the worker on every cycle and read
--   by the page. The alternative — the page calling Alpaca — would put a
--   trading credential in the request path of a web server, where a single
--   server-side template mistake exposes it. This way the page reads a table
--   and the credential stays in the one process that has to have it.
--
--   Current state only, upserted; no history. The equity CURVE is
--   `equity_snapshots`, which is a deliberate daily mark that must reproduce.
--   This is a live read that is stale the moment it is written, and keeping
--   every one of them would grow a table by a row every twenty seconds to
--   answer a question nobody asks about the past.
--
--   VESTI_TRIP_KILL_SWITCH. A SECURITY DEFINER function so the page can HALT
--   trading without being granted write access to the table.
--
--   One direction only, and that asymmetry is the whole design. Stopping is
--   safe from anywhere and must be available from wherever the operator
--   happens to be looking — a kill switch reachable only from a terminal is
--   not reachable at the moment it is needed. RESUMING is not safe from
--   anywhere: it requires quoting back the reason the switch was tripped,
--   which is the cheapest possible check that somebody read it, and it stays
--   with the execution role and its CLI.
-- ============================================================================

CREATE TABLE broker_snapshots (
  account_id    uuid           PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  taken_at      timestamptz    NOT NULL DEFAULT now(),

  cash          numeric(20, 6) NOT NULL,
  buying_power  numeric(20, 6) NOT NULL,
  equity        numeric(20, 6) NOT NULL,
  -- The broker's own count, as [{symbol, quantity, averageCost, marketValue,
  -- unrealizedPnl, currentPrice}]. Kept as jsonb rather than a child table
  -- because it is replaced wholesale every cycle and never queried by symbol.
  positions     jsonb          NOT NULL DEFAULT '[]'::jsonb,
  -- Day P&L as the broker computes it, which is the number the operator will
  -- compare against Alpaca's own screen.
  day_pnl       numeric(20, 6),
  market_open   boolean        NOT NULL DEFAULT false
);

COMMENT ON TABLE broker_snapshots IS
  'The broker''s current view, written by the worker so the web app can show live P&L without holding a trading credential. Current state only — the reproducible daily mark is equity_snapshots.';

GRANT INSERT, UPDATE ON broker_snapshots TO vesti_execution;

-- ── The kill switch, pullable from the request path ─────────────────────────
--
-- SECURITY DEFINER runs as the function's owner, which is the migration role,
-- so `vesti_app` gains exactly this one capability and no other write. The
-- search_path is pinned because a SECURITY DEFINER function that resolves names
-- through the caller's path is a privilege-escalation primitive.

CREATE OR REPLACE FUNCTION vesti_trip_kill_switch(
  p_account_id uuid,
  p_reason     text,
  p_by         text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A kill switch needs a reason. Halting without one leaves the next person nothing to act on.';
  END IF;

  INSERT INTO kill_switch_state (account_id, is_tripped, reason, tripped_at, tripped_by)
  VALUES (p_account_id, true, p_reason, now(), coalesce(p_by, 'operator'))
  ON CONFLICT (account_id) DO UPDATE
    -- An already-tripped switch keeps its ORIGINAL reason. The first cause is
    -- the interesting one; a second trip must not bury it.
    SET is_tripped = true,
        reason     = CASE WHEN kill_switch_state.is_tripped
                          THEN kill_switch_state.reason ELSE EXCLUDED.reason END,
        tripped_at = CASE WHEN kill_switch_state.is_tripped
                          THEN kill_switch_state.tripped_at ELSE EXCLUDED.tripped_at END,
        tripped_by = CASE WHEN kill_switch_state.is_tripped
                          THEN kill_switch_state.tripped_by ELSE EXCLUDED.tripped_by END;

  INSERT INTO audit_log (actor, action, entity_type, entity_id, payload)
  VALUES (coalesce(p_by, 'operator'), 'kill_switch.tripped', 'account', p_account_id,
          jsonb_build_object('reason', p_reason, 'via', 'vesti_trip_kill_switch'));
END;
$$;

COMMENT ON FUNCTION vesti_trip_kill_switch(uuid, text, text) IS
  'Halts new orders on an account. Callable by the web role so the switch is reachable from wherever the operator is looking. There is deliberately no matching reset: resuming requires quoting the reason back and stays with the execution role.';

REVOKE ALL ON FUNCTION vesti_trip_kill_switch(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vesti_trip_kill_switch(uuid, text, text)
  TO vesti_app, vesti_execution;
