/**
 * Phase 0 exit criteria, as executable assertions.
 *
 * Everything here protects an invariant that is expensive or impossible to fix
 * later:
 *
 *   - Look-ahead bias silently inflates every backtest that follows.
 *   - A research component that can write orders is a trading-authority breach.
 *   - Mutable history makes post-mortems worthless, because the record adapts
 *     to the outcome.
 *   - Cross-mandate exits sell the wrong shares — real money, silently wrong.
 *
 * Run against a scratch database:  npm run test -w @vesti/db
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const TEST_DB = process.env.VESTI_TEST_DB ?? "vesti_test";
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_URL = testUrl.toString();

let db: pg.Client;

/** Asserts that a statement fails, and that the message explains why. */
async function assertRejects(
  client: pg.Client,
  sql: string,
  expectedFragment: string,
  params: unknown[] = [],
): Promise<void> {
  try {
    await client.query(sql, params);
    assert.fail(`Expected rejection matching "${expectedFragment}" but the statement succeeded.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      message.toLowerCase().includes(expectedFragment.toLowerCase()),
      `Expected error mentioning "${expectedFragment}", got: ${message}`,
    );
  }
}

async function roleClient(role: string, password: string): Promise<pg.Client> {
  const url = new URL(TEST_URL);
  url.username = role;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

before(async () => {
  // Fresh database each run, so a passing suite means the migrations produce
  // these guarantees from nothing — not that a hand-patched database happens to.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  await execFileAsync("npx", ["tsx", "src/migrate.ts", "up"], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });

  db = new pg.Client({ connectionString: TEST_URL });
  await db.connect();
});

after(async () => {
  await db?.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("point-in-time layer", () => {
  let securityId: string;

  before(async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO securities (symbol, name, listed_at, source_id)
       SELECT 'PITX', 'PIT Test', DATE '2019-01-01', id FROM sources WHERE slug = 'manual'
       RETURNING id`,
    );
    securityId = rows[0]!.id;

    // A 2-for-1 split announced 2020-06-01, effective 2020-06-15.
    await db.query(
      `INSERT INTO corporate_actions
         (security_id, kind, ex_date, announced_at, split_ratio, source_id)
       SELECT $1, 'split', DATE '2020-06-15', TIMESTAMPTZ '2020-06-01 00:00Z', 2.0, id
       FROM sources WHERE slug = 'manual'`,
      [securityId],
    );

    await db.query(`SELECT vesti_ensure_daily_partition(2020)`);
    await db.query(
      `INSERT INTO bars_daily
         (security_id, session_date, open, high, low, close, volume, tape, source_id, observed_at)
       SELECT $1, v.d::date, 100, 100, 100, 100, 1000, 'iex', s.id, v.d::timestamptz
       FROM sources s, (VALUES ('2020-05-20')) AS v(d)
       WHERE s.slug = 'manual'`,
      [securityId],
    );
    await db.query(
      `INSERT INTO bars_daily
         (security_id, session_date, open, high, low, close, volume, tape, source_id, observed_at)
       SELECT $1, DATE '2020-06-20', 50, 50, 50, 50, 2000, 'iex', s.id, TIMESTAMPTZ '2020-06-20'
       FROM sources s WHERE s.slug = 'manual'`,
      [securityId],
    );
  });

  it("does not adjust prices using a split the market had not been told about", async () => {
    const { rows } = await db.query<{ close: string; split_factor: string }>(
      `SELECT close, split_factor FROM pit_bars_daily(TIMESTAMPTZ '2020-05-25 00:00Z')`,
    );
    assert.equal(rows.length, 1, "only the May bar existed on 2020-05-25");
    assert.equal(Number(rows[0]!.close), 100, "price must be raw before the split is announced");
    assert.equal(Number(rows[0]!.split_factor), 1);
  });

  it("back-adjusts once the split has been announced", async () => {
    const { rows } = await db.query<{ session_date: Date; close: string; volume: string }>(
      `SELECT session_date, close, volume FROM pit_bars_daily(TIMESTAMPTZ '2020-07-01 00:00Z')
       ORDER BY session_date`,
    );
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0]!.close), 50, "pre-split bar halves");
    assert.equal(Number(rows[0]!.volume), 2000, "pre-split volume doubles");
    assert.equal(Number(rows[1]!.close), 50, "post-split bar is unchanged");
  });

  it("hides bars dated after the as-of instant", async () => {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*) FROM pit_bars_daily(TIMESTAMPTZ '2020-05-25 00:00Z')`,
    );
    assert.equal(Number(rows[0]!.count), 1, "the June bar is the future on 2020-05-25");
  });

  it("keeps delisted securities in the universe on dates they were listed", async () => {
    await db.query(
      `INSERT INTO securities (symbol, name, listed_at, delisted_at, source_id)
       SELECT 'DEAD', 'Delisted Co', DATE '2018-01-01', DATE '2021-01-01', id
       FROM sources WHERE slug = 'manual'`,
    );
    const listed = await db.query<{ count: string }>(
      `SELECT count(*) FROM pit_universe(DATE '2020-06-01') WHERE symbol = 'DEAD'`,
    );
    const after = await db.query<{ count: string }>(
      `SELECT count(*) FROM pit_universe(DATE '2022-06-01') WHERE symbol = 'DEAD'`,
    );
    assert.equal(Number(listed.rows[0]!.count), 1, "survivorship bias: must appear while listed");
    assert.equal(Number(after.rows[0]!.count), 0, "must not appear after delisting");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("role isolation", () => {
  it("denies the backtest role every base fact table", async () => {
    const client = await roleClient("vesti_backtest", process.env.VESTI_BACKTEST_PASSWORD!);
    try {
      for (const table of ["bars_daily", "bars_intraday", "securities", "corporate_actions"]) {
        await assertRejects(client, `SELECT count(*) FROM ${table}`, "permission denied");
      }
    } finally {
      await client.end();
    }
  });

  it("allows the backtest role through the PIT functions", async () => {
    const client = await roleClient("vesti_backtest", process.env.VESTI_BACKTEST_PASSWORD!);
    try {
      const { rows } = await client.query(`SELECT count(*) FROM pit_bars_daily(now())`);
      assert.ok(rows.length === 1, "PIT access is the only permitted route, and it works");
    } finally {
      await client.end();
    }
  });

  it("denies the research role any write to orders, fills, or lots", async () => {
    const client = await roleClient("vesti_research", process.env.VESTI_RESEARCH_PASSWORD!);
    try {
      await assertRejects(
        client,
        `INSERT INTO orders (account_id, mandate_id, security_id, side, kind, quantity)
         VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'buy', 'market', 1)`,
        "permission denied",
      );
      await assertRejects(client, `DELETE FROM lots`, "permission denied");
    } finally {
      await client.end();
    }
  });

  it("denies the app role any write to orders", async () => {
    const client = await roleClient("vesti_app", process.env.VESTI_APP_PASSWORD!);
    try {
      await assertRejects(
        client,
        `INSERT INTO orders (account_id, mandate_id, security_id, side, kind, quantity)
         VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'buy', 'market', 1)`,
        "permission denied",
      );
    } finally {
      await client.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("append-only history", () => {
  const tables = [
    "audit_log",
    "risk_evaluations",
    "pre_trade_records",
    "decision_snapshots",
    "strategy_versions",
    "setup_versions",
    "fills",
  ];

  for (const table of tables) {
    it(`rejects UPDATE and DELETE on ${table}`, async () => {
      // Resolve a real column per table rather than assuming `id`: audit_log is
      // keyed on `seq`, and an unresolvable column errors at parse time, which
      // would make this assertion pass without the trigger ever firing.
      const { rows } = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position LIMIT 1`,
        [table],
      );
      const column = rows[0]?.column_name;
      assert.ok(column, `${table} should exist and have at least one column`);

      await assertRejects(db, `UPDATE ${table} SET ${column} = ${column}`, "append-only");
      await assertRejects(db, `DELETE FROM ${table}`, "append-only");
    });
  }

  it("detects tampering with the audit chain", async () => {
    await db.query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, payload)
       VALUES ('system:test', 'a', 'order', '1', '{"v":1}'),
              ('system:test', 'b', 'order', '1', '{"v":2}')`,
    );
    const intact = await db.query(`SELECT * FROM vesti_verify_audit_chain()`);
    assert.equal(intact.rows.length, 0, "a freshly written chain must verify");

    // The append-only trigger blocks normal mutation, so tamper the way a real
    // attacker with table ownership would — bypassing the trigger entirely.
    await db.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
    await db.query(`UPDATE audit_log SET payload = '{"v":999}'::jsonb WHERE seq = 1`);
    await db.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);

    const broken = await db.query<{ broken_at: string; reason: string }>(
      `SELECT * FROM vesti_verify_audit_chain()`,
    );
    assert.equal(broken.rows.length, 1, "tampering must be detected");
    assert.match(broken.rows[0]!.reason, /hash does not match/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("mandate isolation and the risk gate", () => {
  const ids = {
    user: "11111111-1111-1111-1111-111111111111",
    active: "22222222-2222-2222-2222-222222222222",
    longTerm: "33333333-3333-3333-3333-333333333333",
    account: "44444444-4444-4444-4444-444444444444",
    security: "55555555-5555-5555-5555-555555555555",
    longTermLot: "66666666-6666-6666-6666-666666666666",
    evaluation: "88888888-8888-8888-8888-888888888888",
    strategy: "99999999-9999-9999-9999-999999999999",
    strategyVersion: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  };

  before(async () => {
    await db.query(`INSERT INTO users (id, email) VALUES ($1, 'iso@example.com')`, [ids.user]);
    await db.query(
      `INSERT INTO mandates (id, user_id, kind, name) VALUES
         ($1, $3, 'active', 'Active'), ($2, $3, 'long_term', 'Long Term')`,
      [ids.active, ids.longTerm, ids.user],
    );
    await db.query(`INSERT INTO accounts (id, user_id, broker) VALUES ($1, $2, 'sim')`, [
      ids.account,
      ids.user,
    ]);
    await db.query(
      `INSERT INTO securities (id, symbol, name, source_id)
       SELECT $1, 'ISOX', 'Isolation Test', id FROM sources WHERE slug = 'manual'`,
      [ids.security],
    );
    // An open lot must name the strategy that owns it — see 014. A position
    // nobody owns is exited by nobody, which is a different way to lose track
    // of stock than the cross-mandate reach this suite is about, and just as
    // silent.
    await db.query(
      `INSERT INTO strategies (id, user_id, slug, name, mandate_kind)
       VALUES ($1, $2, 'iso.fixture', 'Isolation fixture', 'long_term')`,
      [ids.strategy, ids.user],
    );
    await db.query(
      `INSERT INTO strategy_versions (id, strategy_id, version, status, spec, authored_by, rationale)
       VALUES ($1, $2, 1, 'paper_approved', '{"code_version":"1"}'::jsonb, 'human', 'fixture')`,
      [ids.strategyVersion, ids.strategy],
    );
    // 100 shares held by the LONG-TERM mandate.
    await db.query(
      `INSERT INTO lots (id, account_id, mandate_id, security_id, opened_at, quantity, remaining,
                         cost_basis, strategy_version_id)
       VALUES ($1, $2, $3, $4, now(), 100, 100, 50.00, $5)`,
      [ids.longTermLot, ids.account, ids.longTerm, ids.security, ids.strategyVersion],
    );
    await db.query(
      `INSERT INTO risk_evaluations
         (id, account_id, mandate_id, security_id, side, requested_qty, approved_qty, decision, engine_version)
       VALUES ($1, $2, $3, $4, 'sell', 10, 5, 'reduce', 'risk@0.1.0')`,
      [ids.evaluation, ids.account, ids.active, ids.security],
    );
  });

  it("refuses an order that has no risk evaluation", async () => {
    await assertRejects(
      db,
      `INSERT INTO orders (account_id, mandate_id, security_id, side, kind, quantity, status)
       VALUES ($1, $2, $3, 'sell', 'market', 10, 'pending_new')`,
      "without a risk evaluation",
      [ids.account, ids.active, ids.security],
    );
  });

  it("refuses an order larger than the risk engine approved", async () => {
    await assertRejects(
      db,
      `INSERT INTO orders (account_id, mandate_id, security_id, side, kind, quantity, status, risk_evaluation_id)
       VALUES ($1, $2, $3, 'sell', 'market', 10, 'pending_new', $4)`,
      "exceeds risk-approved quantity",
      [ids.account, ids.active, ids.security, ids.evaluation],
    );
  });

  it("refuses an order whose evaluation was for a different mandate", async () => {
    await assertRejects(
      db,
      `INSERT INTO orders (account_id, mandate_id, security_id, side, kind, quantity, status, risk_evaluation_id)
       VALUES ($1, $2, $3, 'sell', 'market', 5, 'pending_new', $4)`,
      "does not match order",
      [ids.account, ids.longTerm, ids.security, ids.evaluation],
    );
  });

  it("admits an order within the approved quantity", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO orders (account_id, mandate_id, security_id, side, kind, quantity, status, risk_evaluation_id)
       VALUES ($1, $2, $3, 'sell', 'market', 5, 'pending_new', $4) RETURNING id`,
      [ids.account, ids.active, ids.security, ids.evaluation],
    );
    assert.ok(rows[0]!.id, "a properly risk-approved order must be admitted");
  });

  it("refuses to let an Active-mandate exit sell Long-Term shares", async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM orders WHERE mandate_id = $1 AND status = 'pending_new' LIMIT 1`,
      [ids.active],
    );
    await assertRejects(
      db,
      `INSERT INTO order_lot_allocations (order_id, lot_id, quantity) VALUES ($1, $2, 5)`,
      "mandate isolation violated",
      [rows[0]!.id, ids.longTermLot],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
describe("every open position has an owner", () => {
  // The failure this prevents took nine days to notice and was invisible from
  // every direction: two shares held at the broker, claimed by no lot with a
  // strategy, so no engine listed them, no flatten considered them, and no P&L
  // included them. They looked precisely like stock under management.
  const ids = {
    user: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    mandate: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    account: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    security: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  };

  before(async () => {
    await db.query(`INSERT INTO users (id, email) VALUES ($1, 'owner@example.com')`, [ids.user]);
    await db.query(`INSERT INTO mandates (id, user_id, kind, name) VALUES ($1, $2, 'active', 'A')`, [
      ids.mandate,
      ids.user,
    ]);
    await db.query(`INSERT INTO accounts (id, user_id, broker) VALUES ($1, $2, 'sim')`, [
      ids.account,
      ids.user,
    ]);
    await db.query(
      `INSERT INTO securities (id, symbol, name, source_id)
       SELECT $1, 'OWNX', 'Owner Test', id FROM sources WHERE slug = 'manual'`,
      [ids.security],
    );
  });

  it("refuses to open a lot that names no strategy", async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO lots (account_id, mandate_id, security_id, opened_at, quantity, remaining,
                           cost_basis)
         VALUES ($1, $2, $3, now(), 10, 10, 5.00)`,
        [ids.account, ids.mandate, ids.security],
      ),
      /lots_open_position_has_an_owner/,
      "an open position with no strategy is one nothing will ever exit",
    );
  });

  it("still allows a fully closed lot to carry none, because history is not rewritten", async () => {
    // Lots sold before the rule existed keep whatever attribution they had.
    // Forcing one on them would invent a fact rather than record one, and a
    // closed lot is answering no live question.
    await db.query(
      `INSERT INTO lots (account_id, mandate_id, security_id, opened_at, quantity, remaining,
                         cost_basis, closed_at)
       VALUES ($1, $2, $3, now(), 10, 0, 5.00, now())`,
      [ids.account, ids.mandate, ids.security],
    );
  });
});

describe("cost control and job queue", () => {
  it("prices model calls against published rates", async () => {
    const { rows } = await db.query<{ full: string; batched: string; cached: string }>(
      `SELECT vesti_ai_cost('claude-opus-5', 1000000, 1000000)               AS full,
              vesti_ai_cost('claude-opus-5', 1000000, 1000000, 0, 0, true)   AS batched,
              vesti_ai_cost('claude-opus-5', 0, 0, 1000000)                  AS cached`,
    );
    assert.equal(Number(rows[0]!.full), 30, "$5/MTok in + $25/MTok out");
    assert.equal(Number(rows[0]!.batched), 15, "Batch API is 50% off");
    assert.equal(Number(rows[0]!.cached), 0.5, "cache reads are ~0.1x input");
  });

  it("blocks dispatch once the daily budget is spent", async () => {
    await db.query(`INSERT INTO ai_budgets (daily_usd, monthly_usd) VALUES (1.00, 10.00)`);
    const before = await db.query<{ may_dispatch: boolean }>(
      `SELECT may_dispatch FROM vesti_ai_budget_check()`,
    );
    assert.equal(before.rows[0]!.may_dispatch, true, "headroom remains");

    await db.query(
      `INSERT INTO ai_calls (model, purpose, input_tokens, output_tokens, cost_usd)
       VALUES ('claude-opus-5', 'test.overspend', 0, 0, 1.50)`,
    );
    const after = await db.query<{ may_dispatch: boolean }>(
      `SELECT may_dispatch FROM vesti_ai_budget_check()`,
    );
    assert.equal(after.rows[0]!.may_dispatch, false, "budget is a gate, not a report");
  });

  it("never hands the same job to two workers", async () => {
    await db.query(
      `INSERT INTO jobs (kind) VALUES ('test.claim'), ('test.claim'), ('test.claim')`,
    );
    const a = await db.query<{ id: string }>(`SELECT id FROM vesti_claim_jobs('worker-a', ARRAY['test.claim'], 2)`);
    const b = await db.query<{ id: string }>(`SELECT id FROM vesti_claim_jobs('worker-b', ARRAY['test.claim'], 2)`);
    const claimed = [...a.rows, ...b.rows].map((r) => r.id);
    assert.equal(new Set(claimed).size, claimed.length, "no job may be claimed twice");
    assert.equal(claimed.length, 3, "all three jobs get claimed exactly once");
  });

  it("retires a poison job instead of retrying it forever", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO jobs (kind, max_attempts, attempts) VALUES ('test.poison', 2, 2) RETURNING id`,
    );
    const result = await db.query<{ vesti_fail_job: string }>(`SELECT vesti_fail_job($1, 'boom')`, [
      rows[0]!.id,
    ]);
    assert.equal(result.rows[0]!.vesti_fail_job, "dead", "exhausted retries must stop looping");
  });
});
