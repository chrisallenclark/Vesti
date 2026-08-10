-- ============================================================================
-- 002 — Securities master, evidence sources, corporate actions, price bars.
--
-- THE CENTRAL ANTI-LOOK-AHEAD DECISION LIVES HERE.
--
-- Price bars store RAW OHLCV only. There is no adjusted_close column and there
-- never will be. An adjusted price series is a function of every split and
-- dividend that happened *after* the bar — storing it bakes the future into
-- every historical row, and no amount of careful querying can extract it again.
--
-- Instead: raw bars + a bitemporal corporate_actions table, with adjustment
-- applied at query time using only the actions announced on or before the
-- as-of date (see 003). A backtest standing on 2019-06-01 sees the prices a
-- trader saw on 2019-06-01, not the prices we know today.
--
-- Survivorship is handled the same way: delisted securities stay in the master
-- with delisted_at set, and the PIT universe function includes anything listed
-- as of the date being asked about.
-- ============================================================================

-- ── Evidence sources ────────────────────────────────────────────────────────
-- Every externally-sourced fact points at one of these. source_id is NOT NULL
-- on fact tables so an unattributed fact cannot physically be stored.
CREATE TABLE sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text        NOT NULL UNIQUE,  -- 'sec_edgar', 'alpaca', 'clinicaltrials_gov'
  name          text        NOT NULL,
  tier          source_tier NOT NULL,
  base_url      text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER sources_touch BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

INSERT INTO sources (slug, name, tier, base_url) VALUES
  ('sec_edgar',           'SEC EDGAR',            'tier1_primary', 'https://www.sec.gov'),
  ('clinicaltrials_gov',  'ClinicalTrials.gov',   'tier1_primary', 'https://clinicaltrials.gov/api/v2'),
  ('openfda',             'openFDA',              'tier1_primary', 'https://api.fda.gov'),
  ('usaspending',         'USAspending.gov',      'tier1_primary', 'https://api.usaspending.gov'),
  ('alpaca',              'Alpaca Market Data',   'tier1_primary', 'https://data.alpaca.markets'),
  ('manual',              'Manual operator entry','tier1_primary', NULL);

-- ── Securities master ───────────────────────────────────────────────────────
CREATE TABLE securities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol            text        NOT NULL,
  name              text,
  asset_class       asset_class NOT NULL DEFAULT 'equity',
  exchange          text,
  currency          text        NOT NULL DEFAULT 'USD',

  -- Extension point for derivatives (strike, expiry, underlying, multiplier).
  -- NULL for equities and ETFs. Exists from day one so adding options later is
  -- an additive change rather than a reshaping of the core table.
  instrument_terms  jsonb,

  sector            text,
  industry          text,

  -- Survivorship: delisted names are retained, never deleted. A universe built
  -- from `delisted_at IS NULL` is a survivorship-biased universe and will make
  -- every backtest look better than reality.
  listed_at         date,
  delisted_at       date,

  is_tradable       boolean     NOT NULL DEFAULT true,
  source_id         uuid        NOT NULL REFERENCES sources(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT securities_delisted_after_listed
    CHECK (delisted_at IS NULL OR listed_at IS NULL OR delisted_at >= listed_at),
  CONSTRAINT securities_terms_only_for_derivatives
    CHECK (instrument_terms IS NULL OR asset_class IN ('option', 'future'))
);

-- A symbol can be reused after a delisting (tickers get recycled), so symbol
-- alone is not unique — only the currently-listed one is.
CREATE UNIQUE INDEX securities_active_symbol_key
  ON securities (symbol) WHERE delisted_at IS NULL;
CREATE INDEX securities_symbol_idx ON securities (symbol);
CREATE INDEX securities_sector_idx ON securities (sector) WHERE delisted_at IS NULL;

CREATE TRIGGER securities_touch BEFORE UPDATE ON securities
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

-- Cross-reference identifiers (CIK for EDGAR joins, CUSIP, ISIN, FIGI).
CREATE TABLE security_identifiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id  uuid NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  kind         text NOT NULL,   -- 'cik' | 'cusip' | 'isin' | 'figi'
  value        text NOT NULL,
  UNIQUE (kind, value)
);
CREATE INDEX security_identifiers_security_idx ON security_identifiers (security_id);

-- ── Exchange calendars ──────────────────────────────────────────────────────
-- Sessions are explicit rows rather than computed weekday math: half-days,
-- holidays, and historical schedule changes are data, not logic. Time-of-day
-- features and daily-loss-limit windows both depend on this being right.
CREATE TABLE exchange_sessions (
  exchange       text NOT NULL,
  session_date   date NOT NULL,
  open_at        timestamptz NOT NULL,
  close_at       timestamptz NOT NULL,
  is_half_day    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (exchange, session_date),
  CONSTRAINT exchange_sessions_ordered CHECK (close_at > open_at)
);

-- ── Corporate actions (bitemporal) ──────────────────────────────────────────
-- announced_at is the observed_at analogue: the first moment we could have
-- known. ex_date is the effective_at: when it changed the world. Adjusting a
-- backtest with an action the market had not yet been told about is look-ahead.
CREATE TABLE corporate_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id    uuid NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('split', 'cash_dividend', 'spinoff', 'symbol_change')),

  ex_date        date NOT NULL,          -- effective_at
  announced_at   timestamptz NOT NULL,   -- observed_at
  observed_at    timestamptz NOT NULL DEFAULT now(),

  -- 2-for-1 split => split_ratio 2.0. Prices before ex_date divide by this.
  split_ratio    numeric(20, 10),
  -- Per-share cash amount for dividends.
  cash_amount    numeric(20, 6),

  source_id      uuid NOT NULL REFERENCES sources(id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT corporate_actions_split_has_ratio
    CHECK (kind <> 'split' OR (split_ratio IS NOT NULL AND split_ratio > 0)),
  CONSTRAINT corporate_actions_dividend_has_amount
    CHECK (kind <> 'cash_dividend' OR cash_amount IS NOT NULL)
);

CREATE INDEX corporate_actions_pit_idx
  ON corporate_actions (security_id, ex_date, announced_at);

COMMENT ON COLUMN corporate_actions.announced_at IS
  'First moment this action was publicly knowable. PIT adjustment must filter on this, never on ex_date alone.';

-- ── Price bars: RAW ONLY ────────────────────────────────────────────────────
-- Daily bars. Partitioned by year — roughly 5k securities x 252 sessions keeps
-- each partition in the low millions, which indexes well.
CREATE TABLE bars_daily (
  security_id  uuid           NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  session_date date           NOT NULL,
  open         numeric(20, 6) NOT NULL,
  high         numeric(20, 6) NOT NULL,
  low          numeric(20, 6) NOT NULL,
  close        numeric(20, 6) NOT NULL,
  volume       bigint         NOT NULL,
  trade_count  integer,
  vwap         numeric(20, 6),

  tape         market_tape    NOT NULL,
  source_id    uuid           NOT NULL REFERENCES sources(id),
  observed_at  timestamptz    NOT NULL DEFAULT now(),

  PRIMARY KEY (security_id, session_date),
  CONSTRAINT bars_daily_ohlc_coherent CHECK (
    high >= low AND high >= open AND high >= close AND low <= open AND low <= close
  ),
  CONSTRAINT bars_daily_non_negative CHECK (low > 0 AND volume >= 0)
) PARTITION BY RANGE (session_date);

COMMENT ON TABLE bars_daily IS
  'RAW prices as printed. No split/dividend adjustment is ever stored here — adjustment is applied at query time by pit_bars_daily() using only actions announced by the as-of date.';

-- Intraday bars. Partitioned by month: 1-minute data is the volume driver
-- (~390 bars/session/security) and the binding constraint on Active-mandate
-- pattern work.
CREATE TABLE bars_intraday (
  security_id  uuid           NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  ts           timestamptz    NOT NULL,
  timeframe    text           NOT NULL,   -- '1min' | '5min' | '15min' | '1hour' | '4hour'
  open         numeric(20, 6) NOT NULL,
  high         numeric(20, 6) NOT NULL,
  low          numeric(20, 6) NOT NULL,
  close        numeric(20, 6) NOT NULL,
  volume       bigint         NOT NULL,
  trade_count  integer,
  vwap         numeric(20, 6),

  tape         market_tape    NOT NULL,
  source_id    uuid           NOT NULL REFERENCES sources(id),
  observed_at  timestamptz    NOT NULL DEFAULT now(),

  PRIMARY KEY (security_id, timeframe, ts),
  CONSTRAINT bars_intraday_ohlc_coherent CHECK (
    high >= low AND high >= open AND high >= close AND low <= open AND low <= close
  ),
  CONSTRAINT bars_intraday_non_negative CHECK (low > 0 AND volume >= 0)
) PARTITION BY RANGE (ts);

-- Computed feature vectors, versioned so a detector change produces a new row
-- set rather than silently rewriting labeled history.
CREATE TABLE bar_features (
  security_id     uuid        NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  ts              timestamptz NOT NULL,
  timeframe       text        NOT NULL,
  feature_version text        NOT NULL,
  features        jsonb       NOT NULL,

  -- Carried forward from the source bars. Any volume-derived feature computed
  -- from an IEX-only tape is biased; this column is what lets a later full-tape
  -- upgrade find and recompute exactly those rows.
  tape            market_tape NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (security_id, timeframe, feature_version, ts)
) PARTITION BY RANGE (ts);

COMMENT ON COLUMN bar_features.tape IS
  'Tape of the underlying bars. IEX is ~2-3%% of consolidated volume, so RVOL and other volume features derived from it are biased and must be recomputed after a full-tape upgrade.';

-- ── Partition management ────────────────────────────────────────────────────
-- DEFAULT partitions mean an insert outside the provisioned range lands
-- somewhere valid instead of erroring at 2am during an ingest run. A monthly
-- maintenance job moves rows out of the default into real partitions.
CREATE TABLE bars_daily_default    PARTITION OF bars_daily    DEFAULT;
CREATE TABLE bars_intraday_default PARTITION OF bars_intraday DEFAULT;
CREATE TABLE bar_features_default  PARTITION OF bar_features  DEFAULT;

-- Creates a year partition for bars_daily if absent.
CREATE OR REPLACE FUNCTION vesti_ensure_daily_partition(target_year integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  part_name text := format('bars_daily_%s', target_year);
BEGIN
  IF to_regclass(part_name) IS NOT NULL THEN RETURN; END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF bars_daily FOR VALUES FROM (%L) TO (%L)',
    part_name,
    make_date(target_year, 1, 1),
    make_date(target_year + 1, 1, 1)
  );
END;
$$;

-- Creates month partitions for the timestamp-partitioned tables if absent.
CREATE OR REPLACE FUNCTION vesti_ensure_intraday_partition(target_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  month_start date := date_trunc('month', target_month)::date;
  month_end   date := (date_trunc('month', target_month) + interval '1 month')::date;
  suffix      text := to_char(month_start, 'YYYY_MM');
  spec        record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES ('bars_intraday'), ('bar_features')) AS t(parent)
  LOOP
    IF to_regclass(format('%s_%s', spec.parent, suffix)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        format('%s_%s', spec.parent, suffix), spec.parent, month_start, month_end
      );
    END IF;
  END LOOP;
END;
$$;
