/**
 * Corporate action ingestion.
 *
 * `announced_at` is the whole point of this table. It is not metadata — it is
 * the field that decides whether a backtest standing on a given date is allowed
 * to know about a split at all. Ingesting an action with `announced_at` set to
 * "now" (or worse, to the ex-date) would let every historical bar be adjusted
 * with knowledge that did not exist yet, which is look-ahead bias of the most
 * flattering kind: it makes past prices line up perfectly with the present.
 *
 * So the vendor's announcement timestamp is carried through untouched, and a
 * missing one is a rejection rather than a defaulted value.
 */
import type { PoolClient } from "pg";
import type { MarketDataProvider, RawCorporateAction } from "./provider.ts";

export interface ActionIngestReport {
  requested: number;
  inserted: number;
  unchanged: number;
  rejected: Array<{ action: RawCorporateAction; problems: string[] }>;
}

export function validateAction(action: RawCorporateAction): string[] {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(action.exDate)) problems.push("malformed ex-date");
  if (Number.isNaN(Date.parse(action.announcedAt))) problems.push("malformed announcement time");
  // Announcement after the fact is how look-ahead gets in.
  if (action.announcedAt.slice(0, 10) > action.exDate) {
    problems.push("announced after the ex-date");
  }
  if (action.kind === "split") {
    if (!action.splitRatio || !(action.splitRatio > 0)) problems.push("split without a positive ratio");
  }
  if (action.kind === "cash_dividend") {
    if (!action.cashAmount || !(action.cashAmount > 0)) problems.push("dividend without an amount");
  }
  return problems;
}

export async function ingestCorporateActions(
  client: PoolClient,
  provider: MarketDataProvider,
  symbols: readonly string[],
  from: string,
  to: string,
): Promise<ActionIngestReport> {
  const report: ActionIngestReport = { requested: 0, inserted: 0, unchanged: 0, rejected: [] };
  if (!provider.fetchCorporateActions) return report;

  const actions = await provider.fetchCorporateActions(symbols, from, to);
  report.requested = actions.length;
  if (actions.length === 0) return report;

  const { rows: sourceRows } = await client.query<{ id: string }>(
    `SELECT id FROM sources WHERE slug = $1`,
    [provider.slug],
  );
  const sourceId = sourceRows[0]?.id;
  if (!sourceId) throw new Error(`No sources row for provider "${provider.slug}".`);

  const { rows: securityRows } = await client.query<{ id: string; symbol: string }>(
    `SELECT id, symbol FROM securities WHERE symbol = ANY($1) AND delisted_at IS NULL`,
    [[...new Set(actions.map((a) => a.symbol))]],
  );
  const securityIds = new Map(securityRows.map((row) => [row.symbol, row.id]));

  for (const action of actions) {
    const problems = validateAction(action);
    const securityId = securityIds.get(action.symbol);
    if (!securityId) problems.push("unknown symbol — ingest bars first");
    if (problems.length > 0) {
      report.rejected.push({ action, problems });
      continue;
    }

    // An action is identified by what it is and when it takes effect, so a
    // re-run is a no-op rather than a duplicate that would double-adjust every
    // price before it.
    const { rowCount } = await client.query(
      `INSERT INTO corporate_actions
         (security_id, kind, ex_date, announced_at, split_ratio, cash_amount, source_id)
       SELECT $1, $2, $3::date, $4::timestamptz, $5, $6, $7
       WHERE NOT EXISTS (
         SELECT 1 FROM corporate_actions
         WHERE security_id = $1 AND kind = $2 AND ex_date = $3::date
       )`,
      [
        securityId,
        action.kind,
        action.exDate,
        action.announcedAt,
        action.splitRatio ?? null,
        action.cashAmount ?? null,
        sourceId,
      ],
    );

    if (rowCount === 1) report.inserted += 1;
    else report.unchanged += 1;
  }

  return report;
}
