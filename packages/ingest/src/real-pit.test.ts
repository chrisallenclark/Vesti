/**
 * The point-in-time layer against real corporate actions.
 *
 * `pipeline.test.ts` proves the same property against generated data, where the
 * correct answer is known because we wrote it. That test can only fail if our
 * code is wrong about our own fiction. This one fails if our code is wrong about
 * the market — a split ratio parsed upside down, an ex-date off by one session,
 * an adjustment that divides once where it should compound.
 *
 * The oracle is Alpaca's own split-adjusted series, fetched separately and
 * deliberately NOT through `AlpacaProvider`: the production path requests
 * `adjustment=raw` and nothing above it may ever see an adjusted print, so the
 * comparison series is pulled by a small independent fetcher written here. Two
 * implementations that disagree are informative; one implementation compared
 * against itself is not.
 *
 * What that oracle actually settles: given raw OHLCV and a table of corporate
 * actions, our SQL must arrive at the same continuous series a vendor arrives at
 * by its own route. It closes the failure mode the synthetic test structurally
 * cannot — that our generator and our adjustment share a misconception.
 *
 * Needs the network and a live key. Skips cleanly without one, so the offline
 * suite stays green and nobody is tempted to make the property optional.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { AlpacaProvider } from "./alpaca.ts";
import { ingestDailyBars } from "./bars.ts";
import { ingestCorporateActions } from "./actions.ts";

const execFileAsync = promisify(execFile);
const DB_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db");

const KEY_ID = process.env.ALPACA_API_KEY_ID;
const SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;
const DATA_BASE_URL = process.env.ALPACA_DATA_BASE_URL ?? "https://data.alpaca.markets";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
// Its own database. The suites run in parallel and two of them racing to DROP
// and CREATE the same name deadlock rather than fail.
const TEST_DB = process.env.VESTI_REAL_PIT_TEST_DB ?? "vesti_real_pit_test";
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_URL = testUrl.toString();

/**
 * Alpaca's IEX archive begins 2020-07-27, so the window starts just after it.
 * That is a real ceiling on this tier, not a choice: the free feed has no
 * earlier daily history to serve.
 */
const FROM = "2020-08-03";
/**
 * Ends at the last SETTLED session, never today.
 *
 * A bar for a session still in progress is not a fact yet — it is a running
 * total. Our snapshot and the oracle's are taken seconds apart, and in a live
 * market those seconds are enough to disagree by a cent on the close, which
 * would make this suite fail intermittently for a reason that has nothing to do
 * with point-in-time correctness. Excluding the open session is not weakening
 * the check; it is declining to compare two readings of a number that is still
 * moving.
 */
const TO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Every split here actually happened, and each is in the set for a reason.
 *
 * NVDA and TSLA split TWICE inside the window, which is the case that separates
 * a correct implementation from one that merely looks correct: a bar before both
 * splits must be divided by their PRODUCT. Code that divides by the nearest
 * split, or by the largest, passes on every single-split name and fails here.
 *
 * AMZN's 20:1 is the magnitude check — an error that a 4:1 hides inside a
 * plausible-looking price, a 20:1 does not.
 */
const EXPECTED_SPLITS: ReadonlyArray<{ symbol: string; exDate: string; ratio: number }> = [
  { symbol: "AAPL", exDate: "2020-08-31", ratio: 4 },
  { symbol: "TSLA", exDate: "2020-08-31", ratio: 5 },
  { symbol: "NVDA", exDate: "2021-07-20", ratio: 4 },
  { symbol: "AMZN", exDate: "2022-06-06", ratio: 20 },
  { symbol: "TSLA", exDate: "2022-08-25", ratio: 3 },
  { symbol: "NVDA", exDate: "2024-06-10", ratio: 10 },
];

const SYMBOLS = [...new Set(EXPECTED_SPLITS.map((s) => s.symbol))].sort();

interface VendorBar {
  sessionDate: string;
  close: number;
}

/**
 * The oracle: the vendor's own split-adjusted closes.
 *
 * Written out longhand rather than reusing `AlpacaProvider` so that a bug in the
 * provider cannot cancel itself out on both sides of the comparison. Paginates,
 * because a truncated oracle silently narrows the property being asserted to
 * whatever fits in one page.
 */
async function fetchVendorAdjustedCloses(
  symbols: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, VendorBar[]>> {
  const bySymbol = new Map<string, VendorBar[]>();
  let pageToken: string | null | undefined;

  do {
    const url = new URL("/v2/stocks/bars", DATA_BASE_URL);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", from);
    url.searchParams.set("end", to);
    url.searchParams.set("limit", "10000");
    url.searchParams.set("feed", "iex");
    url.searchParams.set("adjustment", "split");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": KEY_ID as string,
        "APCA-API-SECRET-KEY": SECRET_KEY as string,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`oracle fetch failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      bars?: Record<string, Array<{ t: string; c: number }>>;
      next_page_token?: string | null;
    };
    for (const [symbol, bars] of Object.entries(payload.bars ?? {})) {
      const list = bySymbol.get(symbol) ?? [];
      for (const bar of bars) list.push({ sessionDate: bar.t.slice(0, 10), close: bar.c });
      bySymbol.set(symbol, list);
    }
    pageToken = payload.next_page_token;
  } while (pageToken);

  for (const bars of bySymbol.values()) bars.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return bySymbol;
}

const HAVE_KEYS = Boolean(KEY_ID && SECRET_KEY);

let pool: pg.Pool;
let client: pg.PoolClient;
let db: pg.Client;
let vendorAdjusted: Map<string, VendorBar[]>;
let securityIds: Map<string, string>;

before(async () => {
  if (!HAVE_KEYS) return;

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  await execFileAsync("npx", ["tsx", "src/migrate.ts", "up"], {
    cwd: DB_PACKAGE,
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });

  // As vesti_research, exactly as the real job runs. Ingestion that needed
  // trading authority to do its job would fail here rather than quietly being
  // granted it.
  const researchUrl = new URL(TEST_URL);
  researchUrl.username = "vesti_research";
  researchUrl.password = process.env.VESTI_RESEARCH_PASSWORD ?? "";
  pool = new pg.Pool({ connectionString: researchUrl.toString(), max: 2 });
  client = await pool.connect();
  db = new pg.Client({ connectionString: TEST_URL });
  await db.connect();

  const provider = new AlpacaProvider({
    keyId: KEY_ID as string,
    secretKey: SECRET_KEY as string,
    baseUrl: DATA_BASE_URL,
  });

  const barReport = await ingestDailyBars(client, provider, SYMBOLS, FROM, TO);
  assert.deepEqual(barReport.rejected, [], "real vendor bars must satisfy the ingestion validator");
  assert.ok(barReport.inserted > 1000, `expected a real history, got ${barReport.inserted} bars`);

  const actionReport = await ingestCorporateActions(client, provider, SYMBOLS, FROM, TO);
  assert.deepEqual(actionReport.rejected, [], "no real corporate action may be dropped");

  vendorAdjusted = await fetchVendorAdjustedCloses(SYMBOLS, FROM, TO);

  const { rows } = await db.query<{ id: string; symbol: string }>(
    `SELECT id, symbol FROM securities`,
  );
  securityIds = new Map(rows.map((r) => [r.symbol, r.id]));
});

after(async () => {
  client?.release();
  await pool?.end();
  await db?.end();
});

describe("real corporate actions", { skip: HAVE_KEYS ? false : "ALPACA_API_KEY_ID is unset" }, () => {
  it("ingests every known split with the ratio that actually occurred", async () => {
    const { rows } = await db.query<{
      symbol: string;
      ex_date: Date;
      split_ratio: string;
      announced_at: Date;
    }>(
      `SELECT s.symbol, ca.ex_date, ca.split_ratio, ca.announced_at
       FROM corporate_actions ca JOIN securities s ON s.id = ca.security_id
       WHERE ca.kind = 'split' ORDER BY ca.ex_date, s.symbol`,
    );

    for (const expected of EXPECTED_SPLITS) {
      const found = rows.find(
        (r) => r.symbol === expected.symbol && r.ex_date.toISOString().slice(0, 10) === expected.exDate,
      );
      assert.ok(found, `${expected.symbol} ${expected.exDate} split missing from corporate_actions`);
      assert.equal(
        Number(found.split_ratio),
        expected.ratio,
        `${expected.symbol} ${expected.exDate} ratio`,
      );
    }
  });

  it("dates every split as knowable strictly before it took effect", async () => {
    // Alpaca publishes no declaration date, so the ingest derives the tightest
    // defensible bound from the dates it does publish. That bound must land
    // before the ex-date: a split first "knowable" on the morning it takes
    // effect leaves every backtest in the announcement window reading a price
    // series no trader ever saw.
    const { rows } = await db.query<{ symbol: string; ex_date: Date; announced_at: Date }>(
      `SELECT s.symbol, ca.ex_date, ca.announced_at
       FROM corporate_actions ca JOIN securities s ON s.id = ca.security_id
       WHERE ca.kind = 'split'`,
    );
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(
        row.announced_at < row.ex_date,
        `${row.symbol} split announced ${row.announced_at.toISOString()} on/after ex-date ${row.ex_date.toISOString()}`,
      );
    }
  });

  it("stores raw prints, so the split-day discontinuity is still there", async () => {
    // The clearest evidence that no adjustment was baked in at write time: the
    // stored series must still fall off a cliff on each ex-date, by very nearly
    // the split ratio. If ingestion had quietly stored an adjusted series, this
    // ratio would be ~1 and every later assertion would pass for the wrong
    // reason.
    for (const split of EXPECTED_SPLITS) {
      const securityId = securityIds.get(split.symbol);
      const { rows } = await db.query<{ session_date: Date; close: string; open: string }>(
        `(SELECT session_date, close, open FROM bars_daily
            WHERE security_id = $1 AND session_date < $2::date
            ORDER BY session_date DESC LIMIT 1)
         UNION ALL
         (SELECT session_date, close, open FROM bars_daily
            WHERE security_id = $1 AND session_date >= $2::date
            ORDER BY session_date ASC LIMIT 1)`,
        [securityId, split.exDate],
      );
      assert.equal(rows.length, 2, `${split.symbol}: need a bar either side of ${split.exDate}`);

      const priorClose = Number(rows[0]!.close);
      const exOpen = Number(rows[1]!.open);
      const observed = priorClose / exOpen;
      // Overnight moves are a few percent; the split is a multiple. A 25%
      // window separates them with room to spare and would still catch a ratio
      // inverted, off by one session, or applied to the wrong name.
      assert.ok(
        Math.abs(observed / split.ratio - 1) < 0.25,
        `${split.symbol} ${split.exDate}: raw close ${priorClose} / ex-open ${exOpen} = ${observed.toFixed(2)}, expected ~${split.ratio}`,
      );
    }
  });
});

describe(
  "point-in-time reconstruction against the vendor's own adjusted series",
  { skip: HAVE_KEYS ? false : "ALPACA_API_KEY_ID is unset" },
  () => {
    it("reproduces the vendor's continuous price for every session of every name", async () => {
      const asOf = `${TO}T23:59:59Z`;
      let compared = 0;
      let worstAbsolute = 0;
      let worstRelative = 0;
      // Collected rather than thrown on first sight. One mismatched session and
      // four hundred are different diagnoses — a stray vendor row versus an
      // adjustment applied to the wrong side of an ex-date — and an assertion
      // that stops at the first cannot tell them apart.
      const mismatches: string[] = [];

      for (const symbol of SYMBOLS) {
        const securityId = securityIds.get(symbol);
        assert.ok(securityId, `${symbol} missing from securities`);

        const { rows } = await db.query<{ session_date: Date; close: string; split_factor: string }>(
          `SELECT session_date, close, split_factor
           FROM pit_bars_daily($1::timestamptz, $2::uuid)
           ORDER BY session_date`,
          [asOf, securityId],
        );
        const vendor = vendorAdjusted.get(symbol) ?? [];
        assert.ok(rows.length > 0, `${symbol}: no PIT rows`);

        const vendorByDate = new Map(vendor.map((b) => [b.sessionDate, b.close]));
        for (const row of rows) {
          const date = row.session_date.toISOString().slice(0, 10);
          const truth = vendorByDate.get(date);
          // The vendor is the oracle: every session we hold, it must hold too.
          // A row we have and it does not is a bar we invented or misdated.
          assert.ok(truth !== undefined, `${symbol} ${date}: no vendor bar to check against`);

          const ours = Number(row.close);
          const error = Math.abs(ours - truth);
          // The vendor rounds its adjusted print to the cent. That rounding is
          // the ONLY discrepancy permitted; a wrong factor lands orders of
          // magnitude outside it.
          if (error > 0.005 + 1e-6) {
            mismatches.push(
              `${symbol} ${date}: ours ${ours} vs vendor ${truth} (factor ${row.split_factor})`,
            );
          }
          worstAbsolute = Math.max(worstAbsolute, error);
          if (truth > 0) worstRelative = Math.max(worstRelative, error / truth);
          compared += 1;
        }
      }

      assert.deepEqual(
        mismatches.slice(0, 10),
        [],
        `${mismatches.length} of ${compared} sessions disagree with the vendor`,
      );
      assert.ok(compared > 5000, `expected thousands of comparisons, made ${compared}`);
      assert.ok(worstAbsolute <= 0.005 + 1e-6, `worst absolute error ${worstAbsolute}`);
      assert.ok(worstRelative < 1e-3, `worst relative error ${worstRelative}`);
    });

    it("compounds two splits on one name rather than applying the nearer one", async () => {
      // NVDA split 4:1 in 2021 and 10:1 in 2024. A bar before both must carry a
      // factor of 40 — not 4, not 10, not 14. This is the single assertion the
      // synthetic suite and this one most need to agree on, because getting it
      // wrong still yields a smooth, plausible, entirely fictional series.
      const securityId = securityIds.get("NVDA");
      const asOf = new Date().toISOString();
      const { rows } = await db.query<{ session_date: Date; split_factor: string }>(
        `SELECT session_date, split_factor
         FROM pit_bars_daily($1::timestamptz, $2::uuid, $3::date, $4::date)
         ORDER BY session_date`,
        [asOf, securityId, "2021-07-16", "2024-06-11"],
      );

      const factorOn = (date: string): number => {
        const row = rows.find((r) => r.session_date.toISOString().slice(0, 10) === date);
        assert.ok(row, `no NVDA bar on ${date}`);
        return Number(row.split_factor);
      };

      assert.equal(factorOn("2021-07-16"), 40, "before both splits: 4 x 10");
      assert.equal(factorOn("2021-07-20"), 10, "on the first ex-date, only the 2024 split is ahead");
      assert.equal(factorOn("2024-06-11"), 1, "after both, nothing left to adjust for");
    });

    it("will not adjust a bar with a split the market had not been told about", async () => {
      // AAPL's 4:1 became knowable, on the tightest bound the vendor's own dates
      // support, on 2020-08-24. The same stored bar must read as $499 to a
      // backtest standing before that and as ~$125 to one standing after — with
      // nothing about the bar itself having changed.
      const securityId = securityIds.get("AAPL");
      const probe = "2020-08-20";

      const { rows: blind } = await db.query<{ close: string; split_factor: string }>(
        `SELECT close, split_factor FROM pit_bars_daily($1::timestamptz, $2::uuid, $3::date, $3::date)`,
        ["2020-08-21T00:00:00Z", securityId, probe],
      );
      assert.equal(blind.length, 1);
      assert.equal(Number(blind[0]!.split_factor), 1, "unannounced split must not adjust anything");

      const { rows: raw } = await db.query<{ close: string }>(
        `SELECT close FROM bars_daily WHERE security_id = $1 AND session_date = $2::date`,
        [securityId, probe],
      );
      assert.equal(
        Number(blind[0]!.close),
        Number(raw[0]!.close),
        "before the announcement, the PIT close must be the raw print a trader saw",
      );
      // A four-figure Apple share price is what the tape actually showed that
      // week. If this ever reads ~$125 the adjustment has leaked backwards.
      assert.ok(Number(blind[0]!.close) > 400, `expected a pre-split print, got ${blind[0]!.close}`);

      const { rows: informed } = await db.query<{ close: string; split_factor: string }>(
        `SELECT close, split_factor FROM pit_bars_daily($1::timestamptz, $2::uuid, $3::date, $3::date)`,
        ["2020-08-25T00:00:00Z", securityId, probe],
      );
      assert.equal(Number(informed[0]!.split_factor), 4, "announced split must adjust the same bar");
      assert.equal(
        Number(informed[0]!.close),
        Number(blind[0]!.close) / 4,
        "the only difference between the two readings is the announcement",
      );
    });

    it("cannot see a bar dated after the as-of instant", async () => {
      const securityId = securityIds.get("AAPL");
      const { rows } = await db.query<{ n: string; latest: Date }>(
        `SELECT count(*) AS n, max(session_date) AS latest
         FROM pit_bars_daily($1::timestamptz, $2::uuid)`,
        ["2021-06-30T23:59:59Z", securityId],
      );
      assert.ok(
        rows[0]!.latest.toISOString().slice(0, 10) <= "2021-06-30",
        `leaked a bar dated ${rows[0]!.latest.toISOString()}`,
      );
      assert.ok(Number(rows[0]!.n) > 100, "expected real history before the as-of date");
    });
  },
);
