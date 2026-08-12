/**
 * Bars for a backtest, read the only way a backtest may read them.
 *
 * Every series comes from `pit_bars_daily` with an as-of instant, which is what
 * makes the split adjustment correct rather than convenient: a 4:1 that was
 * announced in July is not applied to a June bar, because in June nobody knew.
 * Reading `bars_daily` directly would be faster and would silently bake every
 * later corporate action into the history the strategy sees — the largest
 * look-ahead vector in price data, and the reason D-006 exists.
 *
 * The as-of instant is the END of the run, not each session's own date. That is
 * deliberate and worth being precise about: it means adjustments known by the
 * end of the window are applied throughout, which is standard practice and is
 * what makes a continuous series comparable across a split. What it does NOT do
 * is let the strategy see a future *price* — the engine slices history to the
 * session being decided. The residual effect is that a split announced after
 * the run's end is excluded, which is the direction that cannot flatter.
 */

import type pg from "pg";
import type { StrategyBar } from "@vesti/core/strategy/types.ts";

export interface LoadOptions {
  symbols: readonly string[];
  from: string;
  to: string;
}

export interface LoadedBars {
  bars: Map<string, StrategyBar[]>;
  sectors: Map<string, string>;
  /** Symbols asked for that the database does not hold. */
  missing: string[];
}

interface BarRow {
  symbol: string;
  session_date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export async function loadBars(
  client: pg.PoolClient | pg.Client,
  options: LoadOptions,
): Promise<LoadedBars> {
  const { rows: securities } = await client.query<{ id: string; symbol: string; sector: string | null }>(
    `SELECT id, symbol, sector FROM securities
      WHERE symbol = ANY($1) AND delisted_at IS NULL`,
    [[...options.symbols]],
  );

  const sectors = new Map<string, string>();
  for (const row of securities) if (row.sector) sectors.set(row.symbol, row.sector);

  const found = new Set(securities.map((s) => s.symbol));
  const missing = options.symbols.filter((s) => !found.has(s));

  const bars = new Map<string, StrategyBar[]>();
  // One call per security: `pit_bars_daily` takes a single security and an
  // as-of instant, and a join that hid that would hide which as-of was used.
  for (const security of securities) {
    const { rows } = await client.query<BarRow>(
      `SELECT $1::text AS symbol, b.session_date::text, b.open, b.high, b.low, b.close, b.volume
         FROM pit_bars_daily(
                ($2::date + 1)::timestamptz,  -- as-of: the day after the window ends
                $3::uuid,
                $4::date,
                $2::date
              ) b
        ORDER BY b.session_date`,
      [security.symbol, options.to, security.id, options.from],
    );

    bars.set(
      security.symbol,
      rows.map((row) => ({
        sessionDate: row.session_date,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      })),
    );
  }

  return { bars, sectors, missing };
}
