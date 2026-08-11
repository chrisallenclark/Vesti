/**
 * The kill switch.
 *
 * `guardedBroker` has consulted this from the beginning; what was missing was
 * any way to set it. A safety mechanism nothing can trip is not a safety
 * mechanism, and one that has never been tripped in anger is a claim rather
 * than a control — which is why the tests here submit a real order against a
 * tripped switch and require it to be refused, rather than asserting that the
 * boolean reads true.
 *
 * Three properties it needs and now has:
 *
 *   TRIPPING IS ONE STATEMENT and takes effect on the next order, with no
 *   deploy, no restart and no cache to invalidate. The loop reads it per
 *   session and the gate reads it per order.
 *
 *   RESETTING IS DELIBERATE. It records who reset it and requires the reason
 *   for the original trip to have been read, because the failure mode of a kill
 *   switch is not failing to stop — it is being reset by whoever is most
 *   inconvenienced by it, before anyone has established what happened.
 *
 *   CANCELLING IS NEVER BLOCKED. Tripping the switch stops NEW orders. Working
 *   orders can still be pulled, and the architecture is explicit about why:
 *   blocking a cancel during a kill-switch event traps positions in the market
 *   at exactly the moment somebody has decided to stop trading.
 */

import type pg from "pg";

export interface KillSwitchState {
  accountId: string;
  isTripped: boolean;
  reason: string | null;
  trippedAt: Date | null;
  trippedBy: string | null;
}

export async function killSwitchState(
  pool: pg.Pool,
  accountId: string,
): Promise<KillSwitchState> {
  const { rows } = await pool.query<{
    is_tripped: boolean;
    reason: string | null;
    tripped_at: Date | null;
    tripped_by: string | null;
  }>(
    `SELECT is_tripped, reason, tripped_at, tripped_by
       FROM kill_switch_state WHERE account_id = $1`,
    [accountId],
  );
  const row = rows[0];
  // No row means never armed, which is not the same as tripped. An account that
  // has never had a switch is not halted — it simply has no history of being.
  return {
    accountId,
    isTripped: row?.is_tripped ?? false,
    reason: row?.reason ?? null,
    trippedAt: row?.tripped_at ?? null,
    trippedBy: row?.tripped_by ?? null,
  };
}

export async function isKillSwitchTripped(pool: pg.Pool, accountId: string): Promise<boolean> {
  return (await killSwitchState(pool, accountId)).isTripped;
}

/**
 * Halts new orders on an account.
 *
 * Idempotent, and deliberately does NOT overwrite the reason of a switch that
 * is already tripped. The first cause is the interesting one; a second trip
 * arriving from an automatic limit should not bury the human note that says
 * what actually went wrong.
 */
export async function tripKillSwitch(
  pool: pg.Pool,
  params: { accountId: string; reason: string; by: string },
): Promise<KillSwitchState> {
  await pool.query(
    `INSERT INTO kill_switch_state (account_id, is_tripped, reason, tripped_at, tripped_by)
     VALUES ($1, true, $2, now(), $3)
     ON CONFLICT (account_id) DO UPDATE
       SET is_tripped = true,
           reason     = CASE WHEN kill_switch_state.is_tripped
                             THEN kill_switch_state.reason ELSE EXCLUDED.reason END,
           tripped_at = CASE WHEN kill_switch_state.is_tripped
                             THEN kill_switch_state.tripped_at ELSE EXCLUDED.tripped_at END,
           tripped_by = CASE WHEN kill_switch_state.is_tripped
                             THEN kill_switch_state.tripped_by ELSE EXCLUDED.tripped_by END`,
    [params.accountId, params.reason, params.by],
  );
  await pool.query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, payload)
     VALUES ($1, 'kill_switch.tripped', 'account', $2, $3::jsonb)`,
    [params.by, params.accountId, JSON.stringify({ reason: params.reason })],
  );
  return killSwitchState(pool, params.accountId);
}

/**
 * Resumes trading.
 *
 * `acknowledgedReason` must match what the switch was tripped for. That is not
 * ceremony: the way a kill switch fails is being cleared by whoever is most
 * inconvenienced by it before anybody has worked out what happened, and
 * requiring the reason to be quoted back is the cheapest possible check that
 * somebody read it.
 */
export async function resetKillSwitch(
  pool: pg.Pool,
  params: { accountId: string; by: string; acknowledgedReason: string },
): Promise<KillSwitchState> {
  const current = await killSwitchState(pool, params.accountId);
  if (!current.isTripped) return current;

  if ((current.reason ?? "") !== params.acknowledgedReason) {
    throw new Error(
      `Refusing to reset: the switch was tripped for "${current.reason}". ` +
        `Pass that reason back to confirm it has been read.`,
    );
  }

  await pool.query(
    `UPDATE kill_switch_state
        SET is_tripped = false, reason = NULL, tripped_at = NULL, tripped_by = NULL
      WHERE account_id = $1`,
    [params.accountId],
  );
  await pool.query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, payload)
     VALUES ($1, 'kill_switch.reset', 'account', $2, $3::jsonb)`,
    [params.by, params.accountId, JSON.stringify({ cleared_reason: current.reason })],
  );
  return killSwitchState(pool, params.accountId);
}
