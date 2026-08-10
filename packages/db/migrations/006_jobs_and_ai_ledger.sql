-- ============================================================================
-- 006 — Background jobs and the AI cost ledger.
--
-- Jobs live in Postgres rather than Redis so there is one durable store to
-- operate and every queued unit of work is an auditable row. Claiming uses
-- SELECT ... FOR UPDATE SKIP LOCKED, which is the standard safe pattern for
-- multiple competing workers (the TypeScript ingest workers and the Python
-- quant service both poll the same table).
--
-- The AI ledger exists because "cost control" without per-call measurement is a
-- wish. Every model call records its tokens and computed cost BEFORE the result
-- is used, and vesti_ai_budget_check() is consulted BEFORE dispatch — so the
-- budget is a gate, not a report you read after overspending.
-- ============================================================================

CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'dead');

CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text        NOT NULL,   -- 'ingest.bars.daily', 'features.compute', ...
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status        job_status  NOT NULL DEFAULT 'queued',
  priority      integer     NOT NULL DEFAULT 100,  -- lower runs first

  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      integer     NOT NULL DEFAULT 0,
  max_attempts  integer     NOT NULL DEFAULT 5,

  -- Set on claim so a crashed worker's job can be reclaimed after the lease
  -- expires rather than being stuck 'running' forever.
  locked_by     text,
  locked_until  timestamptz,

  last_error    text,
  -- Deduplication: two ingest runs queuing the same work collapse to one row.
  dedupe_key    text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE UNIQUE INDEX jobs_dedupe_key_active
  ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX jobs_claim_idx ON jobs (status, priority, run_after) WHERE status = 'queued';

CREATE TRIGGER jobs_touch BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

-- Atomically claim up to p_limit jobs. SKIP LOCKED lets N workers poll the same
-- table without blocking each other or double-processing.
CREATE OR REPLACE FUNCTION vesti_claim_jobs(
  p_worker text,
  p_kinds  text[] DEFAULT NULL,
  p_limit  integer DEFAULT 1,
  p_lease  interval DEFAULT interval '5 minutes'
)
RETURNS SETOF jobs
LANGUAGE sql
AS $$
  UPDATE jobs
  SET status       = 'running',
      attempts     = jobs.attempts + 1,
      locked_by    = p_worker,
      locked_until = now() + p_lease,
      updated_at   = now()
  WHERE id IN (
    SELECT j.id FROM jobs j
    WHERE j.status = 'queued'
      AND j.run_after <= now()
      AND (p_kinds IS NULL OR j.kind = ANY(p_kinds))
    ORDER BY j.priority, j.run_after
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING *;
$$;

-- Requeues jobs whose worker died mid-run. Called by a maintenance tick.
CREATE OR REPLACE FUNCTION vesti_reclaim_expired_jobs() RETURNS integer
LANGUAGE sql AS $$
  WITH reclaimed AS (
    UPDATE jobs
    SET status = 'queued', locked_by = NULL, locked_until = NULL, updated_at = now()
    WHERE status = 'running' AND locked_until < now()
    RETURNING 1
  )
  SELECT count(*)::integer FROM reclaimed;
$$;

-- Marks a job failed, with exponential backoff, and retires it to 'dead' once
-- attempts are exhausted so a poison message cannot loop forever.
CREATE OR REPLACE FUNCTION vesti_fail_job(p_id bigint, p_error text)
RETURNS job_status
LANGUAGE plpgsql AS $$
DECLARE
  job_row jobs;
  next_status job_status;
BEGIN
  SELECT * INTO job_row FROM jobs WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'job % not found', p_id; END IF;

  next_status := CASE WHEN job_row.attempts >= job_row.max_attempts THEN 'dead' ELSE 'queued' END;

  UPDATE jobs
  SET status     = next_status,
      last_error = p_error,
      locked_by  = NULL,
      locked_until = NULL,
      -- 2^attempts seconds, capped at an hour.
      run_after  = now() + least(interval '1 hour',
                                 (interval '1 second' * power(2, job_row.attempts))),
      updated_at = now()
  WHERE id = p_id;

  RETURN next_status;
END;
$$;

-- ── AI cost ledger ──────────────────────────────────────────────────────────
CREATE TABLE ai_calls (
  id                 bigserial PRIMARY KEY,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  job_id             bigint REFERENCES jobs(id) ON DELETE SET NULL,

  model              text    NOT NULL,     -- 'claude-haiku-4-5' | 'claude-sonnet-5' | 'claude-opus-5'
  purpose            text    NOT NULL,     -- 'news.triage', 'thesis.review', ...
  -- Lets us verify prompt-cache effectiveness: a stable prefix should produce a
  -- stable hash and a rising cache_read_tokens.
  prompt_hash        text,

  input_tokens          integer NOT NULL DEFAULT 0,
  output_tokens         integer NOT NULL DEFAULT 0,
  cache_read_tokens     integer NOT NULL DEFAULT 0,
  cache_write_tokens    integer NOT NULL DEFAULT 0,

  cost_usd           numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms         integer,
  was_batch          boolean NOT NULL DEFAULT false,
  succeeded          boolean NOT NULL DEFAULT true,
  error              text
);
CREATE INDEX ai_calls_occurred_idx ON ai_calls (occurred_at DESC);
CREATE INDEX ai_calls_purpose_idx  ON ai_calls (purpose, occurred_at DESC);

-- Per-model pricing, as data. Rates change; a migration should not be needed to
-- track that, and historical rows keep the rate that was in force.
CREATE TABLE ai_model_pricing (
  model                text NOT NULL,
  effective_from       date NOT NULL,
  input_per_mtok       numeric(10, 4) NOT NULL,
  output_per_mtok      numeric(10, 4) NOT NULL,
  cache_read_per_mtok  numeric(10, 4) NOT NULL,
  cache_write_per_mtok numeric(10, 4) NOT NULL,
  batch_discount       numeric(4, 3)  NOT NULL DEFAULT 0.500,
  PRIMARY KEY (model, effective_from)
);

-- Cache reads are ~0.1x input; cache writes ~1.25x input. Batch is 50% off.
INSERT INTO ai_model_pricing
  (model, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) VALUES
  ('claude-haiku-4-5', DATE '2026-01-01',  1.00,  5.00, 0.10,  1.25),
  ('claude-sonnet-5',  DATE '2026-01-01',  3.00, 15.00, 0.30,  3.75),
  ('claude-opus-5',    DATE '2026-01-01',  5.00, 25.00, 0.50,  6.25);

CREATE TABLE ai_budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  daily_usd       numeric(10, 2) NOT NULL,
  monthly_usd     numeric(10, 2) NOT NULL,
  effective_from  date NOT NULL DEFAULT current_date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Cost of a call given the pricing in force at the time. Kept in SQL so both
-- the TypeScript and Python callers compute it identically.
CREATE OR REPLACE FUNCTION vesti_ai_cost(
  p_model              text,
  p_input_tokens       integer,
  p_output_tokens      integer,
  p_cache_read_tokens  integer DEFAULT 0,
  p_cache_write_tokens integer DEFAULT 0,
  p_was_batch          boolean DEFAULT false,
  p_at                 date DEFAULT current_date
)
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT round(
    (
      p_input_tokens       / 1e6 * pricing.input_per_mtok +
      p_output_tokens      / 1e6 * pricing.output_per_mtok +
      p_cache_read_tokens  / 1e6 * pricing.cache_read_per_mtok +
      p_cache_write_tokens / 1e6 * pricing.cache_write_per_mtok
    ) * CASE WHEN p_was_batch THEN (1 - pricing.batch_discount) ELSE 1 END,
    6
  )
  FROM ai_model_pricing pricing
  WHERE pricing.model = p_model AND pricing.effective_from <= p_at
  ORDER BY pricing.effective_from DESC
  LIMIT 1;
$$;

-- Consulted BEFORE dispatch. Returns what the caller is allowed to do, so the
-- routing layer can downgrade a tier or defer instead of silently overspending.
CREATE OR REPLACE FUNCTION vesti_ai_budget_check(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  spent_today   numeric,
  spent_month   numeric,
  daily_limit   numeric,
  monthly_limit numeric,
  daily_headroom   numeric,
  monthly_headroom numeric,
  may_dispatch  boolean
)
LANGUAGE sql STABLE AS $$
  WITH budget AS (
    SELECT b.daily_usd, b.monthly_usd
    FROM ai_budgets b
    WHERE (p_user_id IS NULL OR b.user_id = p_user_id OR b.user_id IS NULL)
      AND b.effective_from <= current_date
    ORDER BY b.effective_from DESC
    LIMIT 1
  ),
  spend AS (
    SELECT
      coalesce(sum(cost_usd) FILTER (
        WHERE occurred_at >= date_trunc('day', now())), 0) AS today,
      coalesce(sum(cost_usd) FILTER (
        WHERE occurred_at >= date_trunc('month', now())), 0) AS month
    FROM ai_calls
  )
  SELECT
    spend.today,
    spend.month,
    budget.daily_usd,
    budget.monthly_usd,
    budget.daily_usd   - spend.today,
    budget.monthly_usd - spend.month,
    (spend.today < budget.daily_usd AND spend.month < budget.monthly_usd)
  FROM spend CROSS JOIN budget;
$$;

COMMENT ON FUNCTION vesti_ai_budget_check(uuid) IS
  'Pre-dispatch gate. may_dispatch=false means the router must downgrade tier or defer the job — never silently proceed.';

GRANT SELECT, INSERT, UPDATE ON jobs TO vesti_research, vesti_execution;
GRANT INSERT ON ai_calls TO vesti_research, vesti_execution;
GRANT USAGE, SELECT ON SEQUENCE jobs_id_seq, ai_calls_id_seq TO vesti_research, vesti_execution;
GRANT EXECUTE ON FUNCTION
  vesti_claim_jobs(text, text[], integer, interval),
  vesti_fail_job(bigint, text),
  vesti_reclaim_expired_jobs(),
  vesti_ai_cost(text, integer, integer, integer, integer, boolean, date),
  vesti_ai_budget_check(uuid)
  TO vesti_research, vesti_execution;
