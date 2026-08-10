-- ============================================================================
-- 001 — Foundation: extensions, shared enums, users, and the audit log.
--
-- Two things here are load-bearing for the whole system:
--
--   1. `vesti_touch_updated_at` — the ONLY trigger permitted to mutate a row's
--      timestamp. Append-only tables never get it (see 005).
--
--   2. `audit_log` — hash-chained. Each row commits to the previous row's hash,
--      so tampering with history requires rewriting every subsequent row. This
--      is what makes "never silently rewrite history" enforceable rather than
--      aspirational.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS btree_gist; -- exclusion constraints on ranges
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ── Shared enums ────────────────────────────────────────────────────────────
-- Mandates are separate strategies with separate capital, not tags on a
-- position. Keeping this an enum (not a lookup table) because adding a mandate
-- is a deliberate architectural act that should require a migration.
CREATE TYPE mandate_kind AS ENUM ('active', 'catalyst', 'long_term');

CREATE TYPE asset_class AS ENUM ('equity', 'etf', 'option', 'crypto', 'future');

-- Source tiering drives how much weight evidence is allowed to carry.
-- Tier 4 (social) may originate an investigation but must never be the sole
-- basis for a conviction change — enforced in the research layer, declared here.
CREATE TYPE source_tier AS ENUM ('tier1_primary', 'tier2_reputable', 'tier3_analyst', 'tier4_social');

CREATE TYPE order_side AS ENUM ('buy', 'sell');
CREATE TYPE order_kind AS ENUM ('market', 'limit', 'stop', 'stop_limit');
CREATE TYPE order_status AS ENUM (
  'pending_risk',  -- intent recorded, risk engine has not ruled
  'rejected_risk', -- risk engine vetoed; never reached a broker
  'pending_new',   -- accepted by us, submitted to broker
  'working',
  'partially_filled',
  'filled',
  'canceled',
  'expired',
  'rejected_broker'
);
CREATE TYPE time_in_force AS ENUM ('day', 'gtc', 'ioc', 'fok', 'opg', 'cls');

CREATE TYPE risk_decision AS ENUM ('approve', 'reduce', 'reject');

-- The promotion ladder from the plan. A strategy may only move one step at a
-- time, and only when a deterministic gate evaluation says so.
CREATE TYPE strategy_status AS ENUM (
  'experimental',
  'validating',
  'paper_approved',
  'live_limited',
  'live_scaled',
  'paused',
  'retired'
);

-- Which tape a bar came from. IEX is ~2-3% of consolidated volume, so any
-- volume-derived feature computed from it is biased. Carrying this per-bar
-- means a later full-tape upgrade can recompute cleanly instead of silently
-- invalidating already-labeled history.
CREATE TYPE market_tape AS ENUM ('iex', 'sip', 'synthetic');

-- ── Utility: updated_at maintenance ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION vesti_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── Users ───────────────────────────────────────────────────────────────────
-- Private single-user deployment today, but every user-scoped table carries
-- user_id and RLS from day one so multi-user is a feature build rather than a
-- migration. There is deliberately no advice surface or tenancy UI.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION vesti_touch_updated_at();

-- ── Audit log (hash-chained, append-only) ───────────────────────────────────
CREATE TABLE audit_log (
  seq          bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor        text        NOT NULL,   -- 'system:ingest', 'user:<uuid>', 'service:execution'
  action       text        NOT NULL,   -- 'order.submitted', 'thesis.revised', ...
  entity_type  text        NOT NULL,
  entity_id    text,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  prev_hash    text,
  hash         text        NOT NULL
);

COMMENT ON TABLE audit_log IS
  'Append-only, hash-chained. hash = sha256(prev_hash || occurred_at || actor || action || entity_type || entity_id || payload). Verified by vesti_verify_audit_chain().';

-- Computes the chain hash on insert. Callers never supply prev_hash or hash;
-- supplying them is ignored, which keeps the chain honest even if a caller lies.
CREATE OR REPLACE FUNCTION vesti_audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_hash text;
BEGIN
  SELECT hash INTO last_hash FROM audit_log ORDER BY seq DESC LIMIT 1;

  NEW.prev_hash := last_hash;
  NEW.hash := encode(
    digest(
      coalesce(last_hash, '') ||
      to_char(NEW.occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') || '|' ||
      NEW.actor       || '|' ||
      NEW.action      || '|' ||
      NEW.entity_type || '|' ||
      coalesce(NEW.entity_id, '') || '|' ||
      NEW.payload::text,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION vesti_audit_chain();

-- Walks the chain and returns the first seq where the recomputed hash diverges.
-- Returns no rows when the chain is intact.
CREATE OR REPLACE FUNCTION vesti_verify_audit_chain()
RETURNS TABLE (broken_at bigint, reason text)
LANGUAGE plpgsql AS $$
DECLARE
  row_rec   record;
  expected  text;
  running   text := NULL;
BEGIN
  FOR row_rec IN SELECT * FROM audit_log ORDER BY seq LOOP
    expected := encode(
      digest(
        coalesce(running, '') ||
        to_char(row_rec.occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') || '|' ||
        row_rec.actor       || '|' ||
        row_rec.action      || '|' ||
        row_rec.entity_type || '|' ||
        coalesce(row_rec.entity_id, '') || '|' ||
        row_rec.payload::text,
        'sha256'
      ),
      'hex'
    );

    IF row_rec.prev_hash IS DISTINCT FROM running THEN
      broken_at := row_rec.seq; reason := 'prev_hash does not match preceding row';
      RETURN NEXT; RETURN;
    END IF;

    IF row_rec.hash <> expected THEN
      broken_at := row_rec.seq; reason := 'row hash does not match its contents';
      RETURN NEXT; RETURN;
    END IF;

    running := row_rec.hash;
  END LOOP;
END;
$$;
