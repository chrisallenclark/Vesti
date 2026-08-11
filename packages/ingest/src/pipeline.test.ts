/**
 * The ingestion pipeline, end to end, against a real database.
 *
 * The unit tests upstream prove the generator produces coherent bars and that
 * its ground truth is internally consistent. This proves something different
 * and more valuable: that data written through the *actual* ingestion code and
 * read back through the *actual* SQL point-in-time layer reconstructs a series
 * whose correct answer was known before the test ran.
 *
 * Two failures this catches that nothing else does:
 *
 *   - An adjustment applied in the wrong direction, or off by one session. The
 *     result still looks like a plausible price series; only comparison against
 *     known truth exposes it.
 *   - A backtest allowed to see a split before it was announced. That makes
 *     historical prices line up beautifully and every strategy look better than
 *     it is, which is exactly why nobody notices it.
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
import { generateSeries, type SyntheticSpec } from "@vesti/core/sim/generator.ts";
import { ingestDailyBars } from "./bars.ts";
import { ingestCorporateActions } from "./actions.ts";
import { SyntheticProvider } from "./synthetic.ts";

const execFileAsync = promisify(execFile);
const DB_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
// Its own database, not the one bars.test.ts uses: the test runner executes
// files in parallel, and two suites racing to DROP and CREATE the same database
// deadlock rather than fail.
const TEST_DB = process.env.VESTI_PIPELINE_TEST_DB ?? "vesti_pipeline_test";
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_URL = testUrl.toString();

const SYMBOL = "SPLT";
const START = "2020-01-02";
const SEED = "pipeline-test";

/** Two splits and a dividend, so the adjustment has to compound rather than divide once. */
const SPEC: Omit<SyntheticSpec, "symbol" | "seed"> = {
  startDate: START,
  startPrice: 240,
  regimes: [
    { kind: "trend_up", sessions: 140 },
    { kind: "choppy", sessions: 60 },
    { kind: "trend_up", sessions: 100 },
  ],
  splits: [
    { atSession: 90, ratio: 4, announceLeadSessions: 20 },
    { atSession: 210, ratio: 2, announceLeadSessions: 12 },
  ],
  dividends: [{ atSession: 150, amount: 0.35, announceLeadSessions: 25 }],
};

const truthSeries = generateSeries({ symbol: SYMBOL, seed: SEED, ...SPEC });
const LAST_SESSION = truthSeries.bars.at(-1)!.sessionDate;

let pool: pg.Pool;
let client: pg.PoolClient;
let db: pg.Client;

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

  // Ingestion runs as vesti_research: it can write market data and evidence, and
  // has no path to orders, fills, or lots. If the pipeline ever needed trading
  // authority to do its job, this connection would fail rather than quietly
  // being granted it.
  const researchUrl = new URL(TEST_URL);
  researchUrl.username = "vesti_research";
  researchUrl.password = process.env.VESTI_RESEARCH_PASSWORD ?? "";

  pool = new pg.Pool({ connectionString: researchUrl.toString(), max: 2 });
  client = await pool.connect();
  db = new pg.Client({ connectionString: TEST_URL });
  await db.connect();
});

after(async () => {
  client?.release();
  await pool?.end();
  await db?.end();
});

describe("synthetic ingestion", () => {
  const provider = new SyntheticProvider({
    seed: SEED,
    profiles: { [SYMBOL]: SPEC },
  });

  it("writes every generated bar without rejecting one", async () => {
    const report = await ingestDailyBars(client, provider, [SYMBOL], START, LAST_SESSION);
    assert.equal(report.requested, truthSeries.bars.length);
    assert.deepEqual(report.rejected, [], "generated bars must satisfy the ingestion validator");
    assert.equal(report.inserted, truthSeries.bars.length);
    assert.equal(report.revised, 0);
  });

  it("writes the corporate actions with their real announcement times", async () => {
    const report = await ingestCorporateActions(client, provider, [SYMBOL], START, LAST_SESSION);
    assert.deepEqual(report.rejected, []);
    assert.equal(report.inserted, 3, "two splits and one dividend");

    const { rows } = await db.query<{ kind: string; ex_date: Date; announced_at: Date }>(
      `SELECT kind, ex_date, announced_at FROM corporate_actions ORDER BY ex_date`,
    );
    for (const row of rows) {
      assert.ok(row.announced_at < row.ex_date, `${row.kind} announced on or after its ex-date`);
    }
  });

  it("treats an identical re-run as a no-op", async () => {
    // observed_at must not move on a re-run: a bar that becomes "newly knowable"
    // every night is invisible to any backtest standing before tonight.
    const { rows: before } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM bars_daily WHERE observed_at > now() - interval '1 second'`,
    );
    const bars = await ingestDailyBars(client, provider, [SYMBOL], START, LAST_SESSION);
    const actions = await ingestCorporateActions(client, provider, [SYMBOL], START, LAST_SESSION);

    assert.equal(bars.inserted, 0);
    assert.equal(bars.revised, 0);
    assert.equal(bars.unchanged, truthSeries.bars.length);
    assert.equal(actions.inserted, 0);
    assert.equal(actions.unchanged, 3);
    void before;
  });

  it("tags every bar as synthetic so it can never pass for a real print", async () => {
    const { rows } = await db.query<{ tape: string; n: string }>(
      `SELECT tape, count(*) AS n FROM bars_daily GROUP BY tape`,
    );
    assert.deepEqual(
      rows.map((r) => r.tape),
      ["synthetic"],
    );
  });
});

describe("point-in-time reconstruction against known truth", () => {
  it("recovers the true continuous price series from raw bars", async () => {
    const asOf = `${LAST_SESSION}T23:59:59Z`;
    const { rows } = await db.query<{ session_date: Date; close: string; split_factor: string }>(
      `SELECT session_date, close, split_factor
       FROM pit_bars_daily($1::timestamptz)
       ORDER BY session_date`,
      [asOf],
    );
    assert.equal(rows.length, truthSeries.bars.length);

    const totalSplitFactor = truthSeries.corporateActions
      .filter((a) => a.kind === "split")
      .reduce((acc, a) => acc * (a.splitRatio as number), 1);
    assert.equal(totalSplitFactor, 8);

    let worst = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const truth = truthSeries.truth[i]!;
      assert.equal(
        row.session_date.toISOString().slice(0, 10),
        truth.sessionDate,
        "PIT rows must line up session-for-session with the generated series",
      );
      // Backward adjustment divides each bar by the splits still ahead of it,
      // which leaves the whole series equal to the continuous price scaled by
      // one constant — the product of every split. Multiplying that back out
      // must land on the truth the generator recorded before any of this ran.
      const reconstructed = Number(row.close) * totalSplitFactor;
      const error = Math.abs(reconstructed - truth.continuousClose);
      // The only permissible error is the cent the vendor rounds the print to,
      // magnified by whatever split divisor was in force that day.
      const tolerance = 0.005 * truth.splitDivisor + 1e-6;
      worst = Math.max(worst, error / truth.continuousClose);
      assert.ok(
        error <= tolerance,
        `${truth.sessionDate}: reconstructed ${reconstructed} vs truth ${truth.continuousClose}`,
      );
    }
    // Half a cent on a ~$45 post-split print is about 1.1e-4 in relative terms,
    // and that rounding floor is the only error the reconstruction is allowed to
    // have. Anything structurally wrong with the adjustment would land orders of
    // magnitude above this.
    assert.ok(worst < 2.5e-4, `worst relative reconstruction error ${worst}`);
  });

  it("refuses to adjust with a split the market had not been told about", async () => {
    const firstSplit = truthSeries.corporateActions.find((a) => a.kind === "split")!;
    const beforeAnnouncement = new Date(Date.parse(firstSplit.announcedAt) - 3600_000).toISOString();
    const probeDate = truthSeries.bars[10]!.sessionDate;

    const { rows: blind } = await db.query<{ close: string; split_factor: string }>(
      `SELECT close, split_factor FROM pit_bars_daily($1::timestamptz, NULL, $2::date, $2::date)`,
      [beforeAnnouncement, probeDate],
    );
    assert.equal(blind.length, 1);
    assert.equal(
      Number(blind[0]!.split_factor),
      1,
      "a bar seen before the split was announced must not be adjusted for it",
    );
    assert.equal(
      Number(blind[0]!.close),
      truthSeries.bars[10]!.close,
      "it must equal the raw print a trader actually saw that day",
    );

    // The same bar, read after the announcement, IS adjusted — proving the
    // difference comes from announcement timing and not from the bar itself.
    const afterAnnouncement = new Date(Date.parse(firstSplit.announcedAt) + 3600_000).toISOString();
    const { rows: informed } = await db.query<{ close: string; split_factor: string }>(
      `SELECT close, split_factor FROM pit_bars_daily($1::timestamptz, NULL, $2::date, $2::date)`,
      [afterAnnouncement, probeDate],
    );
    assert.equal(Number(informed[0]!.split_factor), 4);
    assert.ok(Number(informed[0]!.close) < Number(blind[0]!.close) / 3.9);
  });

  it("cannot see a bar dated after the as-of instant", async () => {
    const midpoint = truthSeries.bars[100]!.sessionDate;
    const { rows } = await db.query<{ n: string; latest: Date }>(
      `SELECT count(*) AS n, max(session_date) AS latest FROM pit_bars_daily($1::timestamptz)`,
      [`${midpoint}T23:59:59Z`],
    );
    assert.equal(rows[0]!.latest.toISOString().slice(0, 10), midpoint);
    assert.equal(Number(rows[0]!.n), 101);
  });
});
