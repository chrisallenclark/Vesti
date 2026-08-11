-- ============================================================================
-- 009 — Fill idempotency.
--
-- A broker reports the same fill more than once. Not as an edge case: a dropped
-- websocket that reconnects and replays, a poll that overlaps the push that
-- already delivered, a retry after a response was lost in flight. Every one of
-- those is normal operation.
--
-- Posting a fill is not an idempotent act by itself. It opens a tax lot, moves
-- cash, and decrements the remaining quantity of whatever lots an exit closed.
-- Applying it twice does not produce a duplicate row someone notices — it
-- produces a position that never existed, a cash balance that will not
-- reconcile, and lots consumed against shares that were only sold once.
--
-- `fills` already carries the broker's own identifier for the fill. This makes
-- it the deduplication key it was always meant to be, so a replayed fill
-- collides on insert and the whole posting transaction can be abandoned before
-- it touches lots or cash.
--
-- Scoped to (order_id, broker_fill_id) rather than the identifier alone. Fill
-- ids are unique within a broker, but nothing guarantees a simulator, Alpaca
-- paper and Alpaca live never mint the same string, and order_id is ours and
-- already unambiguous. Partial: a fill recorded without a broker identifier —
-- a manual correction, a backfill from a statement — is not something we can
-- deduplicate, and pretending a single NULL is a uniqueness claim would block
-- the second such entry for the wrong reason.
-- ============================================================================

CREATE UNIQUE INDEX fills_broker_fill_id_key
  ON fills (order_id, broker_fill_id)
  WHERE broker_fill_id IS NOT NULL;

COMMENT ON INDEX fills_broker_fill_id_key IS
  'Deduplication key for replayed broker fills. Posting a fill is not idempotent on its own: it opens lots and moves cash, so the second delivery must collide here rather than being applied.';
