/**
 * Writing XBRL facts, bitemporally.
 *
 * Two rules do all the work, and both are about `observed_at`:
 *
 *   IT COMES FROM THE FILING DATE, never from the clock. A ten-year backfill
 *   run tonight with `observed_at = now()` would make every fact invisible to
 *   every as-of date before tonight, and a backtest would quietly return no
 *   fundamentals at all rather than failing. This is the same trap the bar
 *   ingest documents, and it is worse here because a missing fundamental looks
 *   like a company that simply does not screen rather than like missing data.
 *
 *   IT IS THE END OF THE FILING DAY, not its start. EDGAR gives a date, not a
 *   time; filings are accepted through the afternoon and disseminated the same
 *   day. Stamping midnight would claim the market knew a 10-K before the market
 *   opened on the day it was filed. 22:00 UTC — after the 17:30 ET filing
 *   deadline — matches the convention the bar ingest already uses and errs
 *   late, which can only withhold data from a backtest, never leak it early.
 *
 * Restatements are inserts, not updates. Two accessions reporting the same
 * period is the normal case over a long history, and the identity constraint
 * includes the accession precisely so both survive. Nothing here ever rewrites
 * a fact: a revision is a new row, and which one a backtest sees is a question
 * only the PIT function is allowed to answer.
 */

import type { PoolClient } from "pg";
import { validateFact, type RawFundamentalFact } from "./edgar.ts";

export interface FundamentalsReport {
  requested: number;
  inserted: number;
  /** Already present under the same accession — a re-run, not a restatement. */
  unchanged: number;
  /** A later filing revising a period we already had. */
  restatements: number;
  rejected: Array<{ fact: RawFundamentalFact; problems: string[] }>;
}

export async function ingestFundamentals(
  client: PoolClient,
  sourceSlug: string,
  facts: readonly RawFundamentalFact[],
): Promise<FundamentalsReport> {
  const report: FundamentalsReport = {
    requested: facts.length,
    inserted: 0,
    unchanged: 0,
    restatements: 0,
    rejected: [],
  };
  if (facts.length === 0) return report;

  const { rows: sourceRows } = await client.query<{ id: string }>(
    `SELECT id FROM sources WHERE slug = $1`,
    [sourceSlug],
  );
  const sourceId = sourceRows[0]?.id;
  if (!sourceId) throw new Error(`No sources row for "${sourceSlug}".`);

  const symbols = [...new Set(facts.map((f) => f.symbol))];
  const { rows: securityRows } = await client.query<{ id: string; symbol: string }>(
    `SELECT id, symbol FROM securities WHERE symbol = ANY($1) AND delisted_at IS NULL`,
    [symbols],
  );
  const securityIds = new Map(securityRows.map((row) => [row.symbol, row.id]));

  // What we already hold for each (security, concept, unit, period), so a new
  // accession can be recognised as a restatement rather than merely counted.
  const known = await loadKnownPeriods(client, [...securityIds.values()]);

  for (const fact of facts) {
    const problems = validateFact(fact);
    const securityId = securityIds.get(fact.symbol);
    if (!securityId) problems.push("unknown symbol — ingest bars first");
    if (problems.length > 0) {
      report.rejected.push({ fact, problems });
      continue;
    }

    const identity = periodKey(securityId!, fact);
    const seenAccessions = known.get(identity);

    const { rowCount } = await client.query(
      // 22:00 UTC on the filing date — see the header. `least(now(), ...)` covers
      // a filing made today, where the end of the day has not arrived yet.
      `INSERT INTO fundamental_facts
         (security_id, taxonomy, concept, unit, period_start, period_end,
          fiscal_year, fiscal_period, form, value, accession, filed_at, frame,
          source_id, observed_at)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12::date, $13, $14,
               least(now(), ($12::date + interval '22 hours') AT TIME ZONE 'UTC'))
       ON CONFLICT ON CONSTRAINT fundamental_facts_identity DO NOTHING`,
      [
        securityId,
        fact.taxonomy,
        fact.concept,
        fact.unit,
        fact.periodStart,
        fact.periodEnd,
        fact.fiscalYear,
        fact.fiscalPeriod,
        fact.form,
        fact.value,
        fact.accession,
        fact.filedAt,
        fact.frame,
        sourceId,
      ],
    );

    if (rowCount === 0) {
      report.unchanged += 1;
      continue;
    }

    if (seenAccessions && seenAccessions.size > 0 && !seenAccessions.has(fact.accession)) {
      // A different filing reporting a period we already had. Counted so a
      // backfill reports how much of the history has been revised rather than
      // leaving it to be discovered as a surprise in a backtest.
      report.restatements += 1;
    } else {
      report.inserted += 1;
    }
    if (seenAccessions) seenAccessions.add(fact.accession);
    else known.set(identity, new Set([fact.accession]));
  }

  return report;
}

function periodKey(securityId: string, fact: RawFundamentalFact): string {
  return [
    securityId,
    fact.taxonomy,
    fact.concept,
    fact.unit,
    fact.periodStart ?? "",
    fact.periodEnd,
  ].join("|");
}

async function loadKnownPeriods(
  client: PoolClient,
  securityIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const known = new Map<string, Set<string>>();
  if (securityIds.length === 0) return known;

  const { rows } = await client.query<{
    security_id: string;
    taxonomy: string;
    concept: string;
    unit: string;
    period_start: Date | null;
    period_end: Date;
    accession: string;
  }>(
    `SELECT security_id, taxonomy, concept, unit, period_start, period_end, accession
       FROM fundamental_facts WHERE security_id = ANY($1)`,
    [securityIds],
  );

  for (const row of rows) {
    const key = [
      row.security_id,
      row.taxonomy,
      row.concept,
      row.unit,
      row.period_start ? row.period_start.toISOString().slice(0, 10) : "",
      row.period_end.toISOString().slice(0, 10),
    ].join("|");
    const set = known.get(key) ?? new Set<string>();
    set.add(row.accession);
    known.set(key, set);
  }
  return known;
}

/**
 * Records the CIK a symbol resolves to.
 *
 * Stored on first sight because EDGAR's ticker file only lists currently-listed
 * companies. Once a name delists it drops out of that file and cannot be
 * resolved from its ticker again — so a survivorship-safe history depends on
 * having written the mapping down while the company was still there.
 */
export async function recordCik(
  client: PoolClient,
  params: { securityId: string; cik: string },
): Promise<void> {
  await client.query(
    `INSERT INTO security_identifiers (security_id, kind, value)
     VALUES ($1, 'cik', $2)
     ON CONFLICT (kind, value) DO NOTHING`,
    [params.securityId, params.cik],
  );
}

/** The CIK already recorded for a symbol, if any. */
export async function knownCiks(
  client: PoolClient,
  symbols: readonly string[],
): Promise<Map<string, { securityId: string; cik: string }>> {
  const { rows } = await client.query<{ symbol: string; id: string; value: string }>(
    `SELECT s.symbol, s.id, i.value
       FROM securities s
       JOIN security_identifiers i ON i.security_id = s.id AND i.kind = 'cik'
      WHERE s.symbol = ANY($1) AND s.delisted_at IS NULL`,
    [symbols],
  );
  return new Map(rows.map((row) => [row.symbol, { securityId: row.id, cik: row.value }]));
}
