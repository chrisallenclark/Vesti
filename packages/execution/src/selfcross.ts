/**
 * Self-cross detection.
 *
 * The one place the mandate model collides with the reality of a single broker
 * account. Active selling AAPL while Long-Term buys AAPL is a perfectly
 * coherent state here — different capital, different theses, different horizons
 * — and at the venue it is one account on both sides of a trade. Brokers reject
 * that as a wash trade, and they are right to.
 *
 * This is DETECTION, not netting. It turns a cryptic venue rejection arriving
 * after submission into a clear refusal before it, which is worth having, but
 * it does not solve the underlying problem: two mandates with opposite
 * intentions in the same name still cannot both act. The real answer is to net
 * them at the execution layer — cross the shares internally, moving lots
 * between mandates at the prevailing price, and send only the residual to the
 * venue. That changes what a fill means (an internal cross has no broker fill
 * to reconcile against) and needs deciding rather than assuming, so it belongs
 * with the Phase 6 execution loop.
 *
 * Recorded here so the constraint is visible at the point it bites, instead of
 * being discovered as an unexplained rejection on a live paper run.
 */

import type pg from "pg";

export interface SelfCross {
  orderId: string;
  mandateId: string;
  mandateName: string;
  side: "buy" | "sell";
  quantity: number;
  status: string;
}

export class SelfCrossError extends Error {
  readonly code = "self_cross";
  constructor(
    readonly symbol: string,
    readonly conflicts: readonly SelfCross[],
  ) {
    const detail = conflicts
      .map((c) => `${c.mandateName} ${c.side} ${c.quantity} (${c.status})`)
      .join("; ");
    super(
      `Submitting this order would put the account on both sides of ${symbol}: ${detail}. ` +
        `The venue will reject it as a wash trade. Net the mandates or sequence them.`,
    );
    this.name = "SelfCrossError";
  }
}

/**
 * Working orders on the opposite side of the same security, in any mandate.
 *
 * Scoped to the ACCOUNT rather than the mandate, which is the opposite of how
 * lot selection works and deliberately so: the venue sees the account, not our
 * partition of it.
 */
export async function findSelfCrosses(
  pool: pg.Pool,
  params: { accountId: string; securityId: string; side: "buy" | "sell" },
): Promise<SelfCross[]> {
  const { rows } = await pool.query<{
    id: string;
    mandate_id: string;
    mandate_name: string;
    side: "buy" | "sell";
    quantity: string;
    status: string;
  }>(
    `SELECT o.id, o.mandate_id, m.name AS mandate_name, o.side, o.quantity, o.status
       FROM orders o
       JOIN mandates m ON m.id = o.mandate_id
      WHERE o.account_id  = $1
        AND o.security_id = $2
        AND o.side       <> $3
        AND o.status IN ('pending_new', 'working', 'partially_filled')`,
    [params.accountId, params.securityId, params.side],
  );

  return rows.map((row) => ({
    orderId: row.id,
    mandateId: row.mandate_id,
    mandateName: row.mandate_name,
    side: row.side,
    quantity: Number(row.quantity),
    status: row.status,
  }));
}

export async function assertNoSelfCross(
  pool: pg.Pool,
  params: { accountId: string; securityId: string; side: "buy" | "sell"; symbol: string },
): Promise<void> {
  const conflicts = await findSelfCrosses(pool, params);
  if (conflicts.length > 0) throw new SelfCrossError(params.symbol, conflicts);
}
