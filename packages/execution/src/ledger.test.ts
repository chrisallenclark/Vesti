/**
 * The order lifecycle against a real database.
 *
 * The schema has always been able to reject a mandate-isolation violation. What
 * it had never done was reject one, because nothing wrote to it. These tests are
 * the difference: they drive fills through the real posting code into real
 * tables and assert both that the intended path works and that the forbidden
 * one fails.
 *
 * The assertion that matters most is `an Active exit cannot reach Long-Term
 * shares`. It is set up so that a naive implementation PASSES the happy path
 * and fails only here: the account holds 540 shares of one ticker, 40 of them in
 * Active, and Active tries to sell 100. Any code that asks "does the account
 * hold 100?" sells shares belonging to a thesis it has never heard of, closes a
 * multi-year position to satisfy a two-day trade, and reports a profit for the
 * wrong mandate. Code that asks "does this mandate hold 100?" refuses.
 *
 * Runs entirely offline. Needs Postgres, not the internet.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SimBroker } from "@vesti/core/broker/sim.ts";
import { OrderLedger, OrderLifecycleError } from "./ledger.ts";
import { InsufficientLotsError } from "./lots.ts";
import { reconcile } from "./reconcile.ts";
import { SelfCrossError, assertNoSelfCross, findSelfCrosses } from "./selfcross.ts";

const execFileAsync = promisify(execFile);
const DB_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const TEST_DB = process.env.VESTI_EXECUTION_TEST_DB ?? "vesti_execution_test";
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_URL = testUrl.toString();

const ENGINE_VERSION = "risk-engine@test";

let admin: pg.Client;
let pool: pg.Pool;
let ledger: OrderLedger;

let userId: string;
let accountId: string;
let activeMandateId: string;
let longTermMandateId: string;
let securityId: string;
let strategyVersionId: string;
let symbol: string;
/** A symbol the broker can report that our ledger has no lots for. */
let otherSymbol: string;

before(async () => {
  const bootstrap = new pg.Client({ connectionString: ADMIN_URL });
  await bootstrap.connect();
  await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
  await bootstrap.end();

  await execFileAsync("npx", ["tsx", "src/migrate.ts", "up"], {
    cwd: DB_PACKAGE,
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });

  admin = new pg.Client({ connectionString: TEST_URL });
  await admin.connect();

  // The ledger connects as vesti_execution — the only role with a write path to
  // orders, fills, lots, allocations and cash. If any of this needed broader
  // rights than the execution service actually holds, these tests would fail on
  // a permission error rather than passing under an owner connection.
  const executionUrl = new URL(TEST_URL);
  executionUrl.username = "vesti_execution";
  executionUrl.password = process.env.VESTI_EXECUTION_PASSWORD ?? "";
  pool = new pg.Pool({ connectionString: executionUrl.toString(), max: 4 });
  ledger = new OrderLedger(pool);
});

after(async () => {
  await pool?.end();
  await admin?.end();
});

/**
 * A fresh portfolio before each test — new user, new account, new mandates, new
 * security. Nothing is deleted.
 *
 * Not a stylistic choice. `risk_evaluations` and `fills` reject DELETE at the
 * table level, so tearing down an account would cascade into rows the database
 * refuses to remove; the suite would have to run against a schema with the
 * append-only guarantee weakened, which is the guarantee it is here to
 * demonstrate. Isolating by identity instead of by truncation means the tests
 * live under the same rules production does.
 */
let fixtureCounter = 0;

beforeEach(async () => {
  const n = ++fixtureCounter;
  symbol = `LT${n}`;
  otherSymbol = `OT${n}`;

  const { rows: users } = await admin.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, 'Lots') RETURNING id`,
    [`lots-${n}@example.com`],
  );
  userId = users[0]!.id;

  const { rows: mandates } = await admin.query<{ id: string; kind: string }>(
    `INSERT INTO mandates (user_id, kind, name, target_weight)
     VALUES ($1, 'active', 'Active', 0.3), ($1, 'long_term', 'Long-Term', 0.7)
     RETURNING id, kind`,
    [userId],
  );
  activeMandateId = mandates.find((m) => m.kind === "active")!.id;
  longTermMandateId = mandates.find((m) => m.kind === "long_term")!.id;

  const { rows: accounts } = await admin.query<{ id: string }>(
    `INSERT INTO accounts (user_id, broker, is_live) VALUES ($1, 'sim', false) RETURNING id`,
    [userId],
  );
  accountId = accounts[0]!.id;

  // Every order names the strategy placing it, so the fixture has to supply one
  // — the ledger refuses an intent without it. That refusal is deliberate: an
  // order with no strategy opens a lot with no strategy, and no engine will
  // ever find, manage or exit that position.
  const { rows: strategies } = await admin.query<{ id: string }>(
    `INSERT INTO strategies (user_id, slug, name, mandate_kind)
     VALUES ($1, 'test.ledger', 'Ledger fixture', 'active') RETURNING id`,
    [userId],
  );
  const { rows: versions } = await admin.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version, status, spec, authored_by, rationale)
     VALUES ($1, 1, 'paper_approved', '{"code_version":"1"}'::jsonb, 'human', 'fixture')
     RETURNING id`,
    [strategies[0]!.id],
  );
  strategyVersionId = versions[0]!.id;

  const { rows: sourceRows } = await admin.query<{ id: string }>(
    `SELECT id FROM sources WHERE slug = 'synthetic'`,
  );
  const { rows: securities } = await admin.query<{ id: string }>(
    `INSERT INTO securities (symbol, asset_class, source_id)
     VALUES ($1, 'equity', $2)
     RETURNING id`,
    [symbol, sourceRows[0]!.id],
  );
  securityId = securities[0]!.id;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

let fillCounter = 0;

/** Intent → approved ruling → submitted, which is where fills become possible. */
async function workingOrder(params: {
  mandateId: string;
  side: "buy" | "sell";
  quantity: number;
  securityId?: string;
}): Promise<string> {
  const orderId = await ledger.recordIntent({
    accountId,
    mandateId: params.mandateId,
    securityId: params.securityId ?? securityId,
    side: params.side,
    kind: "market",
    quantity: params.quantity,
    strategyVersionId,
  });
  await ledger.recordRiskRuling(orderId, {
    decision: "approve",
    requestedQuantity: params.quantity,
    approvedQuantity: params.quantity,
    engineVersion: ENGINE_VERSION,
  });
  await ledger.recordSubmission(orderId, `broker-${orderId.slice(0, 8)}`);
  return orderId;
}

/** Buys `quantity` into a mandate and returns the lot it opened. */
async function buyInto(params: {
  mandateId: string;
  quantity: number;
  price: number;
  fees?: number;
  filledAt?: string;
  securityId?: string;
}): Promise<string> {
  const orderId = await workingOrder({
    mandateId: params.mandateId,
    side: "buy",
    quantity: params.quantity,
    ...(params.securityId ? { securityId: params.securityId } : {}),
  });
  const posted = await ledger.postFill(orderId, {
    brokerFillId: `fill-${++fillCounter}`,
    quantity: params.quantity,
    price: params.price,
    fees: params.fees ?? 0,
    filledAt: new Date(params.filledAt ?? "2026-01-05T15:00:00Z"),
  });
  assert.ok(posted.lotOpened, "a buy fill must open a lot");
  return posted.lotOpened;
}

async function lotRow(lotId: string): Promise<{
  remaining: number;
  quantity: number;
  costBasis: number;
  closedAt: Date | null;
  mandateId: string;
}> {
  const { rows } = await admin.query<{
    remaining: string;
    quantity: string;
    cost_basis: string;
    closed_at: Date | null;
    mandate_id: string;
  }>(`SELECT remaining, quantity, cost_basis, closed_at, mandate_id FROM lots WHERE id = $1`, [
    lotId,
  ]);
  const row = rows[0]!;
  return {
    remaining: Number(row.remaining),
    quantity: Number(row.quantity),
    costBasis: Number(row.cost_basis),
    closedAt: row.closed_at,
    mandateId: row.mandate_id,
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe("order lifecycle", () => {
  it("records an intent before any ruling exists", async () => {
    const orderId = await ledger.recordIntent({
      accountId,
      mandateId: activeMandateId,
      securityId,
      side: "buy",
      kind: "limit",
      quantity: 100,
      limitPrice: 42.5,
      strategyVersionId,
    });
    const { rows } = await admin.query<{ status: string; risk_evaluation_id: string | null }>(
      `SELECT status, risk_evaluation_id FROM orders WHERE id = $1`,
      [orderId],
    );
    assert.equal(rows[0]!.status, "pending_risk");
    assert.equal(rows[0]!.risk_evaluation_id, null);
  });

  it("shrinks the order to what a REDUCE ruling approved", async () => {
    // The gate rejects an order larger than its approval, so a REDUCE that left
    // the original quantity in place would fail on submission rather than
    // trading smaller. Honouring the ruling is the point of the ruling.
    const orderId = await ledger.recordIntent({
      accountId,
      mandateId: activeMandateId,
      securityId,
      side: "buy",
      kind: "market",
      quantity: 500,
      strategyVersionId,
    });
    const result = await ledger.recordRiskRuling(orderId, {
      decision: "reduce",
      requestedQuantity: 500,
      approvedQuantity: 120,
      violations: [{ limit: "portfolio_heat", binding: true }],
      engineVersion: ENGINE_VERSION,
    });

    assert.equal(result.status, "pending_new");
    assert.equal(result.quantity, 120);
    const { rows } = await admin.query<{ quantity: string; status: string }>(
      `SELECT quantity, status FROM orders WHERE id = $1`,
      [orderId],
    );
    assert.equal(Number(rows[0]!.quantity), 120);
    assert.equal(rows[0]!.status, "pending_new");
  });

  it("keeps a rejected order and its reasoning rather than discarding it", async () => {
    const orderId = await ledger.recordIntent({
      accountId,
      mandateId: activeMandateId,
      securityId,
      side: "buy",
      kind: "market",
      quantity: 90,
      strategyVersionId,
    });
    const result = await ledger.recordRiskRuling(orderId, {
      decision: "reject",
      requestedQuantity: 90,
      approvedQuantity: 0,
      violations: [{ limit: "kill_switch" }],
      engineVersion: ENGINE_VERSION,
    });
    assert.equal(result.status, "rejected_risk");

    const { rows } = await admin.query<{ violations: unknown[] }>(
      `SELECT violations FROM risk_evaluations WHERE id = $1`,
      [result.riskEvaluationId],
    );
    assert.deepEqual(rows[0]!.violations, [{ limit: "kill_switch" }]);

    await assert.rejects(
      () => ledger.recordSubmission(orderId, "broker-x"),
      /only a pending_new order may be submitted/,
    );
  });

  it("refuses a ruling that approved more than was requested", async () => {
    const orderId = await ledger.recordIntent({
      accountId,
      mandateId: activeMandateId,
      securityId,
      side: "buy",
      kind: "market",
      quantity: 10,
      strategyVersionId,
    });
    await assert.rejects(
      () =>
        ledger.recordRiskRuling(orderId, {
          decision: "approve",
          requestedQuantity: 10,
          approvedQuantity: 11,
          engineVersion: ENGINE_VERSION,
        }),
      /Sizing steps may only reduce/,
    );
  });

  it("refuses a fill that would take an order past its quantity", async () => {
    const orderId = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 100 });
    await ledger.postFill(orderId, {
      brokerFillId: "partial-1",
      quantity: 60,
      price: 10,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });
    await assert.rejects(
      () =>
        ledger.postFill(orderId, {
          brokerFillId: "partial-2",
          quantity: 50,
          price: 10,
          filledAt: new Date("2026-01-05T15:30:00Z"),
        }),
      (error: unknown) => error instanceof OrderLifecycleError && error.code === "overfill",
    );
  });

  it("keeps the shares that traded when a partly-filled order is cancelled", async () => {
    const orderId = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 100 });
    await ledger.postFill(orderId, {
      brokerFillId: "some",
      quantity: 40,
      price: 10,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });
    const status = await ledger.recordTerminal(orderId, "canceled", "operator");
    assert.equal(
      status,
      "partially_filled",
      "relabelling it canceled would erase the 40 shares that did trade",
    );
  });
});

describe("fill posting", () => {
  it("opens one lot per fill, with fees inside the cost basis", async () => {
    // Two fills at different prices are two lots with two bases. Merging them
    // would discard exactly the distinction specific-lot accounting exists for.
    const orderId = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 100 });
    const first = await ledger.postFill(orderId, {
      brokerFillId: "a",
      quantity: 40,
      price: 10,
      fees: 4,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });
    const second = await ledger.postFill(orderId, {
      brokerFillId: "b",
      quantity: 60,
      price: 11,
      fees: 6,
      filledAt: new Date("2026-01-05T15:30:00Z"),
    });

    assert.equal(first.orderStatus, "partially_filled");
    assert.equal(second.orderStatus, "filled");
    assert.notEqual(first.lotOpened, second.lotOpened);

    // 40 shares at $10 plus $4 of fees is $10.10 a share, not $10.
    assert.equal((await lotRow(first.lotOpened!)).costBasis, 10.1);
    assert.equal((await lotRow(second.lotOpened!)).costBasis, 11.1);
  });

  it("treats a redelivered fill as a no-op rather than a second position", async () => {
    // Brokers replay. Reapplying a fill would open a lot for shares that were
    // bought once and move cash twice for a single trade.
    const orderId = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 50 });
    const first = await ledger.postFill(orderId, {
      brokerFillId: "replayed",
      quantity: 50,
      price: 20,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });
    const again = await ledger.postFill(orderId, {
      brokerFillId: "replayed",
      quantity: 50,
      price: 20,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });

    assert.equal(first.applied, true);
    assert.equal(again.applied, false);
    assert.equal(again.lotOpened, null);

    const { rows } = await admin.query<{ lots: string; fills: string; cash: string }>(
      `SELECT (SELECT count(*) FROM lots WHERE account_id = $1)        AS lots,
              (SELECT count(*) FROM fills WHERE order_id = $2)         AS fills,
              (SELECT count(*) FROM cash_ledger WHERE account_id = $1) AS cash`,
      [accountId, orderId],
    );
    assert.equal(Number(rows[0]!.lots), 1);
    assert.equal(Number(rows[0]!.fills), 1);
    assert.equal(Number(rows[0]!.cash), 1, "one buy entry, no fee entry, nothing duplicated");
    assert.equal(await ledger.cashBalance(accountId), -1000);
  });

  it("writes signed cash entries and keeps fees separately answerable", async () => {
    const buy = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 10 });
    await ledger.postFill(buy, {
      brokerFillId: "cash-buy",
      quantity: 10,
      price: 50,
      fees: 1.5,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });
    const sell = await workingOrder({ mandateId: activeMandateId, side: "sell", quantity: 10 });
    await ledger.postFill(sell, {
      brokerFillId: "cash-sell",
      quantity: 10,
      price: 55,
      fees: 1.5,
      filledAt: new Date("2026-01-09T15:00:00Z"),
    });

    // -500 - 1.50 + 550 - 1.50
    assert.equal(await ledger.cashBalance(accountId), 47);
    const { rows } = await admin.query<{ fees: string }>(
      `SELECT sum(amount) AS fees FROM cash_ledger WHERE account_id = $1 AND kind = 'fee'`,
      [accountId],
    );
    assert.equal(Number(rows[0]!.fees), -3);
  });

  it("attributes cash to the mandate that traded", async () => {
    await buyInto({ mandateId: activeMandateId, quantity: 10, price: 10 });
    await buyInto({ mandateId: longTermMandateId, quantity: 20, price: 10 });

    assert.equal(await ledger.cashBalance(accountId, activeMandateId), -100);
    assert.equal(await ledger.cashBalance(accountId, longTermMandateId), -200);
    assert.equal(await ledger.cashBalance(accountId), -300);
  });
});

describe("cumulative fill posting", () => {
  it("posts a partial once when the stream and the poller both report it", async () => {
    // The regression this design exists for. A `trade_updates` event and a poll
    // of the same order describe the SAME 40 shares. Under two identifiers —
    // the venue's execution id and a synthesized one — they would not collide,
    // and the ledger would book 80 against a 100-share order without ever
    // tripping the overfill check.
    const orderId = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 100 });

    const fromStream = await ledger.postCumulativeFill(orderId, {
      cumulativeQuantity: 40,
      cumulativeAveragePrice: 10,
      filledAt: new Date("2026-01-05T15:00:00Z"),
      executionId: "venue-execution-abc",
    });
    const fromPoller = await ledger.postCumulativeFill(orderId, {
      cumulativeQuantity: 40,
      cumulativeAveragePrice: 10,
      filledAt: new Date("2026-01-05T15:00:05Z"),
    });

    assert.equal(fromStream.applied, true);
    assert.equal(fromPoller.applied, false, "the second report of the same shares must not land");
    assert.equal(fromPoller.filledQuantity, 40);

    const { rows } = await admin.query<{ lots: string; filled: string }>(
      `SELECT (SELECT count(*) FROM lots WHERE account_id = $1)  AS lots,
              (SELECT filled_quantity FROM orders WHERE id = $2) AS filled`,
      [accountId, orderId],
    );
    assert.equal(Number(rows[0]!.lots), 1);
    assert.equal(Number(rows[0]!.filled), 40);
  });

  it("posts only the increment when the cumulative figure advances", async () => {
    const orderId = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 100 });
    await ledger.postCumulativeFill(orderId, {
      cumulativeQuantity: 40,
      cumulativeAveragePrice: 10,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });
    // 40 at $10 then 60 more at $12 blends to $11.20 across 100.
    const second = await ledger.postCumulativeFill(orderId, {
      cumulativeQuantity: 100,
      cumulativeAveragePrice: 11.2,
      filledAt: new Date("2026-01-05T15:30:00Z"),
    });

    assert.equal(second.applied, true);
    assert.equal(second.filledQuantity, 100);
    assert.equal(second.orderStatus, "filled");
    // The increment's own price, recovered from the change in notional — not
    // the blended average, which would misprice both lots.
    const lot = await lotRow(second.lotOpened!);
    assert.equal(lot.quantity, 60);
    assert.equal(lot.costBasis, 12);
  });

  it("heals a fill it never saw, at the blended price of exactly those shares", async () => {
    // The process was down, or the socket was gone. The next cumulative report
    // is the first sight of everything since, and one fill covering the gap at
    // the average of those shares is the correct answer rather than an
    // approximation of it.
    const orderId = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 50 });
    const healed = await ledger.postCumulativeFill(orderId, {
      cumulativeQuantity: 50,
      cumulativeAveragePrice: 20.5,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });
    assert.equal(healed.applied, true);
    assert.equal(healed.filledQuantity, 50);
    assert.equal((await lotRow(healed.lotOpened!)).costBasis, 20.5);
  });

  it("ignores a report that is behind what we already have", async () => {
    const orderId = await workingOrder({ mandateId: activeMandateId, side: "buy", quantity: 100 });
    await ledger.postCumulativeFill(orderId, {
      cumulativeQuantity: 60,
      cumulativeAveragePrice: 10,
      filledAt: new Date("2026-01-05T15:30:00Z"),
    });
    // A stale poll arriving after a newer stream event. Reversing our state to
    // match it would unwind a lot that genuinely exists.
    const stale = await ledger.postCumulativeFill(orderId, {
      cumulativeQuantity: 40,
      cumulativeAveragePrice: 10,
      filledAt: new Date("2026-01-05T15:00:00Z"),
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.filledQuantity, 60);
  });
});

describe("self-cross detection", () => {
  it("refuses to put the account on both sides of the same symbol", async () => {
    // Legal in our model, a wash trade at the venue. Two mandates with opposite
    // intentions in one name is the case where mandate isolation meets a single
    // omnibus account and something has to give.
    await buyInto({ mandateId: longTermMandateId, quantity: 100, price: 80 });
    const longTermExit = await workingOrder({
      mandateId: longTermMandateId,
      side: "sell",
      quantity: 100,
    });

    await assert.rejects(
      () => assertNoSelfCross(pool, { accountId, securityId, side: "buy", symbol }),
      (error: unknown) =>
        error instanceof SelfCrossError &&
        error.conflicts.length === 1 &&
        error.conflicts[0]!.orderId === longTermExit,
    );

    // The same check passes on the side that does not cross.
    await assertNoSelfCross(pool, { accountId, securityId, side: "sell", symbol });
  });

  it("does not see orders that are no longer working", async () => {
    const stale = await workingOrder({ mandateId: activeMandateId, side: "sell", quantity: 10 });
    await ledger.recordTerminal(stale, "canceled");
    assert.deepEqual(await findSelfCrosses(pool, { accountId, securityId, side: "buy" }), []);
  });
});

// ── Specific-lot accounting ─────────────────────────────────────────────────

describe("specific-lot accounting", () => {
  it("consumes the oldest lot first under FIFO and closes it when it empties", async () => {
    const older = await buyInto({
      mandateId: activeMandateId,
      quantity: 50,
      price: 10,
      filledAt: "2026-01-05T15:00:00Z",
    });
    const newer = await buyInto({
      mandateId: activeMandateId,
      quantity: 50,
      price: 20,
      filledAt: "2026-02-05T15:00:00Z",
    });

    const sell = await workingOrder({ mandateId: activeMandateId, side: "sell", quantity: 70 });
    const posted = await ledger.postFill(
      sell,
      {
        brokerFillId: "fifo",
        quantity: 70,
        price: 25,
        filledAt: new Date("2026-03-05T15:00:00Z"),
      },
      { method: "fifo" },
    );

    assert.deepEqual(
      posted.allocations.map((a) => [a.lotId, a.quantity]),
      [
        [older, 50],
        [newer, 20],
      ],
    );

    const olderRow = await lotRow(older);
    assert.equal(olderRow.remaining, 0);
    assert.ok(olderRow.closedAt, "an emptied lot must carry a closing timestamp");
    const newerRow = await lotRow(newer);
    assert.equal(newerRow.remaining, 30);
    assert.equal(newerRow.closedAt, null);

    // (25-10)*50 + (25-20)*20
    assert.equal(posted.realizedPnl, 850);
  });

  it("consumes the most expensive lot first under HIFO", async () => {
    const cheap = await buyInto({
      mandateId: longTermMandateId,
      quantity: 30,
      price: 10,
      filledAt: "2026-01-05T15:00:00Z",
    });
    const dear = await buyInto({
      mandateId: longTermMandateId,
      quantity: 30,
      price: 40,
      filledAt: "2026-02-05T15:00:00Z",
    });

    const sell = await workingOrder({ mandateId: longTermMandateId, side: "sell", quantity: 30 });
    const posted = await ledger.postFill(
      sell,
      {
        brokerFillId: "hifo",
        quantity: 30,
        price: 50,
        filledAt: new Date("2026-03-05T15:00:00Z"),
      },
      { method: "hifo" },
    );

    assert.deepEqual(
      posted.allocations.map((a) => a.lotId),
      [dear],
      "HIFO realises the smallest gain, so the dearest lot goes first",
    );
    assert.equal(posted.realizedPnl, 300);
    assert.equal((await lotRow(cheap)).remaining, 30);
  });

  it("records what each exit closed in order_lot_allocations", async () => {
    const lot = await buyInto({ mandateId: activeMandateId, quantity: 100, price: 10 });
    const sell = await workingOrder({ mandateId: activeMandateId, side: "sell", quantity: 60 });

    // Two partial fills against the same lot accumulate onto one allocation
    // row, matching the table's own (order, lot) key.
    await ledger.postFill(sell, {
      brokerFillId: "s1",
      quantity: 25,
      price: 12,
      filledAt: new Date("2026-03-05T15:00:00Z"),
    });
    await ledger.postFill(sell, {
      brokerFillId: "s2",
      quantity: 35,
      price: 13,
      filledAt: new Date("2026-03-05T15:30:00Z"),
    });

    const { rows } = await admin.query<{ lot_id: string; quantity: string }>(
      `SELECT lot_id, quantity FROM order_lot_allocations WHERE order_id = $1`,
      [sell],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.lot_id, lot);
    assert.equal(Number(rows[0]!.quantity), 60);
    assert.equal((await lotRow(lot)).remaining, 40);
  });

  it("apportions fees by share so P&L does not depend on fill chunking", async () => {
    const lot = await buyInto({ mandateId: activeMandateId, quantity: 100, price: 10 });
    const sell = await workingOrder({ mandateId: activeMandateId, side: "sell", quantity: 100 });
    const posted = await ledger.postFill(sell, {
      brokerFillId: "fees",
      quantity: 100,
      price: 12,
      fees: 5,
      filledAt: new Date("2026-03-05T15:00:00Z"),
    });
    // (12-10)*100 less the $5 it cost to get out.
    assert.equal(posted.realizedPnl, 195);
    assert.equal((await lotRow(lot)).remaining, 0);
  });
});

// ── Mandate isolation ───────────────────────────────────────────────────────

describe("mandate isolation", () => {
  /**
   * The scenario the whole design exists for: one ticker, two mandates, two
   * theses. Long-Term holds 500 shares it intends to keep for years; Active
   * holds 40 as a tactical trade.
   */
  async function twoMandatesHoldingTheSameTicker(): Promise<{
    activeLot: string;
    longTermLot: string;
  }> {
    const longTermLot = await buyInto({
      mandateId: longTermMandateId,
      quantity: 500,
      price: 80,
      filledAt: "2024-03-05T15:00:00Z",
    });
    const activeLot = await buyInto({
      mandateId: activeMandateId,
      quantity: 40,
      price: 120,
      filledAt: "2026-01-05T15:00:00Z",
    });
    return { activeLot, longTermLot };
  }

  it("refuses an Active exit larger than Active holds, though the account holds plenty", async () => {
    const { activeLot, longTermLot } = await twoMandatesHoldingTheSameTicker();

    const sell = await workingOrder({ mandateId: activeMandateId, side: "sell", quantity: 100 });
    await assert.rejects(
      () =>
        ledger.postFill(sell, {
          brokerFillId: "reach",
          quantity: 100,
          price: 130,
          filledAt: new Date("2026-02-05T15:00:00Z"),
        }),
      (error: unknown) =>
        error instanceof InsufficientLotsError &&
        error.requested === 100 &&
        error.available === 40,
      "the account holds 540; Active holds 40, and 40 is the only number that matters",
    );

    // The refusal must also have left nothing behind. A transaction that opened
    // cash entries or allocations before failing would be a worse outcome than
    // the sale itself.
    assert.equal((await lotRow(longTermLot)).remaining, 500);
    assert.equal((await lotRow(activeLot)).remaining, 40);
    const { rows } = await admin.query<{ allocations: string; fills: string }>(
      `SELECT (SELECT count(*) FROM order_lot_allocations WHERE order_id = $1) AS allocations,
              (SELECT count(*) FROM fills WHERE order_id = $1)                 AS fills`,
      [sell],
    );
    assert.equal(Number(rows[0]!.allocations), 0);
    assert.equal(Number(rows[0]!.fills), 0, "the fill row must roll back with everything else");
  });

  it("closes only its own mandate's lots when the exit does fit", async () => {
    const { activeLot, longTermLot } = await twoMandatesHoldingTheSameTicker();

    const sell = await workingOrder({ mandateId: activeMandateId, side: "sell", quantity: 40 });
    const posted = await ledger.postFill(sell, {
      brokerFillId: "own",
      quantity: 40,
      price: 130,
      filledAt: new Date("2026-02-05T15:00:00Z"),
    });

    assert.deepEqual(
      posted.allocations.map((a) => a.lotId),
      [activeLot],
      "FIFO across the account would have taken the 2024 Long-Term lot first",
    );
    assert.equal((await lotRow(longTermLot)).remaining, 500);
    assert.equal((await lotRow(longTermLot)).closedAt, null);
    // Realised against Active's $120 basis, not Long-Term's $80. Charging the
    // trade to the wrong basis would report $50 a share of profit the tactical
    // trade did not make.
    assert.equal(posted.realizedPnl, 400);
  });

  it("reports position and cash per mandate, not per account", async () => {
    await twoMandatesHoldingTheSameTicker();

    const active = await ledger.positionForMandate(accountId, activeMandateId, securityId);
    const longTerm = await ledger.positionForMandate(accountId, longTermMandateId, securityId);
    assert.deepEqual(active, { quantity: 40, averageCost: 120 });
    assert.deepEqual(longTerm, { quantity: 500, averageCost: 80 });
  });

  it("is enforced by the database even when the selector is bypassed", async () => {
    // The selector above is the reason isolation holds in practice. This is the
    // reason a bug in it cannot quietly break the guarantee: the allocation is
    // written directly, skipping every line of application code, and the
    // trigger still refuses it.
    const { longTermLot } = await twoMandatesHoldingTheSameTicker();
    const activeSell = await workingOrder({
      mandateId: activeMandateId,
      side: "sell",
      quantity: 10,
    });

    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO order_lot_allocations (order_id, lot_id, quantity) VALUES ($1, $2, 10)`,
          [activeSell, longTermLot],
        ),
      /mandate isolation violated/,
    );
  });
});

// ── Reconciliation ──────────────────────────────────────────────────────────

describe("reconciliation against the broker's own books", () => {
  it("balances when our lots sum to the broker's omnibus position", async () => {
    await buyInto({ mandateId: activeMandateId, quantity: 40, price: 120 });
    await buyInto({ mandateId: longTermMandateId, quantity: 500, price: 80 });

    const report = await reconcile(pool, {
      accountId,
      positions: [{ symbol, quantity: 540 }],
      brokerCash: -44800,
    });
    assert.deepEqual(report.discrepancies, []);
    assert.equal(report.balanced, true);
  });

  it("locates a quantity drift down to the mandate", async () => {
    await buyInto({ mandateId: activeMandateId, quantity: 40, price: 120 });
    await buyInto({ mandateId: longTermMandateId, quantity: 500, price: 80 });

    const report = await reconcile(pool, {
      accountId,
      positions: [{ symbol, quantity: 500 }],
    });
    assert.equal(report.discrepancies.length, 1);
    const [drift] = report.discrepancies;
    assert.equal(drift!.kind, "quantity_mismatch");
    assert.equal(drift!.ledger, 540);
    assert.equal(drift!.broker, 500);
    assert.equal(drift!.byMandate?.length, 2, "a drift is useless without knowing whose it is");
  });

  it("flags real shares no mandate is accounting for", async () => {
    // The dangerous direction. Shares the broker holds and our ledger does not
    // have no thesis, no stop watching them, and no exit that will ever name
    // them.
    await buyInto({ mandateId: activeMandateId, quantity: 40, price: 120 });
    const report = await reconcile(pool, {
      accountId,
      positions: [
        { symbol, quantity: 40 },
        { symbol: otherSymbol, quantity: 75 },
      ],
    });
    assert.deepEqual(
      report.discrepancies.map((d) => [d.kind, d.symbol, d.broker]),
      [["missing_in_ledger", otherSymbol, 75]],
    );
  });

  it("flags a cash balance that does not agree with the broker's", async () => {
    await buyInto({ mandateId: activeMandateId, quantity: 10, price: 10 });
    const report = await reconcile(pool, {
      accountId,
      positions: [{ symbol, quantity: 10 }],
      brokerCash: -99,
    });
    assert.equal(report.discrepancies.length, 1);
    assert.equal(report.discrepancies[0]!.kind, "cash_mismatch");
    assert.equal(report.discrepancies[0]!.ledger, -100);
  });
});

// ── End to end ──────────────────────────────────────────────────────────────

describe("SimBroker fills posted through to the ledger", () => {
  it("reconciles our lot ledger against the simulator after a full run", async () => {
    // The loop the whole of Phase 5 is for: a broker produces fills, the ledger
    // turns them into lots and cash, and the two are then compared. Our lots
    // and the broker's single omnibus number are computed by entirely different
    // code from different state, so agreement between them is evidence rather
    // than a tautology.
    const startingCash = 100_000;
    await admin.query(
      `INSERT INTO cash_ledger (account_id, occurred_at, kind, amount, reference)
       VALUES ($1, '2026-01-02T14:00:00Z', 'deposit', $2, 'opening balance')`,
      [accountId, startingCash],
    );

    const broker = new SimBroker({ startingCash, feePerShare: 0.005 });
    const bar = (sessionDate: string, price: number) => ({
      symbol,
      sessionDate,
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 5_000_000,
    });

    // Active buys 200, Long-Term buys 300, then Active exits its 200. The
    // simulator will not fill on the session an order is submitted, so each
    // order is placed one session and matched the next.
    broker.openSession("2026-01-05", [bar("2026-01-05", 100)]);

    const activeBuy = await workingOrder({
      mandateId: activeMandateId,
      side: "buy",
      quantity: 200,
    });
    const longTermBuy = await workingOrder({
      mandateId: longTermMandateId,
      side: "buy",
      quantity: 300,
    });
    for (const [orderId, quantity] of [
      [activeBuy, 200],
      [longTermBuy, 300],
    ] as const) {
      await broker.submitOrder({
        clientOrderId: orderId,
        symbol,
        side: "buy",
        kind: "market",
        quantity,
        timeInForce: "day",
        riskEvaluationId: "unused-here",
      });
    }

    const buyFills = broker.openSession("2026-01-06", [bar("2026-01-06", 101)]);
    assert.equal(buyFills.length, 2);
    for (const fill of buyFills) {
      const posted = await ledger.postFill(fill.clientOrderId, {
        brokerFillId: `${fill.brokerOrderId}:${fill.sessionDate}:${fill.sequence}`,
        quantity: fill.quantity,
        price: fill.price,
        fees: fill.fees,
        filledAt: new Date(`${fill.sessionDate}T14:30:00Z`),
      });
      assert.equal(posted.applied, true);
      assert.equal(posted.orderStatus, "filled");
    }

    const activeSell = await workingOrder({
      mandateId: activeMandateId,
      side: "sell",
      quantity: 200,
    });
    await broker.submitOrder({
      clientOrderId: activeSell,
      symbol,
      side: "sell",
      kind: "market",
      quantity: 200,
      timeInForce: "day",
      riskEvaluationId: "unused-here",
    });
    const sellFills = broker.openSession("2026-01-07", [bar("2026-01-07", 108)]);
    assert.equal(sellFills.length, 1);
    const exit = await ledger.postFill(activeSell, {
      brokerFillId: `${sellFills[0]!.brokerOrderId}:${sellFills[0]!.sessionDate}:${sellFills[0]!.sequence}`,
      quantity: sellFills[0]!.quantity,
      price: sellFills[0]!.price,
      fees: sellFills[0]!.fees,
      filledAt: new Date("2026-01-07T14:30:00Z"),
    });

    // Active is flat; Long-Term still holds its 300. That the exit took only
    // Active's shares is what leaves the broker at exactly 300.
    assert.equal(
      (await ledger.positionForMandate(accountId, activeMandateId, securityId)).quantity,
      0,
    );
    assert.equal(
      (await ledger.positionForMandate(accountId, longTermMandateId, securityId)).quantity,
      300,
    );
    assert.ok(exit.realizedPnl > 0, "bought near 101, sold near 108");

    const account = await broker.getAccount();
    const report = await reconcile(pool, {
      accountId,
      positions: await broker.listPositions(),
      brokerCash: account.cash,
    });
    assert.deepEqual(
      report.discrepancies,
      [],
      "our lots and cash must agree with the broker's independent count",
    );
  });
});
