import type { PoolClient } from "pg";
import { validateBar, type MarketDataProvider, type RawDailyBar } from "./provider.ts";

export interface IngestReport {
  requested: number;
  inserted: number;
  revised: number;
  unchanged: number;
  rejected: Array<{ bar: RawDailyBar; problems: string[] }>;
}

/**
 * Writes daily bars, preserving point-in-time honesty.
 *
 * Two rules do the real work here:
 *
 *   `observed_at` is the FIRST time we saw a bar, and re-running ingest does not
 *   bump it. Bumping it on every run would make yesterday's bar look like it
 *   only became knowable today, and a backtest standing in the past would go
 *   blind to data it genuinely had.
 *
 *   A bar whose values actually CHANGED is a revision, and does bump
 *   `observed_at` — because the corrected figure genuinely was not knowable
 *   until the vendor published it.
 *
 * Known simplification: only the latest revision is retained, since the primary
 * key is (security_id, session_date). A backtest therefore sees revised values
 * from the revision's observation time onward, but cannot reconstruct the
 * original print. Full revision history would need a separate append-only
 * table; recorded here rather than discovered later.
 */
export async function ingestDailyBars(
  client: PoolClient,
  provider: MarketDataProvider,
  symbols: readonly string[],
  from: string,
  to: string,
): Promise<IngestReport> {
  const report: IngestReport = {
    requested: 0,
    inserted: 0,
    revised: 0,
    unchanged: 0,
    rejected: [],
  };

  const bars = await provider.fetchDailyBars(symbols, from, to);
  report.requested = bars.length;
  if (bars.length === 0) return report;

  const { rows: sourceRows } = await client.query<{ id: string }>(
    `SELECT id FROM sources WHERE slug = $1`,
    [provider.slug],
  );
  const sourceId = sourceRows[0]?.id;
  if (!sourceId) throw new Error(`No sources row for provider "${provider.slug}".`);

  const securityIds = await resolveSecurities(client, bars, sourceId);

  // Provision every year partition the batch touches before inserting, so an
  // overnight run never fails on a missing partition.
  const years = new Set(bars.map((bar) => Number(bar.sessionDate.slice(0, 4))));
  for (const year of years) {
    await client.query(`SELECT vesti_ensure_daily_partition($1)`, [year]);
  }

  // Read the current state of everything this batch touches in one query.
  // The usual `xmax = 0` trick for telling an insert from an update is not
  // available on a partitioned table ("cannot retrieve a system column in this
  // context"), and an explicit comparison is clearer about intent anyway.
  const existing = await loadExisting(client, [...securityIds.values()], bars);

  for (const bar of bars) {
    const problems = validateBar(bar);
    if (problems.length > 0) {
      report.rejected.push({ bar, problems });
      continue;
    }

    const securityId = securityIds.get(bar.symbol);
    if (!securityId) {
      report.rejected.push({ bar, problems: ["unknown symbol"] });
      continue;
    }

    const prior = existing.get(`${securityId}|${bar.sessionDate}`);

    if (prior === undefined) {
      await client.query(
        `INSERT INTO bars_daily
           (security_id, session_date, open, high, low, close, volume, trade_count, vwap, tape, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          securityId,
          bar.sessionDate,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.tradeCount ?? null,
          bar.vwap ?? null,
          provider.tape,
          sourceId,
        ],
      );
      report.inserted += 1;
      continue;
    }

    const changed =
      prior.open !== bar.open ||
      prior.high !== bar.high ||
      prior.low !== bar.low ||
      prior.close !== bar.close ||
      prior.volume !== bar.volume;

    if (!changed) {
      // Identical re-run. Deliberately touching nothing — see the note above
      // about why observed_at must not move.
      report.unchanged += 1;
      continue;
    }

    await client.query(
      `UPDATE bars_daily
         SET open = $3, high = $4, low = $5, close = $6, volume = $7,
             trade_count = $8, vwap = $9, tape = $10, source_id = $11,
             observed_at = now()
       WHERE security_id = $1 AND session_date = $2`,
      [
        securityId,
        bar.sessionDate,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.tradeCount ?? null,
        bar.vwap ?? null,
        provider.tape,
        sourceId,
      ],
    );
    report.revised += 1;
  }

  return report;
}

interface StoredBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function loadExisting(
  client: PoolClient,
  securityIds: readonly string[],
  bars: readonly RawDailyBar[],
): Promise<Map<string, StoredBar>> {
  const map = new Map<string, StoredBar>();
  if (securityIds.length === 0 || bars.length === 0) return map;

  const dates = [...new Set(bars.map((bar) => bar.sessionDate))];
  const { rows } = await client.query<{
    security_id: string;
    session_date: Date;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>(
    `SELECT security_id, session_date, open, high, low, close, volume
     FROM bars_daily
     WHERE security_id = ANY($1) AND session_date = ANY($2::date[])`,
    [securityIds, dates],
  );

  for (const row of rows) {
    // `pg` returns numerics as strings to preserve precision; compare as numbers
    // so 104.00 and 104 do not read as a revision.
    const key = `${row.security_id}|${row.session_date.toISOString().slice(0, 10)}`;
    map.set(key, {
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    });
  }
  return map;
}

/**
 * Maps symbols to security ids, creating rows for symbols we have not seen.
 *
 * Matches only currently-listed securities: tickers get recycled after a
 * delisting, and silently attaching new bars to a dead company's history would
 * corrupt both.
 */
async function resolveSecurities(
  client: PoolClient,
  bars: readonly RawDailyBar[],
  sourceId: string,
): Promise<Map<string, string>> {
  const symbols = [...new Set(bars.map((bar) => bar.symbol))];
  const found = new Map<string, string>();

  const { rows } = await client.query<{ id: string; symbol: string }>(
    `SELECT id, symbol FROM securities WHERE symbol = ANY($1) AND delisted_at IS NULL`,
    [symbols],
  );
  for (const row of rows) found.set(row.symbol, row.id);

  for (const symbol of symbols) {
    if (found.has(symbol)) continue;
    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO securities (symbol, asset_class, source_id)
       VALUES ($1, 'equity', $2)
       RETURNING id`,
      [symbol, sourceId],
    );
    found.set(symbol, created[0]!.id);
  }

  return found;
}
