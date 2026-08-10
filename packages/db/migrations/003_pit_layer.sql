-- ============================================================================
-- 003 — Point-in-time (PIT) access layer.
--
-- This is the only interface the backtester is permitted to use. Migration 005
-- gives the backtest role EXECUTE on these functions and SELECT on nothing —
-- so "don't accidentally read the future" stops being a code review question
-- and becomes a permission the database enforces.
--
-- Every function is SECURITY DEFINER: it reads base tables with the owner's
-- rights on behalf of a caller who has none. search_path is pinned on each one,
-- because a SECURITY DEFINER function with a mutable search_path is a privilege
-- escalation waiting to happen.
--
-- Two distinct kinds of leakage are closed here:
--
--   1. Facts we did not yet have  -> filtered by observed_at / announced_at.
--   2. Adjustments we could not yet have made -> split factors are computed
--      from actions announced on or before the as-of instant, so a backtest
--      standing in 2019 sees 2019's price series, not today's rewritten one.
-- ============================================================================

-- ── Survivorship-safe universe ──────────────────────────────────────────────
-- Anything listed on the date, including names that have since been delisted.
-- Building a universe from currently-listed names is the classic way to make a
-- strategy look profitable: the losers quietly vanish from the sample.
CREATE OR REPLACE FUNCTION pit_universe(p_as_of date)
RETURNS TABLE (
  security_id uuid,
  symbol      text,
  asset_class asset_class,
  exchange    text,
  sector      text,
  industry    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.symbol, s.asset_class, s.exchange, s.sector, s.industry
  FROM securities s
  WHERE (s.listed_at   IS NULL OR s.listed_at   <= p_as_of)
    AND (s.delisted_at IS NULL OR s.delisted_at >  p_as_of);
$$;

COMMENT ON FUNCTION pit_universe(date) IS
  'Securities tradable as of a date, including later-delisted names. Survivorship-safe.';

-- ── Split adjustment factor, as known at a point in time ────────────────────
-- Back-adjustment convention: a bar on date D is divided by the product of all
-- split ratios with ex_date > D. Only splits ANNOUNCED by p_as_of participate,
-- which is what makes this point-in-time rather than merely historical.
--
-- exp(sum(ln(x))) is the product aggregate; split_ratio > 0 is guaranteed by a
-- check constraint in 002, so the logarithm is always defined.
CREATE OR REPLACE FUNCTION pit_split_factor(
  p_security_id  uuid,
  p_session_date date,
  p_as_of        timestamptz
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(exp(sum(ln(ca.split_ratio))), 1.0)::numeric
  FROM corporate_actions ca
  WHERE ca.security_id  = p_security_id
    AND ca.kind         = 'split'
    AND ca.ex_date      > p_session_date
    AND ca.announced_at <= p_as_of;
$$;

-- ── Daily bars, PIT-adjusted ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pit_bars_daily(
  p_as_of       timestamptz,
  p_security_id uuid DEFAULT NULL,
  p_from        date DEFAULT NULL,
  p_to          date DEFAULT NULL
)
RETURNS TABLE (
  security_id  uuid,
  session_date date,
  open         numeric(20, 6),
  high         numeric(20, 6),
  low          numeric(20, 6),
  close        numeric(20, 6),
  volume       bigint,
  vwap         numeric(20, 6),
  tape         market_tape,
  split_factor numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    b.security_id,
    b.session_date,
    (b.open  / f.factor)::numeric(20, 6),
    (b.high  / f.factor)::numeric(20, 6),
    (b.low   / f.factor)::numeric(20, 6),
    (b.close / f.factor)::numeric(20, 6),
    -- Share count moves inversely to price across a split.
    (b.volume * f.factor)::bigint,
    (b.vwap / f.factor)::numeric(20, 6),
    b.tape,
    f.factor
  FROM bars_daily b
  CROSS JOIN LATERAL (
    SELECT coalesce(exp(sum(ln(ca.split_ratio))), 1.0)::numeric AS factor
    FROM corporate_actions ca
    WHERE ca.security_id  = b.security_id
      AND ca.kind         = 'split'
      AND ca.ex_date      > b.session_date
      AND ca.announced_at <= p_as_of
  ) f
  WHERE b.observed_at <= p_as_of
    AND (p_security_id IS NULL OR b.security_id  = p_security_id)
    AND (p_from        IS NULL OR b.session_date >= p_from)
    AND (p_to          IS NULL OR b.session_date <= p_to)
    -- A bar dated after the as-of instant is the future, regardless of when we
    -- happened to record it.
    AND b.session_date <= (p_as_of AT TIME ZONE 'UTC')::date;
$$;

COMMENT ON FUNCTION pit_bars_daily(timestamptz, uuid, date, date) IS
  'Split-adjusted daily bars as they would have appeared at p_as_of. Excludes bars we had not observed and adjustments not yet announced.';

-- ── Intraday bars, PIT-adjusted ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pit_bars_intraday(
  p_as_of       timestamptz,
  p_timeframe   text,
  p_security_id uuid DEFAULT NULL,
  p_from        timestamptz DEFAULT NULL,
  p_to          timestamptz DEFAULT NULL
)
RETURNS TABLE (
  security_id uuid,
  ts          timestamptz,
  timeframe   text,
  open        numeric(20, 6),
  high        numeric(20, 6),
  low         numeric(20, 6),
  close       numeric(20, 6),
  volume      bigint,
  vwap        numeric(20, 6),
  tape        market_tape
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    b.security_id,
    b.ts,
    b.timeframe,
    (b.open  / f.factor)::numeric(20, 6),
    (b.high  / f.factor)::numeric(20, 6),
    (b.low   / f.factor)::numeric(20, 6),
    (b.close / f.factor)::numeric(20, 6),
    (b.volume * f.factor)::bigint,
    (b.vwap / f.factor)::numeric(20, 6),
    b.tape
  FROM bars_intraday b
  CROSS JOIN LATERAL (
    SELECT coalesce(exp(sum(ln(ca.split_ratio))), 1.0)::numeric AS factor
    FROM corporate_actions ca
    WHERE ca.security_id  = b.security_id
      AND ca.kind         = 'split'
      AND ca.ex_date      > (b.ts AT TIME ZONE 'UTC')::date
      AND ca.announced_at <= p_as_of
  ) f
  WHERE b.observed_at <= p_as_of
    AND b.timeframe = p_timeframe
    AND b.ts <= p_as_of
    AND (p_security_id IS NULL OR b.security_id = p_security_id)
    AND (p_from        IS NULL OR b.ts >= p_from)
    AND (p_to          IS NULL OR b.ts <= p_to);
$$;

-- ── Corporate actions known at a point in time ──────────────────────────────
CREATE OR REPLACE FUNCTION pit_corporate_actions(
  p_as_of       timestamptz,
  p_security_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id           uuid,
  security_id  uuid,
  kind         text,
  ex_date      date,
  announced_at timestamptz,
  split_ratio  numeric(20, 10),
  cash_amount  numeric(20, 6)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ca.id, ca.security_id, ca.kind, ca.ex_date, ca.announced_at,
         ca.split_ratio, ca.cash_amount
  FROM corporate_actions ca
  WHERE ca.announced_at <= p_as_of
    AND ca.observed_at  <= p_as_of
    AND (p_security_id IS NULL OR ca.security_id = p_security_id);
$$;

-- ── Feature vectors known at a point in time ────────────────────────────────
CREATE OR REPLACE FUNCTION pit_bar_features(
  p_as_of           timestamptz,
  p_feature_version text,
  p_timeframe       text,
  p_security_id     uuid DEFAULT NULL
)
RETURNS TABLE (
  security_id uuid,
  ts          timestamptz,
  features    jsonb,
  tape        market_tape
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT bf.security_id, bf.ts, bf.features, bf.tape
  FROM bar_features bf
  WHERE bf.feature_version = p_feature_version
    AND bf.timeframe       = p_timeframe
    AND bf.ts             <= p_as_of
    AND (p_security_id IS NULL OR bf.security_id = p_security_id)
$$;
