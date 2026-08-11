/**
 * Getting capital into the ledger, and dividing it between mandates.
 *
 * Without this the equity curve is zeros. The ledger only ever recorded flows
 * we caused — a buy, a sell, a fee — so an account funded at the broker with
 * $100,000 showed a cash balance of whatever our own trades had cost, and three
 * mandates each worth nothing. The measurement Phase 6 exists to produce was
 * structurally unable to be right.
 *
 * Deliberately NOT "read the broker's cash and make ours match". That would
 * paper over exactly the drift reconciliation exists to catch: an unrecorded
 * fill and a genuine deposit both look like "our number is too low", and a
 * command that silently corrects the total would erase the evidence
 * distinguishing them. A deposit is asserted by a human, once, and
 * reconciliation then has something real to check against.
 *
 * Allocation is double-entry. Unallocated capital is `mandate_id IS NULL`, and
 * moving it to a mandate writes a matching pair — out of unallocated, into the
 * mandate — so the account total is unchanged and every mandate's cash is a
 * fold over its own rows. A single-sided entry would make the mandates sum to
 * more than the account holds, which is the kind of error that looks like
 * profit.
 */

import type pg from "pg";

export interface CapitalPosition {
  total: number;
  unallocated: number;
  byMandate: Array<{ mandateId: string; name: string; targetWeight: number; cash: number }>;
}

export async function capitalPosition(
  pool: pg.Pool,
  accountId: string,
): Promise<CapitalPosition> {
  const { rows } = await pool.query<{
    mandate_id: string | null;
    name: string | null;
    target_weight: string | null;
    cash: string;
  }>(
    `SELECT c.mandate_id, m.name, m.target_weight, sum(c.amount) AS cash
       FROM cash_ledger c
       LEFT JOIN mandates m ON m.id = c.mandate_id
      WHERE c.account_id = $1
      GROUP BY c.mandate_id, m.name, m.target_weight`,
    [accountId],
  );

  let total = 0;
  let unallocated = 0;
  const byMandate: CapitalPosition["byMandate"] = [];

  for (const row of rows) {
    const cash = Number(row.cash);
    total += cash;
    if (row.mandate_id === null) {
      unallocated += cash;
    } else {
      byMandate.push({
        mandateId: row.mandate_id,
        name: row.name ?? "",
        targetWeight: Number(row.target_weight ?? 0),
        cash,
      });
    }
  }

  // Mandates that have never seen a cash entry still belong in the answer —
  // "this mandate has no capital" is a fact, not an absence.
  const { rows: all } = await pool.query<{ id: string; name: string; target_weight: string }>(
    `SELECT m.id, m.name, m.target_weight FROM mandates m
       JOIN accounts a ON a.user_id = m.user_id WHERE a.id = $1 ORDER BY m.name`,
    [accountId],
  );
  for (const mandate of all) {
    if (byMandate.some((b) => b.mandateId === mandate.id)) continue;
    byMandate.push({
      mandateId: mandate.id,
      name: mandate.name,
      targetWeight: Number(mandate.target_weight),
      cash: 0,
    });
  }
  byMandate.sort((a, b) => a.name.localeCompare(b.name));

  return { total, unallocated, byMandate };
}

/**
 * Records capital arriving from outside the system.
 *
 * `reference` is required and should identify the real event — a transfer id, a
 * paper account's opening balance. A deposit with no provenance is
 * indistinguishable from a plug, and a plug is how a cash discrepancy gets
 * hidden instead of found.
 */
export async function recordDeposit(
  pool: pg.Pool,
  params: { accountId: string; amount: number; reference: string; occurredAt?: Date },
): Promise<void> {
  if (!(params.amount > 0)) throw new Error("A deposit must be positive.");
  if (!params.reference.trim()) throw new Error("A deposit needs a reference.");

  await pool.query(
    `INSERT INTO cash_ledger (account_id, mandate_id, occurred_at, kind, amount, reference)
     VALUES ($1, NULL, $2, 'deposit', $3, $4)`,
    [params.accountId, params.occurredAt ?? new Date(), params.amount, params.reference],
  );
}

/**
 * Divides unallocated cash between mandates by target weight.
 *
 * Idempotent in the sense that matters: it allocates only what is currently
 * unallocated, so running it twice does not double anyone's budget. Weights
 * that do not sum to 1 leave a remainder unallocated rather than being
 * normalised — silently rescaling somebody's stated allocation is worse than
 * leaving capital idle and visible.
 */
export async function allocateByTargetWeight(
  pool: pg.Pool,
  params: { accountId: string; occurredAt?: Date },
): Promise<Array<{ name: string; amount: number }>> {
  const position = await capitalPosition(pool, params.accountId);
  if (position.unallocated <= 0) return [];

  const occurredAt = params.occurredAt ?? new Date();
  const moved: Array<{ name: string; amount: number }> = [];

  for (const mandate of position.byMandate) {
    const amount = Number((position.unallocated * mandate.targetWeight).toFixed(2));
    if (amount <= 0) continue;

    // Both legs, in one statement, so a crash between them is not possible.
    await pool.query(
      `INSERT INTO cash_ledger (account_id, mandate_id, occurred_at, kind, amount, reference)
       VALUES ($1, NULL, $2, 'allocation', $3, $4),
              ($1, $5,   $2, 'allocation', $6, $4)`,
      [
        params.accountId,
        occurredAt,
        -amount,
        `allocation to ${mandate.name}`,
        mandate.mandateId,
        amount,
      ],
    );
    moved.push({ name: mandate.name, amount });
  }

  return moved;
}
