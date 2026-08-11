import "server-only";
import { num, withUser } from "./db.ts";

/**
 * Portfolio reads.
 *
 * All domain logic lives here, never in a component. Every screen is backed by
 * a shape that mirrors exactly what it renders, so an Expo client added later
 * consumes the same JSON without porting any logic.
 *
 * Positions are derived from open LOTS, grouped by (security, mandate) — not by
 * security alone. The same ticker held in two mandates is two positions with
 * two theses and two stops, and flattening them here would quietly undo the
 * isolation the database enforces.
 */

export interface MandateSummary {
  id: string;
  kind: "active" | "catalyst" | "long_term";
  name: string;
  marketValue: number;
  costBasis: number;
  unrealised: number;
  positionCount: number;
  targetWeight: number;
}

export interface PositionSummary {
  securityId: string;
  symbol: string;
  name: string | null;
  mandateId: string;
  mandateKind: MandateSummary["kind"];
  quantity: number;
  costBasis: number;
  marketValue: number;
  unrealised: number;
  unrealisedPct: number;
  stopPrice: number | null;
  targetPrice: number | null;
  lastPrice: number;
}

export interface PortfolioSnapshot {
  totalEquity: number;
  cash: number;
  invested: number;
  unrealised: number;
  mandates: MandateSummary[];
  positions: PositionSummary[];
}

const MANDATE_ORDER: Record<MandateSummary["kind"], number> = {
  long_term: 0,
  catalyst: 1,
  active: 2,
};

export async function getPortfolio(userId: string, accountId: string): Promise<PortfolioSnapshot> {
  return withUser(userId, async (client) => {
    // Cash is a fold over the ledger, never a stored balance — so it is always
    // explicable and cannot drift out of agreement with its own history.
    const cashResult = await client.query<{ cash: string }>(
      `SELECT coalesce(sum(amount), 0) AS cash FROM cash_ledger WHERE account_id = $1`,
      [accountId],
    );

    // Phase 1 has no market data, so the last known price is the lot's cost
    // basis. Phase 2 replaces this join with pit_bars_daily. Marking positions
    // at cost means unrealised P&L reads as zero — which is honest, rather than
    // inventing a price we do not have.
    const positionsResult = await client.query<{
      security_id: string;
      symbol: string;
      name: string | null;
      mandate_id: string;
      mandate_kind: MandateSummary["kind"];
      quantity: string;
      cost_basis: string;
      market_value: string;
      stop_price: string | null;
      target_price: string | null;
      last_price: string;
    }>(
      `SELECT
         s.id            AS security_id,
         s.symbol,
         s.name,
         m.id            AS mandate_id,
         m.kind          AS mandate_kind,
         sum(l.remaining)                          AS quantity,
         sum(l.remaining * l.cost_basis)           AS cost_basis,
         sum(l.remaining * l.cost_basis)           AS market_value,
         min(l.stop_price)                         AS stop_price,
         max(l.target_price)                       AS target_price,
         avg(l.cost_basis)                         AS last_price
       FROM lots l
       JOIN securities s ON s.id = l.security_id
       JOIN mandates   m ON m.id = l.mandate_id
       WHERE l.account_id = $1 AND l.remaining > 0
       GROUP BY s.id, s.symbol, s.name, m.id, m.kind
       ORDER BY sum(l.remaining * l.cost_basis) DESC`,
      [accountId],
    );

    const mandatesResult = await client.query<{
      id: string;
      kind: MandateSummary["kind"];
      name: string;
      target_weight: string;
    }>(`SELECT id, kind, name, target_weight FROM mandates ORDER BY kind`);

    const positions: PositionSummary[] = positionsResult.rows.map((row) => {
      const costBasis = num(row.cost_basis);
      const marketValue = num(row.market_value);
      const unrealised = marketValue - costBasis;
      return {
        securityId: row.security_id,
        symbol: row.symbol,
        name: row.name,
        mandateId: row.mandate_id,
        mandateKind: row.mandate_kind,
        quantity: num(row.quantity),
        costBasis,
        marketValue,
        unrealised,
        unrealisedPct: costBasis === 0 ? 0 : unrealised / costBasis,
        stopPrice: row.stop_price === null ? null : num(row.stop_price),
        targetPrice: row.target_price === null ? null : num(row.target_price),
        lastPrice: num(row.last_price),
      };
    });

    const mandates: MandateSummary[] = mandatesResult.rows
      .map((row) => {
        const held = positions.filter((p) => p.mandateId === row.id);
        const marketValue = held.reduce((sum, p) => sum + p.marketValue, 0);
        const costBasis = held.reduce((sum, p) => sum + p.costBasis, 0);
        return {
          id: row.id,
          kind: row.kind,
          name: row.name,
          marketValue,
          costBasis,
          unrealised: marketValue - costBasis,
          positionCount: held.length,
          targetWeight: num(row.target_weight),
        };
      })
      .sort((a, b) => MANDATE_ORDER[a.kind] - MANDATE_ORDER[b.kind]);

    const cash = num(cashResult.rows[0]?.cash);
    const invested = positions.reduce((sum, p) => sum + p.marketValue, 0);

    return {
      totalEquity: cash + invested,
      cash,
      invested,
      unrealised: positions.reduce((sum, p) => sum + p.unrealised, 0),
      mandates,
      positions,
    };
  });
}

/**
 * The single-user deployment's identity. Phase 1 auth (passkey) replaces this
 * with a real session lookup; isolating it here means exactly one call site
 * changes when it does.
 */
export async function resolveCurrentContext(): Promise<{ userId: string; accountId: string } | null> {
  const { Pool } = await import("pg");
  const connectionString = process.env.DATABASE_URL_APP;
  if (!connectionString) return null;

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query<{ user_id: string; account_id: string }>(
      `SELECT u.id AS user_id, a.id AS account_id
       FROM users u JOIN accounts a ON a.user_id = u.id
       ORDER BY u.created_at, a.opened_at LIMIT 1`,
    );
    return rows[0] ? { userId: rows[0].user_id, accountId: rows[0].account_id } : null;
  } finally {
    await pool.end();
  }
}
