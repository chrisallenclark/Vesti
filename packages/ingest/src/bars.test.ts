/**
 * Ingestion tests.
 *
 * Run against a real Postgres with a fake provider, so the assertions cover the
 * part that can silently corrupt everything downstream — observed_at semantics,
 * revision handling, and bad-tick rejection — without depending on a vendor
 * being reachable or on today's market data.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ingestDailyBars } from "./bars.ts";
import { validateBar, type MarketDataProvider, type RawDailyBar } from "./provider.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const TEST_DB = "vesti_ingest_test";
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_URL = testUrl.toString();

let pool: pg.Pool;

/** Returns whatever bars it is handed. Deterministic and offline. */
class FakeProvider implements MarketDataProvider {
  readonly slug = "alpaca";
  readonly tape = "iex" as const;
  constructor(private bars: RawDailyBar[]) {}
  setBars(bars: RawDailyBar[]) {
    this.bars = bars;
  }
  async fetchDailyBars(): Promise<RawDailyBar[]> {
    return this.bars;
  }
}

const bar = (overrides: Partial<RawDailyBar> = {}): RawDailyBar => ({
  symbol: "TESTX",
  sessionDate: "2024-03-14",
  open: 100,
  high: 105,
  low: 99,
  close: 104,
  volume: 1_000_000,
  ...overrides,
});

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  await execFileAsync("npx", ["tsx", "src/migrate.ts", "up"], {
    cwd: join(REPO_ROOT, "packages", "db"),
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });

  pool = new pg.Pool({ connectionString: TEST_URL });
});

after(async () => {
  await pool?.end();
});

describe("validateBar", () => {
  it("accepts a coherent bar", () => {
    assert.deepEqual(validateBar(bar()), []);
  });

  it("rejects bars that cannot be true", () => {
    // Each of these has reached production data somewhere, and a single one
    // poisons every feature and expectancy figure computed from it.
    assert.ok(validateBar(bar({ high: 90 })).includes("high below low"));
    assert.ok(validateBar(bar({ low: 0 })).includes("non-positive low"));
    assert.ok(validateBar(bar({ volume: -5 })).includes("negative volume"));
    assert.ok(validateBar(bar({ close: Number.NaN })).includes("non-finite price"));
    assert.ok(validateBar(bar({ sessionDate: "14/03/2024" })).includes("malformed session date"));
  });

  it("rejects a VWAP outside the bar's own range", () => {
    assert.ok(validateBar(bar({ vwap: 200 })).includes("vwap outside high/low range"));
    assert.deepEqual(validateBar(bar({ vwap: 102 })), []);
  });
});

describe("ingestDailyBars", () => {
  it("inserts new bars and creates unknown securities", async () => {
    const client = await pool.connect();
    try {
      const provider = new FakeProvider([bar(), bar({ sessionDate: "2024-03-15", high: 107, close: 106 })]);
      const report = await ingestDailyBars(client, provider, ["TESTX"], "2024-03-01", "2024-03-31");

      assert.equal(report.inserted, 2);
      assert.equal(report.revised, 0);
      assert.equal(report.rejected.length, 0);

      const { rows } = await client.query<{ count: string; tape: string }>(
        `SELECT count(*)::text AS count, min(tape::text) AS tape FROM bars_daily`,
      );
      assert.equal(rows[0]!.count, "2");
      // Tape provenance must survive ingestion — it is what makes a later
      // full-tape upgrade able to find the biased rows.
      assert.equal(rows[0]!.tape, "iex");
    } finally {
      client.release();
    }
  });

  it("does not bump observed_at when re-ingesting identical data", async () => {
    const client = await pool.connect();
    try {
      const { rows: before } = await client.query<{ observed_at: Date }>(
        `SELECT observed_at FROM bars_daily WHERE session_date = '2024-03-14'`,
      );

      const provider = new FakeProvider([bar()]);
      const report = await ingestDailyBars(client, provider, ["TESTX"], "2024-03-01", "2024-03-31");

      assert.equal(report.unchanged, 1, "an identical re-run must be a no-op");
      assert.equal(report.inserted, 0);
      assert.equal(report.revised, 0);

      const { rows: after } = await client.query<{ observed_at: Date }>(
        `SELECT observed_at FROM bars_daily WHERE session_date = '2024-03-14'`,
      );
      // Bumping this would make an old bar look newly knowable, and a backtest
      // standing in the past would go blind to data it genuinely had.
      assert.equal(
        after[0]!.observed_at.getTime(),
        before[0]!.observed_at.getTime(),
        "observed_at must be the FIRST observation, not the latest run",
      );
    } finally {
      client.release();
    }
  });

  it("treats changed values as a revision and bumps observed_at", async () => {
    const client = await pool.connect();
    try {
      const { rows: before } = await client.query<{ observed_at: Date }>(
        `SELECT observed_at FROM bars_daily WHERE session_date = '2024-03-14'`,
      );

      const provider = new FakeProvider([bar({ close: 104.25, volume: 1_050_000 })]);
      const report = await ingestDailyBars(client, provider, ["TESTX"], "2024-03-01", "2024-03-31");

      assert.equal(report.revised, 1);

      const { rows: after } = await client.query<{ observed_at: Date; close: string }>(
        `SELECT observed_at, close FROM bars_daily WHERE session_date = '2024-03-14'`,
      );
      assert.equal(Number(after[0]!.close), 104.25);
      assert.ok(
        after[0]!.observed_at.getTime() > before[0]!.observed_at.getTime(),
        "a corrected figure genuinely was not knowable until it was published",
      );
    } finally {
      client.release();
    }
  });

  it("rejects bad ticks without aborting the batch", async () => {
    const client = await pool.connect();
    try {
      const provider = new FakeProvider([
        bar({ sessionDate: "2024-03-18", high: 1, low: 500 }), // impossible
        bar({ sessionDate: "2024-03-19", high: 109, close: 108 }), // fine
      ]);
      const report = await ingestDailyBars(client, provider, ["TESTX"], "2024-03-01", "2024-03-31");

      assert.equal(report.rejected.length, 1);
      assert.equal(report.inserted, 1, "one bad tick must not discard the good ones");
      assert.ok(report.rejected[0]!.problems.includes("high below low"));
    } finally {
      client.release();
    }
  });

  it("provisions partitions across a year boundary", async () => {
    const client = await pool.connect();
    try {
      const provider = new FakeProvider([
        bar({ sessionDate: "2023-12-29" }),
        bar({ sessionDate: "2025-01-02" }),
      ]);
      const report = await ingestDailyBars(client, provider, ["TESTX"], "2023-12-01", "2025-01-31");
      assert.equal(report.inserted, 2, "a batch spanning years must not fail on a missing partition");

      const { rows } = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
         WHERE c.relname IN ('bars_daily_2023', 'bars_daily_2025')`,
      );
      assert.equal(rows.length, 2);
    } finally {
      client.release();
    }
  });

  it("feeds the PIT layer, which still hides bars from before they were observed", async () => {
    const client = await pool.connect();
    try {
      // The whole point of ingestion is to supply the PIT layer without
      // breaking it. An as-of BEFORE any ingestion must return nothing.
      const { rows: past } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pit_bars_daily(TIMESTAMPTZ '2024-01-01 00:00Z')`,
      );
      assert.equal(past[0]!.count, "0", "bars observed later must be invisible to an earlier as-of");

      const { rows: now } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pit_bars_daily(now())`,
      );
      assert.ok(Number(now[0]!.count) > 0, "and visible once the as-of catches up");
    } finally {
      client.release();
    }
  });
});
