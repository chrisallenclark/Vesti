/**
 * Fundamentals through the real write path and the real PIT function.
 *
 * The assertion this file exists for: **a filing is invisible before it was
 * filed.** Everything else here supports it.
 *
 * It is worth being precise about why that matters more for fundamentals than
 * for prices. A price is knowable the instant it prints, so the worst a sloppy
 * price pipeline does is misalign a bar. A financial fact describes a period
 * that ended weeks before anyone outside the company saw it — Q4 revenue is
 * true on 31 December and public in February. A screen that reads December's
 * revenue in December is not slightly optimistic; it knows the future, and it
 * will produce a strategy that looks superb and cannot be traded.
 *
 * The second assertion is restatements. Companies revise prior periods, and the
 * revision arrives under a new accession months or years later. A backtest
 * standing in 2023 must see 2023's understanding of 2022, not the corrected
 * figure published afterwards — otherwise every historical screen is run on
 * numbers nobody had.
 *
 * Runs entirely offline. Needs Postgres, not the internet.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { RawFundamentalFact } from "./edgar.ts";
import { ingestFundamentals, knownCiks, recordCik } from "./fundamentals.ts";

const execFileAsync = promisify(execFile);
const DB_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const TEST_DB = process.env.VESTI_FUNDAMENTALS_TEST_DB ?? "vesti_fundamentals_test";
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_URL = testUrl.toString();

const SYMBOL = "FUND";

let pool: pg.Pool;
let client: pg.PoolClient;
let db: pg.Client;
let securityId: string;

/**
 * FY2022 revenue, as originally reported and as later restated, plus FY2023.
 * Dates chosen so every boundary in the PIT function is exercised.
 */
const ORIGINAL_FY2022: RawFundamentalFact = {
  symbol: SYMBOL,
  taxonomy: "us-gaap",
  concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
  unit: "USD",
  periodStart: "2021-10-01",
  periodEnd: "2022-09-30",
  fiscalYear: 2022,
  fiscalPeriod: "FY",
  form: "10-K",
  value: 394_328_000_000,
  accession: "0000320193-22-000108",
  filedAt: "2022-10-28",
  frame: "CY2022",
};

const RESTATED_FY2022: RawFundamentalFact = {
  ...ORIGINAL_FY2022,
  value: 394_000_000_000,
  accession: "0000320193-23-000106",
  filedAt: "2023-11-03",
  frame: null,
};

const FY2023: RawFundamentalFact = {
  ...ORIGINAL_FY2022,
  periodStart: "2022-10-01",
  periodEnd: "2023-09-30",
  fiscalYear: 2023,
  value: 383_285_000_000,
  accession: "0000320193-23-000106",
  filedAt: "2023-11-03",
  frame: null,
};

const ASSETS_FY2023: RawFundamentalFact = {
  ...FY2023,
  concept: "Assets",
  periodStart: null,
  value: 352_583_000_000,
};

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  await execFileAsync("npx", ["tsx", "src/migrate.ts", "up"], {
    cwd: DB_PACKAGE,
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });

  db = new pg.Client({ connectionString: TEST_URL });
  await db.connect();
  const { rows: sources } = await db.query<{ id: string }>(
    `SELECT id FROM sources WHERE slug = 'sec_edgar'`,
  );
  const { rows: securities } = await db.query<{ id: string }>(
    `INSERT INTO securities (symbol, asset_class, source_id) VALUES ($1, 'equity', $2) RETURNING id`,
    [SYMBOL, sources[0]!.id],
  );
  securityId = securities[0]!.id;

  // As vesti_research, which is the role that ingests and has no write path to
  // anything that moves money.
  const researchUrl = new URL(TEST_URL);
  researchUrl.username = "vesti_research";
  researchUrl.password = process.env.VESTI_RESEARCH_PASSWORD ?? "";
  pool = new pg.Pool({ connectionString: researchUrl.toString(), max: 2 });
  client = await pool.connect();
});

after(async () => {
  client?.release();
  await pool?.end();
  await db?.end();
});

async function pitRevenue(asOf: string): Promise<{ value: number; accession: string } | null> {
  const { rows } = await db.query<{ value: string; accession: string }>(
    `SELECT value, accession FROM pit_fundamental_facts($1::timestamptz, $2::uuid)
      WHERE period_end = '2022-09-30' AND concept <> 'Assets'`,
    [asOf, securityId],
  );
  const row = rows[0];
  return row ? { value: Number(row.value), accession: row.accession } : null;
}

describe("ingesting fundamentals", () => {
  it("writes every version of a restated period rather than overwriting", async () => {
    const report = await ingestFundamentals(client, "sec_edgar", [
      ORIGINAL_FY2022,
      RESTATED_FY2022,
      FY2023,
      ASSETS_FY2023,
    ]);
    assert.deepEqual(report.rejected, []);
    assert.equal(report.inserted, 3);
    assert.equal(report.restatements, 1, "FY2022 reported twice under two accessions");

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM fundamental_facts WHERE period_end = '2022-09-30'`,
    );
    assert.equal(Number(rows[0]!.n), 2, "both versions survive");
  });

  it("treats an identical re-run as a no-op", async () => {
    const report = await ingestFundamentals(client, "sec_edgar", [
      ORIGINAL_FY2022,
      RESTATED_FY2022,
      FY2023,
      ASSETS_FY2023,
    ]);
    assert.equal(report.inserted, 0);
    assert.equal(report.restatements, 0);
    assert.equal(report.unchanged, 4);
  });

  it("stamps observed_at from the filing date, never from the clock", async () => {
    // A ten-year backfill run tonight with observed_at = now() would be
    // invisible to every as-of date before tonight, and a backtest would
    // silently return no fundamentals rather than failing.
    const { rows } = await db.query<{ observed_at: Date; filed_at: Date }>(
      `SELECT observed_at, filed_at FROM fundamental_facts WHERE accession = $1 LIMIT 1`,
      [ORIGINAL_FY2022.accession],
    );
    const observed = rows[0]!.observed_at.toISOString();
    assert.ok(observed.startsWith("2022-10-28"), `observed_at was ${observed}`);
    // End of the filing day, not its start: filings are accepted through the
    // afternoon, so midnight would claim the market knew a 10-K before it
    // opened that morning.
    assert.equal(observed.slice(11, 16), "22:00");
  });

  it("rejects a fact filed before its period ended, at the database too", async () => {
    // The validator catches this first; the CHECK constraint is the reason a
    // bug in the validator cannot quietly admit one.
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO fundamental_facts
             (security_id, taxonomy, concept, unit, period_end, form, value,
              accession, filed_at, source_id, observed_at)
           SELECT $1, 'us-gaap', 'Assets', 'USD', '2023-12-31'::date, '10-K', 1,
                  'impossible', '2023-06-01'::date, id, now()
             FROM sources WHERE slug = 'sec_edgar'`,
          [securityId],
        ),
      /fundamental_facts_filed_after_period/,
    );
  });

  it("stores instantaneous facts without duplicating them on re-ingest", async () => {
    // period_start IS NULL on every balance-sheet row, and a unique constraint
    // that treated NULLs as distinct would duplicate all of them every run.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM fundamental_facts WHERE concept = 'Assets'`,
    );
    assert.equal(Number(rows[0]!.n), 1);
  });
});

describe("point-in-time fundamentals", () => {
  it("cannot see a filing that had not been filed", async () => {
    // FY2022 ended 30 September 2022 and was filed on 28 October. A screen run
    // in between must see nothing — the company had the number and the market
    // did not.
    assert.equal(await pitRevenue("2022-10-01T00:00:00Z"), null);
    assert.equal(await pitRevenue("2022-10-27T23:59:59Z"), null);
  });

  it("cannot see a filing on the morning of the day it was filed", async () => {
    // Filings are accepted through the afternoon. A backtest standing at the
    // open on filing day did not have it yet.
    assert.equal(await pitRevenue("2022-10-28T13:30:00Z"), null);
  });

  it("sees it once the filing day is over", async () => {
    const seen = await pitRevenue("2022-10-29T00:00:00Z");
    assert.equal(seen?.value, 394_328_000_000);
    assert.equal(seen?.accession, ORIGINAL_FY2022.accession);
  });

  it("returns the ORIGINAL figure to a backtest standing before the restatement", async () => {
    // The whole point of bitemporality. A screen run in early 2023 has to see
    // what a person could have seen in early 2023.
    const seen = await pitRevenue("2023-01-15T00:00:00Z");
    assert.equal(seen?.value, 394_328_000_000);
    assert.equal(seen?.accession, ORIGINAL_FY2022.accession);
  });

  it("returns the RESTATED figure once the revision has been filed", async () => {
    const seen = await pitRevenue("2024-01-15T00:00:00Z");
    assert.equal(seen?.value, 394_000_000_000);
    assert.equal(seen?.accession, RESTATED_FY2022.accession);
  });

  it("returns exactly one row per period, not one per filing", async () => {
    // DISTINCT ON does the restatement selection. Two rows here would silently
    // double any metric that sums or averages across periods.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM pit_fundamental_facts($1::timestamptz, $2::uuid)
        WHERE period_end = '2022-09-30'`,
      ["2024-01-15T00:00:00Z", securityId],
    );
    assert.equal(Number(rows[0]!.n), 1);
  });

  it("filters by concept without losing the restatement logic", async () => {
    const { rows } = await db.query<{ concept: string; value: string }>(
      `SELECT concept, value FROM pit_fundamental_facts($1::timestamptz, $2::uuid, $3::text[])`,
      ["2024-01-15T00:00:00Z", securityId, ["Assets"]],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.concept, "Assets");
    assert.equal(Number(rows[0]!.value), 352_583_000_000);
  });

  it("is reachable by the backtest role, which can read nothing else", async () => {
    // Same arrangement as the price PIT layer: the backtester gets EXECUTE on
    // the function and SELECT on no base table, so reading the future is a
    // privilege it does not hold rather than a discipline it must keep.
    const backtestUrl = new URL(TEST_URL);
    backtestUrl.username = "vesti_backtest";
    backtestUrl.password = process.env.VESTI_BACKTEST_PASSWORD ?? "";
    const backtest = new pg.Client({ connectionString: backtestUrl.toString() });
    await backtest.connect();
    try {
      await assert.rejects(
        () => backtest.query(`SELECT * FROM fundamental_facts LIMIT 1`),
        /permission denied/,
      );
      const { rows } = await backtest.query(
        `SELECT count(*) AS n FROM pit_fundamental_facts($1::timestamptz)`,
        ["2024-01-15T00:00:00Z"],
      );
      assert.ok(Number(rows[0]!.n) > 0, "the PIT function must work for the backtest role");
    } finally {
      await backtest.end();
    }
  });
});

describe("CIK mapping", () => {
  it("records the CIK so a name stays resolvable after it delists", async () => {
    // EDGAR's ticker file lists only currently-listed companies. Once a name
    // drops out of it, its ticker can never be resolved again — so the mapping
    // has to be written down while the company is still there.
    await recordCik(client, { securityId, cik: "0000320193" });
    const map = await knownCiks(client, [SYMBOL]);
    assert.equal(map.get(SYMBOL)?.cik, "0000320193");
  });

  it("is idempotent", async () => {
    await recordCik(client, { securityId, cik: "0000320193" });
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM security_identifiers WHERE kind = 'cik'`,
    );
    assert.equal(Number(rows[0]!.n), 1);
  });
});
