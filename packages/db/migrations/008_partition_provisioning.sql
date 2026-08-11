-- ============================================================================
-- 008 — Partition provisioning as a delegated capability
--
-- Ingestion needs to create the month/year partition a batch lands in, but
-- `CREATE TABLE ... PARTITION OF` runs with the caller's privileges, so under
-- 005 the ingest role hit "permission denied for schema public" on its first
-- write into a new period. Two ways to fix that, and only one of them is safe:
--
--   Wrong: GRANT CREATE ON SCHEMA public TO vesti_research. That hands the
--   ingest role — the one exposed to every external feed we parse — the ability
--   to create arbitrary objects in the schema the whole system resolves against.
--
--   Right: make the two provisioning functions SECURITY DEFINER with a pinned
--   search_path and grant EXECUTE narrowly. The role gains exactly one
--   capability, "create a correctly-shaped partition of a table I already write
--   to", and nothing else. Same posture as the PIT functions in 003.
--
-- Both functions take a typed scalar (integer / date) and build their object
-- names with %I, so there is no injectable surface for the caller to reach.
-- ============================================================================

CREATE OR REPLACE FUNCTION vesti_ensure_daily_partition(target_year integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  part_name text := format('bars_daily_%s', target_year);
BEGIN
  IF target_year < 1900 OR target_year > 2200 THEN
    RAISE EXCEPTION 'Refusing to create a bars_daily partition for year %', target_year;
  END IF;
  IF to_regclass(part_name) IS NOT NULL THEN RETURN; END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF bars_daily FOR VALUES FROM (%L) TO (%L)',
    part_name,
    make_date(target_year, 1, 1),
    make_date(target_year + 1, 1, 1)
  );
END;
$$;

CREATE OR REPLACE FUNCTION vesti_ensure_intraday_partition(target_month date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

-- A SECURITY DEFINER function is executable by PUBLIC unless told otherwise,
-- which would defeat the point of granting it narrowly.
REVOKE ALL ON FUNCTION vesti_ensure_daily_partition(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION vesti_ensure_intraday_partition(date) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION vesti_ensure_daily_partition(integer) TO vesti_research;
GRANT EXECUTE ON FUNCTION vesti_ensure_intraday_partition(date) TO vesti_research;

COMMENT ON FUNCTION vesti_ensure_daily_partition(integer) IS
  'SECURITY DEFINER so ingest can provision a partition without holding CREATE on the schema.';
COMMENT ON FUNCTION vesti_ensure_intraday_partition(date) IS
  'SECURITY DEFINER so ingest can provision a partition without holding CREATE on the schema.';
