-- ============================================================================
-- 014 — An open position must belong to a strategy.
--
-- Two shares of AVGO sat in the paper account for nine days owned by nobody.
-- They were held at the broker, they were absent from every strategy's P&L, no
-- flatten ever considered them, and from every angle available at the time they
-- looked exactly like a position somebody was managing.
--
-- The chain was short. `paper.ts` and the swing loop both recorded orders
-- without a `strategy_version_id`; `openLot` copies that field from the order,
-- so the lot inherited the null; and every engine finds its positions with
--
--     WHERE l.strategy_version_id = $currentVersion
--
-- which no null ever matches. Nothing was broken enough to fail. The position
-- simply stopped being anybody's.
--
-- Both callers now name their strategy and `recordIntent` refuses an intent
-- without one, so this cannot be created again by the code as it stands. This
-- migration is the other half: repair what exists, and put the rule somewhere
-- code cannot drift away from.
--
-- WHY A CHECK RATHER THAN NOT NULL. Closed lots from before this are history
-- and history is not rewritten here — a lot that has already been sold and
-- reconciled is answering no live question, and forcing an owner onto it would
-- invent an attribution rather than record one. What has to hold is narrower
-- and is the property that actually matters: anything still OPEN must have an
-- owner, because an open position is a thing somebody has to be responsible for
-- exiting.
-- ============================================================================

BEGIN;

-- ── The repair ──────────────────────────────────────────────────────────────
-- Adopted by the DAY strategy, which is where these came from: the orphans were
-- created by `paper.ts`, the end-to-end proof runner, and that tool now
-- attributes to `day.opening_range_breakout` by default. So this records the
-- attribution the same order would be given today rather than inventing a new
-- one.
--
-- The practical consequence is the one wanted: DAY sees the position on its
-- next session and flattens it at 15:45 through the risk engine and the
-- execution gate, like any other. A null stop and target are already handled —
-- those checks are skipped and the session-end exit still applies.
UPDATE lots l
   SET strategy_version_id = (
         SELECT sv.id
           FROM strategy_versions sv
           JOIN strategies st ON st.id = sv.strategy_id
           JOIN accounts a    ON a.user_id = st.user_id
          WHERE a.id = l.account_id
            AND st.slug = 'day.opening_range_breakout'
          ORDER BY sv.version DESC
          LIMIT 1
       ),
       updated_at = now()
 WHERE l.remaining > 0
   AND l.strategy_version_id IS NULL
   AND EXISTS (
         SELECT 1
           FROM strategy_versions sv
           JOIN strategies st ON st.id = sv.strategy_id
           JOIN accounts a    ON a.user_id = st.user_id
          WHERE a.id = l.account_id AND st.slug = 'day.opening_range_breakout'
       );

-- ── The rule ────────────────────────────────────────────────────────────────
-- NOT VALID deliberately. If an account somehow still holds an open lot this
-- could not adopt — no DAY strategy registered for its owner — the right
-- outcome is that the migration applies and preflight keeps saying so loudly,
-- not that the schema refuses to move and every deployment stops. New and
-- updated rows are checked from this moment either way, which is what closes
-- the hole.
ALTER TABLE lots
  ADD CONSTRAINT lots_open_position_has_an_owner
  CHECK (remaining = 0 OR strategy_version_id IS NOT NULL)
  NOT VALID;

COMMIT;
