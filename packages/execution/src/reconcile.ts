/**
 * Reconciliation between our lot ledger and the broker's own books.
 *
 * A broker holds one omnibus position per symbol. We hold tax lots split across
 * mandates. Those are two different representations of the same shares, and the
 * only thing keeping them in agreement is that our posting code is correct —
 * which is precisely the assumption worth checking rather than trusting.
 *
 * This is the check that makes the specific-lot ledger falsifiable. Mandate
 * isolation is enforced inside our own tables, so our tables will always agree
 * with themselves; comparing them to an external party's count is what turns
 * "our arithmetic is self-consistent" into "our arithmetic describes reality".
 *
 * It is deliberately a report rather than a repair. A drift means either a fill
 * we never saw, one we applied twice, or a corporate action nobody processed,
 * and those want different responses — silently writing our number over the
 * broker's, or theirs over ours, would destroy the evidence needed to tell them
 * apart.
 */

import type pg from "pg";

export interface ExternalPosition {
  symbol: string;
  quantity: number;
}

export type DiscrepancyKind =
  | "quantity_mismatch"
  | "missing_at_broker"
  | "missing_in_ledger"
  | "cash_mismatch";

export interface Discrepancy {
  kind: DiscrepancyKind;
  symbol: string | null;
  /** What our lots say. */
  ledger: number;
  /** What the broker says. */
  broker: number;
  /** Per-mandate breakdown of our side, so a drift can be located. */
  byMandate?: Array<{ mandate: string; quantity: number }>;
}

export interface ReconciliationReport {
  accountId: string;
  checkedAt: Date;
  positionsChecked: number;
  discrepancies: Discrepancy[];
  balanced: boolean;
}

/** Share counts within this of each other are equal — float noise, not drift. */
const QUANTITY_EPSILON = 1e-6;
/** Cash is compared to the cent. */
const CASH_EPSILON = 0.005;

export async function reconcile(
  pool: pg.Pool,
  params: {
    accountId: string;
    positions: readonly ExternalPosition[];
    /** The broker's cash figure. Omit to skip the cash check. */
    brokerCash?: number;
  },
): Promise<ReconciliationReport> {
  const { rows: ledgerRows } = await pool.query<{
    symbol: string;
    mandate: string;
    quantity: string;
  }>(
    `SELECT s.symbol, m.name AS mandate, sum(l.remaining) AS quantity
       FROM lots l
       JOIN securities s ON s.id = l.security_id
       JOIN mandates m   ON m.id = l.mandate_id
      WHERE l.account_id = $1 AND l.remaining > 0
      GROUP BY s.symbol, m.name
      ORDER BY s.symbol, m.name`,
    [params.accountId],
  );

  const ledgerBySymbol = new Map<string, { total: number; byMandate: Array<{ mandate: string; quantity: number }> }>();
  for (const row of ledgerRows) {
    const entry = ledgerBySymbol.get(row.symbol) ?? { total: 0, byMandate: [] };
    const quantity = Number(row.quantity);
    entry.total += quantity;
    entry.byMandate.push({ mandate: row.mandate, quantity });
    ledgerBySymbol.set(row.symbol, entry);
  }

  const brokerBySymbol = new Map(params.positions.map((p) => [p.symbol, p.quantity]));
  const discrepancies: Discrepancy[] = [];

  for (const [symbol, entry] of ledgerBySymbol) {
    const broker = brokerBySymbol.get(symbol);
    if (broker === undefined) {
      // We think we own shares the broker has never heard of. Almost always a
      // fill posted against an order the venue rejected.
      discrepancies.push({
        kind: "missing_at_broker",
        symbol,
        ledger: entry.total,
        broker: 0,
        byMandate: entry.byMandate,
      });
      continue;
    }
    if (Math.abs(entry.total - broker) > QUANTITY_EPSILON) {
      discrepancies.push({
        kind: "quantity_mismatch",
        symbol,
        ledger: entry.total,
        broker,
        byMandate: entry.byMandate,
      });
    }
  }

  for (const [symbol, quantity] of brokerBySymbol) {
    if (ledgerBySymbol.has(symbol)) continue;
    if (Math.abs(quantity) <= QUANTITY_EPSILON) continue;
    // The dangerous direction: real shares nobody's mandate is accounting for,
    // so no stop is watching them and no exit will ever name them.
    discrepancies.push({ kind: "missing_in_ledger", symbol, ledger: 0, broker: quantity });
  }

  if (params.brokerCash !== undefined) {
    const { rows } = await pool.query<{ balance: string | null }>(
      `SELECT sum(amount) AS balance FROM cash_ledger WHERE account_id = $1`,
      [params.accountId],
    );
    const ledgerCash = Number(rows[0]?.balance ?? 0);
    if (Math.abs(ledgerCash - params.brokerCash) > CASH_EPSILON) {
      discrepancies.push({
        kind: "cash_mismatch",
        symbol: null,
        ledger: ledgerCash,
        broker: params.brokerCash,
      });
    }
  }

  return {
    accountId: params.accountId,
    checkedAt: new Date(),
    positionsChecked: new Set([...ledgerBySymbol.keys(), ...brokerBySymbol.keys()]).size,
    discrepancies,
    balanced: discrepancies.length === 0,
  };
}
