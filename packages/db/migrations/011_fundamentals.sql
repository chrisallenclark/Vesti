-- ============================================================================
-- 011 — XBRL fundamentals, bitemporal.
--
-- The Long-Term mandate screens on quality and valuation — ROIC, FCF growth,
-- balance-sheet strength — and every one of those is a trap without point-in-time
-- discipline, in a way that is worse than prices.
--
-- A price is knowable the moment it prints. A financial fact is not: Q4 revenue
-- describes a period that ended in December and becomes public in February. A
-- backtest that reads December's revenue in December is not slightly optimistic,
-- it is clairvoyant, and the resulting strategy will look extraordinary and be
-- worthless. So `period_end` (when it became TRUE) and `filed_at` (when we could
-- first have KNOWN it) are separate columns, and the PIT layer filters on the
-- second.
--
-- RESTATEMENTS make this genuinely bitemporal rather than merely delayed.
-- Companies revise prior periods, and the revision is filed months or years
-- later under a new accession. The naive fix — overwrite the old value — makes
-- history change retroactively, so a backtest run today sees numbers nobody had
-- at the time and a backtest run last year saw different ones. Instead every
-- version of every fact is kept, keyed by the accession that reported it, and
-- the PIT function returns the latest version filed on or before the as-of
-- instant. A backtest standing in 2021 sees 2021's understanding of 2019;
-- standing today it sees the restated figure. Both are correct.
--
-- RAW TAGS ONLY, deliberately. Filers use different us-gaap concepts for the
-- same economic quantity, and canonicalising at write time would bake one
-- mapping into permanent storage — the same mistake as storing an adjusted
-- close. The mapping lives in code, is versioned, and can be revised without
-- re-ingesting a decade of filings.
-- ============================================================================

CREATE TABLE fundamental_facts (
  id            bigserial PRIMARY KEY,
  security_id   uuid    NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,

  -- 'us-gaap', 'dei', 'ifrs-full'. Kept because the same tag name can exist in
  -- more than one taxonomy and mean different things.
  taxonomy      text    NOT NULL,
  concept       text    NOT NULL,
  -- 'USD', 'shares', 'USD/shares'. A fact is meaningless without it, and the
  -- same concept genuinely appears in several.
  unit          text    NOT NULL,

  -- NULL for instantaneous facts (balance-sheet items are a point, not a span).
  period_start  date,
  -- When the fact became TRUE. The end of the period, or the balance date.
  period_end    date    NOT NULL,

  fiscal_year   integer,
  fiscal_period text,           -- 'FY', 'Q1'..'Q4'
  form          text    NOT NULL,  -- '10-K', '10-Q', '8-K', '20-F'
  value         numeric(28, 6) NOT NULL,

  -- The filing that reported it. Two accessions reporting the same period is
  -- exactly what a restatement looks like, so this is part of the key.
  accession     text    NOT NULL,
  filed_at      date    NOT NULL,

  -- EDGAR's own frame label ('CY2023Q4I'), kept for cross-company comparison.
  frame         text,

  source_id     uuid    NOT NULL REFERENCES sources(id),

  -- When we could first have known it. NOT the moment the job ran: a ten-year
  -- backfill stamped with now() would be invisible to every as-of date before
  -- today, silently reducing any backtest to zero facts.
  observed_at   timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- A fact cannot be filed before the period it describes has ended. Such a row
  -- is not merely wrong, it is look-ahead with a timestamp on it.
  CONSTRAINT fundamental_facts_filed_after_period
    CHECK (filed_at >= period_end),
  CONSTRAINT fundamental_facts_period_ordered
    CHECK (period_start IS NULL OR period_start <= period_end),

  -- NULLS NOT DISTINCT so instantaneous facts (period_start IS NULL) collide
  -- properly. Without it every re-ingest would duplicate every balance-sheet
  -- row, because NULL <> NULL.
  CONSTRAINT fundamental_facts_identity
    UNIQUE NULLS NOT DISTINCT
      (security_id, taxonomy, concept, unit, period_start, period_end, accession)
);

-- The shape every PIT read has: one company, a few concepts, latest version
-- known at an instant.
CREATE INDEX fundamental_facts_pit_idx
  ON fundamental_facts (security_id, concept, period_end DESC, observed_at DESC);
CREATE INDEX fundamental_facts_concept_idx ON fundamental_facts (concept, period_end DESC);

COMMENT ON TABLE fundamental_facts IS
  'XBRL facts, bitemporal. period_end is when it became true; observed_at is when it became knowable. Every restatement is retained — the PIT function picks the latest version filed by the as-of instant.';

-- ── Fundamentals as known at a point in time ────────────────────────────────
-- One row per (concept, unit, period), carrying the newest version that had
-- been filed by p_as_of. DISTINCT ON does the restatement selection: order by
-- observed_at descending within each fact identity and take the first.
--
-- `id` breaks ties. Two accessions filed the same day reporting the same period
-- is rare and legitimate (an amended filing), and without a total order the
-- function would return different rows on different runs — which would make a
-- backtest irreproducible for reasons nobody would think to look for.
CREATE OR REPLACE FUNCTION pit_fundamental_facts(
  p_as_of       timestamptz,
  p_security_id uuid   DEFAULT NULL,
  p_concepts    text[] DEFAULT NULL
)
RETURNS TABLE (
  security_id   uuid,
  taxonomy      text,
  concept       text,
  unit          text,
  period_start  date,
  period_end    date,
  fiscal_year   integer,
  fiscal_period text,
  form          text,
  value         numeric(28, 6),
  accession     text,
  filed_at      date,
  observed_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT ON (f.security_id, f.taxonomy, f.concept, f.unit, f.period_start, f.period_end)
         f.security_id, f.taxonomy, f.concept, f.unit, f.period_start, f.period_end,
         f.fiscal_year, f.fiscal_period, f.form, f.value, f.accession, f.filed_at,
         f.observed_at
  FROM fundamental_facts f
  WHERE f.observed_at <= p_as_of
    AND (p_security_id IS NULL OR f.security_id = p_security_id)
    AND (p_concepts    IS NULL OR f.concept = ANY(p_concepts))
  ORDER BY f.security_id, f.taxonomy, f.concept, f.unit, f.period_start, f.period_end,
           f.observed_at DESC, f.id DESC;
$$;

COMMENT ON FUNCTION pit_fundamental_facts(timestamptz, uuid, text[]) IS
  'Fundamentals as they would have been understood at p_as_of. Excludes filings not yet made and restatements not yet published.';

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Research ingests; backtest reaches it only through the PIT function, the same
-- arrangement that keeps the backtester from reading raw bars.
GRANT INSERT, UPDATE ON fundamental_facts TO vesti_research;
GRANT USAGE, SELECT ON SEQUENCE fundamental_facts_id_seq TO vesti_research;
GRANT EXECUTE ON FUNCTION pit_fundamental_facts(timestamptz, uuid, text[]) TO vesti_backtest;

-- The `sec_edgar` source from migration 002 already covers this — a second row
-- would split provenance for facts that come from the same filer under the same
-- terms. The CIK mapping likewise reuses `security_identifiers` with
-- kind = 'cik', which is the join from a ticker to a filer and already unique
-- on (kind, value).
