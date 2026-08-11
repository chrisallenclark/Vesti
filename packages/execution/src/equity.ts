/**
 * The daily per-mandate mark.
 *
 * This is the measurement Phase 6 exists to produce. "Does this make money?" is
 * a question about a series, and the series has to be written down as it
 * happens: lots and cash tell you where a mandate stands now, and nothing
 * recovers what it was worth on a Tuesday in March. A session that goes
 * unrecorded is a permanent hole in the equity curve.
 *
 * Per mandate, because three mandates sharing one account is the whole design.
 * An account-level curve averages away exactly the comparison the system exists
 * to make — a Long-Term mandate compounding quietly and an Active mandate
 * churning to nowhere look, added together, like a mediocre single strategy.
 *
 * Marks come from the PIT layer at the session's own close rather than from a
 * live quote, so a snapshot re-run later reproduces the same number. A curve
 * whose history changes depending on when you asked for it is not a record.
 */

import type pg from "pg";

export interface MandateSnapshot {
  mandateId: string;
  mandateName: string;
  asOf: string;
  cash: number;
  positionsValue: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openRisk: number;
  positionCount: number;
  /** The session the marks came from. Older than `asOf` means stale bars. */
  markedFrom: string | null;
}

/**
 * Marks every mandate on an account and writes one row each.
 *
 * Cash per mandate is a fold over `cash_ledger` filtered by mandate, so a
 * mandate that has only ever spent shows a negative cash balance and a matching
 * positions value. That is correct rather than alarming: mandates share one
 * broker account and the capital allocation between them is a target weight,
 * not a separate pot of money. Equity is the sum, which is the number that
 * means something.
 */
export async function snapshotEquity(
  pool: pg.Pool,
  params: { accountId: string; asOf: string },
): Promise<MandateSnapshot[]> {
  const { rows } = await pool.query<{
    mandate_id: string;
    mandate_name: string;
    cash: string;
    positions_value: string;
    cost_value: string;
    realized_pnl: string;
    open_risk: string;
    position_count: string;
    marked_from: Date | null;
  }>(
    `WITH mandate_list AS (
       SELECT m.id, m.name
         FROM mandates m
         JOIN accounts a ON a.user_id = m.user_id
        WHERE a.id = $1
     ),
     cash AS (
       SELECT mandate_id, sum(amount) AS balance
         FROM cash_ledger
        WHERE account_id = $1 AND occurred_at < ($2::date + 1)
        GROUP BY mandate_id
     ),
     marks AS (
       -- The close on or before as_of. Using the latest bar unconditionally
       -- would mark a backfilled snapshot at today's price, which silently
       -- rewrites history every time the job is re-run.
       SELECT l.mandate_id,
              l.security_id,
              sum(l.remaining)                  AS quantity,
              sum(l.remaining * l.cost_basis)   AS cost,
              min(l.stop_price)                 AS stop_price,
              max(p.close)                      AS close,
              max(p.session_date)               AS marked_from
         FROM lots l
         LEFT JOIN LATERAL (
           SELECT b.close, b.session_date FROM bars_daily b
            WHERE b.security_id = l.security_id AND b.session_date <= $2::date
            ORDER BY b.session_date DESC LIMIT 1
         ) p ON true
        WHERE l.account_id = $1 AND l.remaining > 0
        GROUP BY l.mandate_id, l.security_id
     ),
     valued AS (
       SELECT mandate_id,
              sum(quantity * coalesce(close, cost / nullif(quantity, 0))) AS positions_value,
              sum(cost)                                                   AS cost_value,
              -- Open risk is what a stop would actually give back. A lot with
              -- no stop contributes exposure but not open risk, which is the
              -- convention the risk engine's heat cap assumes.
              sum(CASE WHEN stop_price IS NULL THEN 0
                       ELSE greatest(
                         0,
                         quantity * (coalesce(close, cost / nullif(quantity, 0)) - stop_price)
                       ) END)                                        AS open_risk,
              count(*)                                                    AS position_count,
              max(marked_from)                                            AS marked_from
         FROM marks
        GROUP BY mandate_id
     ),
     realized AS (
       -- Banked P&L: proceeds less the basis of the lots each exit consumed.
       SELECT o.mandate_id,
              sum(ola.quantity * (f.price - l.cost_basis)) AS pnl
         FROM order_lot_allocations ola
         JOIN orders o ON o.id = ola.order_id
         JOIN lots l   ON l.id = ola.lot_id
         JOIN LATERAL (
           SELECT avg(price) AS price FROM fills WHERE order_id = o.id
         ) f ON true
        WHERE o.account_id = $1
        GROUP BY o.mandate_id
     )
     SELECT ml.id                                  AS mandate_id,
            ml.name                                AS mandate_name,
            coalesce(c.balance, 0)                 AS cash,
            coalesce(v.positions_value, 0)         AS positions_value,
            coalesce(v.cost_value, 0)              AS cost_value,
            coalesce(r.pnl, 0)                     AS realized_pnl,
            coalesce(v.open_risk, 0)               AS open_risk,
            coalesce(v.position_count, 0)          AS position_count,
            v.marked_from                          AS marked_from
       FROM mandate_list ml
       LEFT JOIN cash     c ON c.mandate_id = ml.id
       LEFT JOIN valued   v ON v.mandate_id = ml.id
       LEFT JOIN realized r ON r.mandate_id = ml.id
      ORDER BY ml.name`,
    [params.accountId, params.asOf],
  );

  const snapshots: MandateSnapshot[] = rows.map((row) => {
    const cash = Number(row.cash);
    const positionsValue = Number(row.positions_value);
    const costValue = Number(row.cost_value);
    return {
      mandateId: row.mandate_id,
      mandateName: row.mandate_name,
      asOf: params.asOf,
      cash,
      positionsValue,
      equity: cash + positionsValue,
      realizedPnl: Number(row.realized_pnl),
      unrealizedPnl: positionsValue - costValue,
      openRisk: Number(row.open_risk),
      positionCount: Number(row.position_count),
      markedFrom: row.marked_from ? row.marked_from.toISOString().slice(0, 10) : null,
    };
  });

  for (const snapshot of snapshots) {
    await pool.query(
      // Upsert rather than insert: re-running a session must be idempotent, and
      // a mark corrected after a late corporate action is a legitimate rewrite
      // of a derived measurement.
      `INSERT INTO equity_snapshots
         (account_id, mandate_id, as_of, cash, positions_value, equity,
          realized_pnl, unrealized_pnl, open_risk, position_count, marked_from)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11::date)
       ON CONFLICT (account_id, mandate_id, as_of) DO UPDATE
         SET cash = EXCLUDED.cash,
             positions_value = EXCLUDED.positions_value,
             equity = EXCLUDED.equity,
             realized_pnl = EXCLUDED.realized_pnl,
             unrealized_pnl = EXCLUDED.unrealized_pnl,
             open_risk = EXCLUDED.open_risk,
             position_count = EXCLUDED.position_count,
             marked_from = EXCLUDED.marked_from`,
      [
        params.accountId,
        snapshot.mandateId,
        snapshot.asOf,
        snapshot.cash,
        snapshot.positionsValue,
        snapshot.equity,
        snapshot.realizedPnl,
        snapshot.unrealizedPnl,
        snapshot.openRisk,
        snapshot.positionCount,
        snapshot.markedFrom,
      ],
    );
  }

  return snapshots;
}

/** The recorded curve for one mandate, oldest first. */
export async function equityCurve(
  pool: pg.Pool,
  params: { accountId: string; mandateId: string },
): Promise<Array<{ asOf: string; equity: number; realizedPnl: number }>> {
  const { rows } = await pool.query<{ as_of: Date; equity: string; realized_pnl: string }>(
    `SELECT as_of, equity, realized_pnl FROM equity_snapshots
      WHERE account_id = $1 AND mandate_id = $2 ORDER BY as_of`,
    [params.accountId, params.mandateId],
  );
  return rows.map((row) => ({
    asOf: row.as_of.toISOString().slice(0, 10),
    equity: Number(row.equity),
    realizedPnl: Number(row.realized_pnl),
  }));
}
