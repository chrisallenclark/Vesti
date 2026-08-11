/**
 * Specific-lot selection.
 *
 * A broker holds one omnibus position per symbol with one average cost. We do
 * not. The same ticker can be a multi-year core holding in the Long-Term
 * mandate and a two-day tactical trade in the Active mandate at the same time,
 * and those are different capital with different theses and different exits.
 *
 * This module is the seam where that distinction becomes operational rather
 * than decorative. Every query it issues is scoped to the ORDER's mandate, so
 * an exit cannot see, let alone consume, a lot belonging to another one. When
 * an Active stop asks for 100 shares and Active holds 40, it fails — even
 * though the account holds 540 and the broker would happily sell them. That
 * refusal is the feature.
 *
 * The database trigger on `order_lot_allocations` enforces the same rule a
 * second time, and that redundancy is deliberate: this file is the reason the
 * rule holds in practice, and the trigger is the reason a bug here cannot
 * quietly break it.
 */

import type { PoolClient } from "pg";

/**
 * Which lots an exit consumes first.
 *
 * Not a tax nicety — it decides realised P&L per trade and therefore what the
 * post-trade record says a strategy earned. FIFO is the broker default and the
 * one an unspecified sale is assumed to use, so it is ours too; the others are
 * available because a mandate holding a position for years has a genuinely
 * different objective from one holding it for two days.
 */
export type LotMethod = "fifo" | "lifo" | "hifo";

export interface OpenLot {
  id: string;
  remaining: number;
  costBasis: number;
  openedAt: Date;
}

export interface LotAllocation {
  lotId: string;
  quantity: number;
  costBasis: number;
  /** Proceeds minus basis on the shares this allocation closes, net of fees. */
  realizedPnl: number;
}

/** Raised when a mandate is asked to sell more than it holds. */
export class InsufficientLotsError extends Error {
  readonly code = "insufficient_lots";
  constructor(
    readonly mandateId: string,
    readonly securityId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(
      `Mandate ${mandateId} holds ${available} of ${securityId}, cannot sell ${requested}. ` +
        `Lots in other mandates are not eligible.`,
    );
    this.name = "InsufficientLotsError";
  }
}

const ORDER_BY: Record<LotMethod, string> = {
  // Oldest first. The default assumption a tax authority makes about an
  // unspecified sale, so it is what an unspecified sale does here.
  fifo: "l.opened_at ASC, l.id ASC",
  lifo: "l.opened_at DESC, l.id DESC",
  // Highest cost first, which realises the smallest gain. Ties break to the
  // older lot so the ordering is total — two lots at identical cost must not
  // resolve differently between runs, or a backtest stops being reproducible.
  hifo: "l.cost_basis DESC, l.opened_at ASC, l.id ASC",
};

/**
 * Open lots for one mandate's holding of one security, in consumption order.
 *
 * `FOR UPDATE` is load-bearing. Two exits racing on the same position would
 * otherwise both read the same `remaining` and both allocate against it; the
 * `remaining >= 0` check constraint would catch the overdraft on one of them,
 * but only after the transaction had already opened cash entries and
 * allocations that then have to unwind. Taking the row locks in selection order
 * makes the second exit wait and re-read instead.
 */
export async function selectOpenLots(
  client: PoolClient,
  params: {
    accountId: string;
    mandateId: string;
    securityId: string;
    method: LotMethod;
  },
): Promise<OpenLot[]> {
  const { rows } = await client.query<{
    id: string;
    remaining: string;
    cost_basis: string;
    opened_at: Date;
  }>(
    // The ORDER BY is interpolated from a closed map keyed by a union type, so
    // there is no path from user input to this string.
    `SELECT l.id, l.remaining, l.cost_basis, l.opened_at
       FROM lots l
      WHERE l.account_id = $1
        AND l.mandate_id = $2
        AND l.security_id = $3
        AND l.remaining > 0
      ORDER BY ${ORDER_BY[params.method]}
      FOR UPDATE`,
    [params.accountId, params.mandateId, params.securityId],
  );

  return rows.map((row) => ({
    id: row.id,
    remaining: Number(row.remaining),
    costBasis: Number(row.cost_basis),
    openedAt: row.opened_at,
  }));
}

/**
 * Walks the eligible lots and assigns the sold quantity across them.
 *
 * Fees are apportioned by share rather than charged wholly to the first lot, so
 * two exits of the same position differing only in how the fill was chunked
 * report the same realised P&L. Anything else makes the number depend on the
 * broker's fill sizing.
 *
 * Refuses to partially satisfy. A short fill here would mean either an
 * unmodelled short position or a silent reach into another mandate's shares,
 * and both are worse than an error.
 */
export function allocateAcrossLots(
  lots: readonly OpenLot[],
  quantity: number,
  price: number,
  fees: number,
  context: { mandateId: string; securityId: string },
): LotAllocation[] {
  const available = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  if (available + 1e-9 < quantity) {
    throw new InsufficientLotsError(context.mandateId, context.securityId, quantity, available);
  }

  const feePerShare = quantity > 0 ? fees / quantity : 0;
  const allocations: LotAllocation[] = [];
  let outstanding = quantity;

  for (const lot of lots) {
    if (outstanding <= 1e-9) break;
    const take = Math.min(lot.remaining, outstanding);
    allocations.push({
      lotId: lot.id,
      quantity: take,
      costBasis: lot.costBasis,
      realizedPnl: (price - lot.costBasis) * take - feePerShare * take,
    });
    outstanding -= take;
  }

  return allocations;
}
