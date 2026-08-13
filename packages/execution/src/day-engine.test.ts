/**
 * The DAY engine's whole cycle, against a real database.
 *
 * The broker and the market data are stubs; everything between them is the
 * production code path — the real risk engine, the real execution gate, the
 * real ledger with its real triggers, the real fill poller, the real
 * reconciliation, the real kill switch, and the actual SQL. That is the point.
 * A test that stubs the ledger proves the engine calls a function; this proves
 * an order cannot exist without an approving risk evaluation, because the
 * database says so.
 *
 * The assertions that matter are the ones about running it TWICE:
 *
 *   A restart must not duplicate a position. The engine is designed to hold
 *   nothing across cycles, so the way this could break is a signal being
 *   re-proposed while its order is still working — and `tradedToday` is counted
 *   from orders rather than fills precisely so that a submitted-but-unfilled
 *   order still uses its shot.
 *
 *   A redelivered fill must not double the shares. The ledger keys increments
 *   on cumulative quantity under a row lock, so the second posting finds
 *   nothing left to do.
 *
 * Needs Postgres. Does not need the internet.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { BrokerOrderRequest, BrokerOrderState } from "@vesti/core/broker/types.ts";
import { OpeningRangeBreakout } from "@vesti/core/strategy/opening-range.ts";
import { easternClock } from "@vesti/core/strategy/intraday.ts";
import { DayEngine } from "./day-engine.ts";
import type { BrokerPortfolio } from "./alpaca.ts";
import { tripKillSwitch } from "./killswitch.ts";
import { sessionOpenInstant } from "./market-data.ts";
import type { IntradayBarRow, MarketClock } from "./market-data.ts";
import { Observer } from "./observability.ts";

const execFileAsync = promisify(execFile);
const DB_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const TEST_DB = process.env.VESTI_DAY_TEST_DB ?? "vesti_day_test";
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_URL = testUrl.toString();

/**
 * TODAY, in US/Eastern — not a date written into the file.
 *
 * The engine counts what it has already traded today by comparing an order's
 * `created_at` against the session date, and `created_at` is the real clock
 * whatever the test pretends the time is. A hard-coded date therefore passes on
 * exactly one calendar day and then reports a duplicate-order bug that is not
 * there. It did, the following afternoon.
 */
const SESSION = easternClock(new Date()).sessionDate;
const SESSION_OPEN_MS = Date.parse(sessionOpenInstant(SESSION));
/** 11:00 ET, whichever side of daylight saving this session falls on. */
const AT_ELEVEN = new Date(SESSION_OPEN_MS + 90 * 60_000);

let admin: pg.Client;
let pool: pg.Pool;

let userId: string;
let accountId: string;
let strategyVersionId: string;
let symbol: string;

// ── Stubs ───────────────────────────────────────────────────────────────────

/**
 * A venue that accepts everything and fills it whole at a fixed price.
 *
 * Fills only on request, not on submission, so the gap between "submitted" and
 * "filled" — where every double-submission bug lives — is a state the tests can
 * actually stand in.
 */
class StubBroker {
  readonly submitted: BrokerOrderRequest[] = [];
  readonly #orders = new Map<string, BrokerOrderState>();
  positions: Array<{ symbol: string; quantity: number; averageCost: number }> = [];
  fillPrice = 100.8;
  cash = 100_000;

  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrderState> {
    // Alpaca refuses a repeated client_order_id and returns the existing order.
    // Reproduced here because the engine relies on it for retry safety.
    const existing = this.#orders.get(request.clientOrderId);
    if (existing) return existing;

    this.submitted.push(request);
    const state: BrokerOrderState = {
      brokerOrderId: `broker-${this.submitted.length}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      kind: request.kind,
      quantity: request.quantity,
      filledQuantity: 0,
      averageFillPrice: null,
      limitPrice: null,
      stopPrice: null,
      timeInForce: request.timeInForce,
      status: "working",
      submittedSession: SESSION,
    };
    this.#orders.set(request.clientOrderId, state);
    return state;
  }

  /** Fills everything working, and updates the position book to match. */
  fillEverything(): void {
    for (const [id, state] of this.#orders) {
      if (state.filledQuantity >= state.quantity) continue;
      this.#orders.set(id, {
        ...state,
        filledQuantity: state.quantity,
        averageFillPrice: this.fillPrice,
        status: "filled",
      });
      const signed = state.side === "buy" ? state.quantity : -state.quantity;
      const held = this.positions.find((p) => p.symbol === state.symbol);
      if (held) held.quantity += signed;
      else if (signed > 0) {
        this.positions.push({
          symbol: state.symbol,
          quantity: signed,
          averageCost: this.fillPrice,
        });
      }
      this.cash -= signed * this.fillPrice;
    }
    this.positions = this.positions.filter((p) => Math.abs(p.quantity) > 1e-9);
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrderState | null> {
    return this.#orders.get(clientOrderId) ?? null;
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderState | null> {
    return [...this.#orders.values()].find((o) => o.brokerOrderId === brokerOrderId) ?? null;
  }

  async cancelOrder(brokerOrderId: string): Promise<BrokerOrderState> {
    const order = await this.getOrder(brokerOrderId);
    if (!order) throw new Error("no such order");
    return order;
  }

  async listOpenOrders(): Promise<BrokerOrderState[]> {
    return [...this.#orders.values()].filter((o) => o.status === "working");
  }

  async listPositions(): Promise<Array<{ symbol: string; quantity: number; averageCost: number }>> {
    return this.positions.map((p) => ({ ...p }));
  }

  async getAccount(): Promise<{ cash: number; buyingPower: number; equity: number }> {
    return { cash: this.cash, buyingPower: this.cash * 2, equity: 100_000 };
  }

  async getPortfolio(): Promise<BrokerPortfolio> {
    return {
      cash: this.cash,
      buyingPower: this.cash * 2,
      equity: 100_000,
      dayPnl: 0,
      positions: this.positions.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        averageCost: p.averageCost,
        marketValue: p.quantity * this.fillPrice,
        unrealizedPnl: 0,
        unrealizedPnlFraction: 0,
        currentPrice: this.fillPrice,
      })),
    };
  }

  readonly name = "stub";
  readonly isLive = false;
}

/** A data feed that returns whatever bars the test hands it. */
class StubData {
  bars = new Map<string, IntradayBarRow[]>();
  isOpen = true;
  readonly feed = "iex" as const;

  async fetchBars(): Promise<Map<string, IntradayBarRow[]>> {
    return this.bars;
  }

  async fetchClock(): Promise<MarketClock> {
    return {
      isOpen: this.isOpen,
      timestamp: AT_ELEVEN.toISOString(),
      nextOpen: new Date(SESSION_OPEN_MS).toISOString(),
      nextClose: new Date(SESSION_OPEN_MS + 390 * 60_000).toISOString(),
    };
  }
}

/** A bar at `minute` minutes past the 09:30 ET open, on whichever offset applies. */
function bar(minute: number, overrides: Partial<IntradayBarRow> = {}): IntradayBarRow {
  return {
    symbol,
    ts: new Date(SESSION_OPEN_MS + minute * 60_000).toISOString(),
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 1000,
    vwap: 100,
    ...overrides,
  };
}

/** Thirty flat range bars, then a clean breakout on 2x volume. */
function breakoutSession(): IntradayBarRow[] {
  const bars: IntradayBarRow[] = [];
  for (let i = 0; i < 30; i += 1) bars.push(bar(i));
  bars.push(
    bar(30, { open: 100.4, high: 100.9, low: 100.4, close: 100.8, vwap: 100.7, volume: 2000 }),
  );
  return bars;
}

/** The same session, plus a bar whose low breaks the 100.25 stop. */
function stoppedSession(): IntradayBarRow[] {
  return [
    ...breakoutSession(),
    bar(40, { open: 100.7, high: 100.8, low: 100.1, close: 100.2, vwap: 100.5 }),
  ];
}

// ── Wiring ──────────────────────────────────────────────────────────────────

let broker: StubBroker;
let data: StubData;
let observer: Observer;

function engineFor(strategy = new OpeningRangeBreakout()): DayEngine {
  return new DayEngine({
    pool,
    broker: broker as unknown as ConstructorParameters<typeof DayEngine>[0]["broker"],
    data: data as unknown as ConstructorParameters<typeof DayEngine>[0]["data"],
    observer,
    accountId,
    strategy,
    tradingBaseUrl: "https://paper-api.alpaca.markets",
    reconcileEvery: 1,
  });
}

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

  // Connects as vesti_execution, exactly as the worker does. Anything the
  // engine needs beyond that role's rights fails here as a permission error
  // rather than passing under an owner connection and failing in production.
  const executionUrl = new URL(TEST_URL);
  executionUrl.username = "vesti_execution";
  executionUrl.password = process.env.VESTI_EXECUTION_PASSWORD ?? "";
  pool = new pg.Pool({ connectionString: executionUrl.toString(), max: 4 });
});

after(async () => {
  await pool?.end();
  await admin?.end();
});

let counter = 0;

beforeEach(async () => {
  const n = ++counter;
  symbol = `DAY${n}`;
  broker = new StubBroker();
  data = new StubData();

  const { rows: users } = await admin.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, 'Day') RETURNING id`,
    [`day-${n}@example.com`],
  );
  userId = users[0]!.id;

  await admin.query(
    `INSERT INTO mandates (user_id, kind, name, target_weight)
     VALUES ($1, 'active', 'Active', 0.3), ($1, 'catalyst', 'Catalyst', 0.2),
            ($1, 'long_term', 'Long-Term', 0.5)`,
    [userId],
  );

  const { rows: accounts } = await admin.query<{ id: string }>(
    `INSERT INTO accounts (user_id, broker, external_id, is_live)
     VALUES ($1, 'alpaca', $2, false) RETURNING id`,
    [userId, `PAPER${n}`],
  );
  accountId = accounts[0]!.id;

  const { rows: sources } = await admin.query<{ id: string }>(
    `SELECT id FROM sources WHERE slug = 'synthetic'`,
  );
  const { rows: securities } = await admin.query<{ id: string }>(
    `INSERT INTO securities (symbol, asset_class, source_id) VALUES ($1, 'equity', $2) RETURNING id`,
    [symbol, sources[0]!.id],
  );
  const securityId = securities[0]!.id;

  // Daily bars: the universe is defined by having them, and the risk engine
  // reads liquidity and volatility from them. Twenty sessions of a liquid name.
  for (let i = 0; i < 20; i += 1) {
    const date = new Date(`2026-07-01T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + i);
    await admin.query(
      `INSERT INTO bars_daily (security_id, session_date, open, high, low, close, volume, tape, source_id)
       VALUES ($1, $2, 99, 101, 98, 100, 40000000, 'synthetic', $3)`,
      [securityId, date.toISOString().slice(0, 10), sources[0]!.id],
    );
  }

  // The strategy, registered and promoted. Trading is authorised by database
  // state, so a test that skipped this would be testing a different system.
  const strategy = new OpeningRangeBreakout();
  const { rows: strategies } = await admin.query<{ id: string }>(
    `INSERT INTO strategies (user_id, slug, name, mandate_kind)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [userId, strategy.key, strategy.describe.slice(0, 120)],
  );
  const { rows: versions } = await admin.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version, spec, status, rationale)
     VALUES ($1, 1, $2::jsonb, 'paper_approved', 'test fixture') RETURNING id`,
    [strategies[0]!.id, JSON.stringify({ code_version: String(strategy.version) })],
  );
  strategyVersionId = versions[0]!.id;

  // Opening capital, so the risk engine has an Active budget to size against.
  await admin.query(
    `INSERT INTO cash_ledger (account_id, mandate_id, amount, kind, reference, occurred_at)
     SELECT $1, m.id, 30000, 'deposit', 'fixture', now() FROM mandates m
      WHERE m.user_id = $2 AND m.kind = 'active'`,
    [accountId, userId],
  );

  observer = new Observer({
    pool,
    accountId,
    engine: "DAY",
    tradingMode: "paper",
    workerId: `test-${n}`,
  });

  data.bars = new Map([[symbol, breakoutSession()]]);
});

// ── The loop ────────────────────────────────────────────────────────────────

describe("the DAY engine, end to end", () => {
  it("takes a signal all the way to a submitted paper order, with its thesis", async () => {
    const outcome = await engineFor().cycle(AT_ELEVEN);

    assert.equal(outcome.haltReason, null);
    assert.equal(outcome.submitted.length, 1, "one breakout, one order");
    assert.equal(broker.submitted.length, 1);
    assert.equal(broker.submitted[0]!.symbol, symbol);
    assert.equal(broker.submitted[0]!.side, "buy");

    const orderId = outcome.submitted[0]!.orderId;

    // The order exists only because a risk evaluation approved it — migration
    // 005's trigger would have refused it otherwise.
    const { rows: orders } = await pool.query(
      `SELECT status, risk_evaluation_id, strategy_version_id, broker_order_id
         FROM orders WHERE id = $1`,
      [orderId],
    );
    assert.equal(orders[0]!.status, "working");
    assert.ok(orders[0]!.risk_evaluation_id, "no order without an approving ruling");
    assert.equal(orders[0]!.strategy_version_id, strategyVersionId);
    assert.ok(orders[0]!.broker_order_id);

    // The thesis, recorded at intent and not recoverable afterwards.
    const { rows: decisions } = await pool.query<{
      engine: string;
      intent: string;
      reasons: string[];
      stop_price: string;
      target_price: string;
      risk_amount: string;
      trading_mode: string;
    }>(`SELECT * FROM trade_decisions WHERE order_id = $1`, [orderId]);
    const decision = decisions[0]!;
    assert.equal(decision.engine, "DAY");
    assert.equal(decision.intent, "entry");
    assert.equal(decision.trading_mode, "paper");
    assert.equal(Number(decision.stop_price), 100.25);
    assert.equal(Number(decision.target_price), 101.9);
    assert.ok(Number(decision.risk_amount) > 0);
    assert.ok(decision.reasons.some((r) => r.includes("VWAP")));

    // The feed carries the decision and the refusals around it.
    const { rows: activity } = await pool.query<{ kind: string }>(
      `SELECT kind FROM activity_log WHERE account_id = $1`,
      [accountId],
    );
    const kinds = new Set(activity.map((a) => a.kind));
    for (const expected of ["entry_signal", "risk_approved", "order_submitted"]) {
      assert.ok(kinds.has(expected), `feed is missing ${expected}`);
    }
  });

  it("posts the fill, opens the lot with its stop, and publishes the broker's view", async () => {
    const engine = engineFor();
    await engine.cycle(AT_ELEVEN);
    broker.fillEverything();
    await engine.cycle(AT_ELEVEN);

    const { rows: lots } = await pool.query<{
      remaining: string;
      cost_basis: string;
      stop_price: string | null;
      target_price: string | null;
      strategy_version_id: string | null;
    }>(`SELECT * FROM lots WHERE account_id = $1 AND remaining > 0`, [accountId]);
    assert.equal(lots.length, 1);
    assert.equal(Number(lots[0]!.cost_basis), broker.fillPrice);
    // The plan reaches the lot through the poller, which is the path a restart
    // takes — without it the risk engine's heat cap reads an unprotected
    // position as carrying no open risk.
    assert.equal(Number(lots[0]!.stop_price), 100.25);
    assert.equal(Number(lots[0]!.target_price), 101.9);
    assert.equal(lots[0]!.strategy_version_id, strategyVersionId);

    const { rows: snapshots } = await pool.query<{ equity: string; positions: unknown }>(
      `SELECT equity, positions FROM broker_snapshots WHERE account_id = $1`,
      [accountId],
    );
    assert.equal(snapshots.length, 1, "the dashboard's live view is written every cycle");
    assert.equal((snapshots[0]!.positions as unknown[]).length, 1);
  });

  it("closes the position when the stop is breached, and records why", async () => {
    const engine = engineFor();
    await engine.cycle(AT_ELEVEN);
    broker.fillEverything();
    await engine.cycle(AT_ELEVEN);

    // Price comes back through the stop.
    data.bars = new Map([[symbol, stoppedSession()]]);
    broker.fillPrice = 100.2;
    const exitCycle = await engineFor().cycle(AT_ELEVEN);

    assert.equal(exitCycle.submitted.length, 1);
    assert.equal(exitCycle.submitted[0]!.side, "sell");

    const { rows: decisions } = await pool.query<{ exit_reason: string; intent: string }>(
      `SELECT intent, exit_reason FROM trade_decisions WHERE order_id = $1`,
      [exitCycle.submitted[0]!.orderId],
    );
    assert.equal(decisions[0]!.intent, "exit");
    assert.equal(decisions[0]!.exit_reason, "stop");

    // And the round trip lands in the journal with a realised number.
    broker.fillEverything();
    await engineFor().cycle(AT_ELEVEN);
    const { rows: journal } = await pool.query<{
      intent: string | null;
      realized_pnl: string | null;
      holding_seconds: string | null;
    }>(
      `SELECT intent, realized_pnl, holding_seconds FROM trade_journal
        WHERE account_id = $1 AND intent = 'exit'`,
      [accountId],
    );
    assert.equal(journal.length, 1);
    assert.ok(journal[0]!.realized_pnl !== null, "an exit banks a number");
    assert.ok(Number(journal[0]!.realized_pnl) < 0, "stopped out below cost is a loss");

    const { rows: open } = await pool.query(
      `SELECT 1 FROM lots WHERE account_id = $1 AND remaining > 0`,
      [accountId],
    );
    assert.equal(open.length, 0, "the position is flat");
  });

  // ── The properties that make it restartable ───────────────────────────────

  it("does not open a second position when the same cycle runs again", async () => {
    const engine = engineFor();
    await engine.cycle(AT_ELEVEN);
    assert.equal(broker.submitted.length, 1);

    // A fresh engine on the same data: the process restarted, the market has
    // not moved, and the order it placed is still working rather than filled.
    await engineFor().cycle(AT_ELEVEN);
    assert.equal(broker.submitted.length, 1, "a submitted order still uses its shot");

    broker.fillEverything();
    await engineFor().cycle(AT_ELEVEN);
    await engineFor().cycle(AT_ELEVEN);
    assert.equal(broker.submitted.length, 1, "and a filled one is a held position");

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM lots WHERE account_id = $1 AND remaining > 0`,
      [accountId],
    );
    assert.equal(Number(rows[0]!.count), 1);
  });

  it("does not submit a second exit while the first is still working", async () => {
    const engine = engineFor();
    await engine.cycle(AT_ELEVEN);
    broker.fillEverything();
    await engine.cycle(AT_ELEVEN);

    // The stop is breached. The exit goes out — and does not fill.
    data.bars = new Map([[symbol, stoppedSession()]]);
    const first = await engineFor().cycle(AT_ELEVEN);
    assert.equal(first.submitted.length, 1);
    assert.equal(first.submitted[0]!.side, "sell");

    // Next cycle: the fill has not come back, so the lot still reads as held
    // and the stop is still breached. Self-cross detection does not cover this
    // — it matches the OPPOSITE side — so the only thing standing between here
    // and a short position is the working-quantity clamp.
    const second = await engineFor().cycle(AT_ELEVEN);
    assert.equal(second.submitted.length, 0, "the position is already on its way out");
    assert.match(second.refusals[0]?.reason ?? "", /already working/);

    const sells = broker.submitted.filter((o) => o.side === "sell");
    assert.equal(sells.length, 1, "ten shares held must never become twenty sold");
  });

  it("does not double the shares when the same fill is delivered twice", async () => {
    const engine = engineFor();
    await engine.cycle(AT_ELEVEN);
    broker.fillEverything();

    await engine.cycle(AT_ELEVEN);
    const { rows: first } = await pool.query<{ total: string }>(
      `SELECT sum(remaining) AS total FROM lots WHERE account_id = $1`,
      [accountId],
    );

    // The poller sweeps the same order again — the exact shape of a stream and
    // a poll describing one fill.
    await engine.cycle(AT_ELEVEN);
    const { rows: second } = await pool.query<{ total: string; fills: string }>(
      `SELECT sum(remaining) AS total,
              (SELECT count(*) FROM fills f JOIN orders o ON o.id = f.order_id
                WHERE o.account_id = $1) AS fills
         FROM lots WHERE account_id = $1`,
      [accountId],
    );
    assert.equal(Number(second[0]!.total), Number(first[0]!.total));
    assert.equal(Number(second[0]!.fills), 1, "one economic fill, one row");
  });

  // ── The refusals ──────────────────────────────────────────────────────────

  it("refuses to let a second worker trade the same account", async () => {
    // One worker beating now.
    const incumbent = new Observer({
      pool,
      accountId,
      engine: "DAY",
      tradingMode: "paper",
      workerId: "incumbent",
    });
    await incumbent.beat("running", { alpacaOk: true });

    const challenger = new Observer({
      pool,
      accountId,
      engine: "DAY",
      tradingMode: "paper",
      workerId: "challenger",
    });
    const holder = await challenger.leaseHolder(3 * 60 * 1000);
    assert.equal(holder?.workerId, "incumbent", "a live incumbent holds the account");

    // The incumbent sees itself, not a rival.
    assert.equal(await incumbent.leaseHolder(3 * 60 * 1000), null);

    // Once the incumbent has gone quiet, the account is takeable — which is
    // what makes a wedged or killed worker recoverable without a human.
    await pool.query(
      `UPDATE worker_state SET last_beat_at = now() - interval '10 minutes'
        WHERE account_id = $1 AND engine = 'DAY'`,
      [accountId],
    );
    assert.equal(
      await challenger.leaseHolder(3 * 60 * 1000),
      null,
      "an abandoned lease must not lock the account for the rest of the day",
    );
  });

  it("submits nothing while the kill switch is tripped", async () => {
    await tripKillSwitch(pool, { accountId, reason: "testing the halt", by: "test" });

    const outcome = await engineFor().cycle(AT_ELEVEN);
    assert.match(outcome.haltReason ?? "", /kill switch/);
    assert.equal(broker.submitted.length, 0);
  });

  it("submits nothing when the market is closed", async () => {
    data.isOpen = false;
    const outcome = await engineFor().cycle(AT_ELEVEN);
    assert.match(outcome.haltReason ?? "", /market closed/);
    assert.equal(broker.submitted.length, 0);
  });

  it("submits nothing when the strategy is not promoted", async () => {
    await admin.query(
      `INSERT INTO strategy_versions (strategy_id, version, spec, status, rationale)
       SELECT strategy_id, 2, spec, 'paused', 'paused by the test'
         FROM strategy_versions WHERE id = $1`,
      [strategyVersionId],
    );
    const outcome = await engineFor().cycle(AT_ELEVEN);
    assert.match(outcome.haltReason ?? "", /not paper_approved/);
    assert.equal(broker.submitted.length, 0);
  });

  it("refuses to trade on a ledger that disagrees with the broker", async () => {
    // Shares at the broker that no mandate is accounting for: the dangerous
    // direction, because no stop is watching them.
    broker.positions.push({ symbol: "GHOST", quantity: 10, averageCost: 50 });

    const outcome = await engineFor().cycle(AT_ELEVEN);
    assert.match(outcome.haltReason ?? "", /does not agree/);
    assert.equal(broker.submitted.length, 0);

    const { rows } = await pool.query<{ balanced: boolean }>(
      `SELECT balanced FROM reconciliation_runs WHERE account_id = $1`,
      [accountId],
    );
    assert.equal(rows[0]!.balanced, false, "the drift is written down, not just acted on");
  });

  it("still posts fills while halted, because an unposted fill is an unwatched position", async () => {
    const engine = engineFor();
    await engine.cycle(AT_ELEVEN);
    broker.fillEverything();

    await tripKillSwitch(pool, { accountId, reason: "halted mid-flight", by: "test" });
    const outcome = await engineFor().cycle(AT_ELEVEN);

    assert.match(outcome.haltReason ?? "", /kill switch/);
    assert.equal(outcome.fillsPosted, 1, "the fill still reached the ledger");
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM lots WHERE account_id = $1 AND remaining > 0`,
      [accountId],
    );
    assert.equal(Number(rows[0]!.count), 1);
  });

  it("decides everything and submits nothing in a dry run", async () => {
    const engine = new DayEngine({
      pool,
      broker: broker as unknown as ConstructorParameters<typeof DayEngine>[0]["broker"],
      data: data as unknown as ConstructorParameters<typeof DayEngine>[0]["data"],
      observer,
      accountId,
      strategy: new OpeningRangeBreakout(),
      tradingBaseUrl: "https://paper-api.alpaca.markets",
      reconcileEvery: 1,
      dryRun: true,
    });

    const outcome = await engine.cycle(AT_ELEVEN);
    assert.equal(outcome.signals, 1, "it still decided");
    assert.equal(broker.submitted.length, 0, "and submitted nothing");
    const { rows } = await pool.query(`SELECT 1 FROM orders WHERE account_id = $1`, [accountId]);
    assert.equal(rows.length, 0);
  });

  it("suppresses on the cause, not on the wording, as prices move", async () => {
    // Same rule declining every time, but the message carries a live price that
    // changes on every bar. De-duplicating on the text would write a row per
    // bar; on the cause it writes one.
    const engine = engineFor();
    for (let i = 0; i < 3; i += 1) {
      const flat: IntradayBarRow[] = [];
      for (let j = 0; j < 32; j += 1) flat.push(bar(j));
      // Each cycle sees a different last close — still under the range high.
      flat.push(bar(32 + i, { close: 100.1 + i * 0.05, high: 100.2, low: 100 }));
      data.bars = new Map([[symbol, flat]]);
      await engine.cycle(AT_ELEVEN);
    }

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM activity_log WHERE account_id = $1 AND kind = 'scan'`,
      [accountId],
    );
    assert.equal(Number(rows[0]!.count), 1, "one cause, one entry, whatever the price did");
  });

  it("records the reason a symbol was passed over, once per change of reason", async () => {
    // Flat bars all session: a valid range, no breakout.
    const flat: IntradayBarRow[] = [];
    for (let i = 0; i < 32; i += 1) flat.push(bar(i));
    data.bars = new Map([[symbol, flat]]);

    const engine = engineFor();
    await engine.cycle(AT_ELEVEN);
    await engine.cycle(AT_ELEVEN);
    await engine.cycle(AT_ELEVEN);

    const { rows } = await pool.query<{ message: string; detail: { code?: string } }>(
      `SELECT message, detail FROM activity_log WHERE account_id = $1 AND kind = 'scan'`,
      [accountId],
    );
    assert.equal(rows.length, 1, "three identical scans are one feed entry");
    assert.match(rows[0]!.message, /has not closed above the range high/);
    assert.equal(rows[0]!.detail.code, "no_breakout");
  });
});
