/**
 * What is actually in the database.
 *
 * Ingestion prints what it did; this prints what is there, which is not the same
 * claim and is the one worth trusting after a failed or partial run. It answers
 * the question every setup attempt so far has left open — did anything land, and
 * does it cover the period it is supposed to?
 *
 * Read-only, and it never fails the build: it runs after a failed step
 * specifically to describe the wreckage.
 */
import pg from "pg";

const say = (s = ""): void => void process.stdout.write(`${s}\n`);
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

interface Row {
  label: string;
  count: number;
  detail: string;
}

const QUERIES: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: "daily bars",
    sql: `SELECT count(*)::bigint AS count,
                 coalesce(min(session_date)::text || ' → ' || max(session_date)::text, '') AS detail
          FROM bars_daily`,
  },
  {
    label: "securities",
    sql: `SELECT count(*)::bigint AS count,
                 coalesce(string_agg(symbol, ' ' ORDER BY symbol), '') AS detail
          FROM securities WHERE delisted_at IS NULL`,
  },
  {
    label: "corporate actions",
    sql: `SELECT count(*)::bigint AS count,
                 coalesce(string_agg(DISTINCT kind, ', '), '') AS detail
          FROM corporate_actions`,
  },
  {
    label: "fundamental facts",
    sql: `SELECT count(*)::bigint AS count,
                 coalesce(min(filed_at)::text || ' → ' || max(filed_at)::text, '') AS detail
          FROM fundamental_facts`,
  },
  {
    // Identifiers are stored as (kind, value) rows rather than columns, so a
    // CIK is a row with kind = 'cik'.
    label: "CIKs recorded",
    sql: `SELECT count(*)::bigint AS count, '' AS detail
          FROM security_identifiers WHERE kind = 'cik'`,
  },
  {
    label: "migrations applied",
    sql: `SELECT count(*)::bigint AS count,
                 coalesce(max(name), '') AS detail
          FROM schema_migrations`,
  },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    say("DATABASE_URL is unset — nothing to summarise.");
    return;
  }

  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
  } catch (error) {
    say(`Could not connect: ${(error as Error).message}`);
    return;
  }

  say();
  say("Database contents");
  say("─────────────────");

  const rows: Row[] = [];
  for (const { label, sql } of QUERIES) {
    try {
      const { rows: result } = await client.query<{ count: string; detail: string }>(sql);
      rows.push({
        label,
        count: Number(result[0]?.count ?? 0),
        detail: result[0]?.detail ?? "",
      });
    } catch (error) {
      // A missing table means migrations did not get that far, which is itself
      // the answer rather than a reason to stop.
      rows.push({ label, count: -1, detail: (error as Error).message.split("\n")[0] ?? "" });
    }
  }

  const width = Math.max(...rows.map((r) => r.label.length));
  for (const row of rows) {
    const count = row.count < 0 ? "—" : row.count.toLocaleString();
    say(`  ${row.label.padEnd(width)}  ${count.padStart(9)}  ${dim(row.detail.slice(0, 90))}`);
  }

  const bars = rows.find((r) => r.label === "daily bars");
  if (bars && bars.count === 0) {
    say();
    say(dim("  No bars. Market data ingestion has not run, or ran without valid Alpaca keys."));
  }

  await client.end().catch(() => {});
  say();
}

await main();
