/**
 * The autonomous session, and mostly its refusals.
 *
 * A loop that trades is easy. A loop that can be left running is one that stops
 * itself for the right reasons, and every one of those reasons is exercised
 * here against a real database: an unreconciled ledger, a tripped kill switch,
 * an unpromoted strategy, a non-trading day.
 *
 * The kill switch case is the one worth being blunt about. It has been read on
 * every order since the gate was written and had never once been set, which
 * makes it a claim rather than a control. Here it is tripped, a real order is
 * driven at the gate, and the refusal is required.
 *
 * Runs entirely offline against a stub broker. Needs Postgres, not the internet.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { guardedBroker } from "@vesti/core/broker/guard.ts";
import { OrderRefusedError } from "@vesti/core/broker/types.ts";
import type {
  BrokerAccount,
  BrokerOrderRequest,
  BrokerOrderState,
  BrokerPosition,
} from "@vesti/core/broker/types.ts";
import type { Strategy, StrategyContext, StrategySignal } from "@vesti/core/strategy/types.ts";
import { runSession, type SessionBroker } from "./loop.ts";
import { isKillSwitchTripped, killSwitchState, resetKillSwitch, tripKillSwitch } from "./killswitch.ts";
import { promoteStrategy, registerStrategy } from "./strategy-registry.ts";
import { snapshotEquity } from "./equity.ts";

const execFileAsync = promisify(execFile);
const DB_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const TEST_DB = process.env.VESTI_LOOP_TEST_DB ?? "vesti_loop_test";
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;
const TEST_URL = testUrl.toString();

/** A Thursday. Chosen so the calendar agrees it is a session. */
const AS_OF = "2026-03-05";

let admin: pg.Client;
let pool: pg.Pool;
/**
 * The registry connects as vesti_research, because vesti_execution cannot write
 * `strategies` — the role that trades is deliberately unable to promote a
 * strategy to tradeable. An execution service that could authorise its own
 * strategies would make the promotion ladder decorative.
 */
let researchPool: pg.Pool;

let userId: string;
let accountId: string;
let activeMandateId: string;
let securityId: string;
let symbol: string;

/** A strategy that always wants to buy, so the loop's refusals are what is under test. */
class AlwaysBuy implements Strategy {
  readonly key = "test.always_buy";
  readonly version = 1;
  readonly mandate = "active" as const;
  readonly warmupSessions = 0;
  readonly describe = "Buys the first symbol it sees. Test fixture.";
  constructor(private readonly target: () => string) {}
  evaluate(context: StrategyContext): StrategySignal[] {
    const target = this.target();
    const bars = context.bars.get(target);
    if (!bars || bars.length === 0) return [];
    const last = bars.at(-1)!;
    return [
      {
        kind: "entry",
        symbol: target,
        side: "buy",
        stopPrice: Number((last.close * 0.9).toFixed(2)),
        targetPrice: null,
        tier: "experimental",
        reasons: ["test fixture"],
      },
    ];
  }
}

/** A venue that accepts everything and reports whatever positions it is told to. */
class StubBroker implements SessionBroker {
  readonly name = "stub";
  positions: BrokerPosition[] = [];
  cash = 100_000;
  readonly submitted: BrokerOrderRequest[] = [];
  private counter = 0;

  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrderState> {
    this.submitted.push(request);
    return {
      brokerOrderId: `stub-${++this.counter}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      kind: request.kind,
      quantity: request.quantity,
      filledQuantity: 0,
      averageFillPrice: null,
      limitPrice: request.limitPrice ?? null,
      stopPrice: request.stopPrice ?? null,
      timeInForce: request.timeInForce,
      status: "working",
      submittedSession: AS_OF,
    };
  }
  async cancelOrder(id: string): Promise<BrokerOrderState> {
    throw new Error(`not used: ${id}`);
  }
  async getOrder(): Promise<BrokerOrderState | null> {
    return null;
  }
  async getOrderByClientId(): Promise<BrokerOrderState | null> {
    return null;
  }
  async listOpenOrders(): Promise<BrokerOrderState[]> {
    return [];
  }
  async listPositions(): Promise<BrokerPosition[]> {
    return this.positions;
  }
  async getAccount(): Promise<BrokerAccount> {
    return { cash: this.cash, buyingPower: this.cash, equity: this.cash };
  }
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

  const executionUrl = new URL(TEST_URL);
  executionUrl.username = "vesti_execution";
  executionUrl.password = process.env.VESTI_EXECUTION_PASSWORD ?? "";
  pool = new pg.Pool({ connectionString: executionUrl.toString(), max: 4 });

  const researchUrl = new URL(TEST_URL);
  researchUrl.username = "vesti_research";
  researchUrl.password = process.env.VESTI_RESEARCH_PASSWORD ?? "";
  researchPool = new pg.Pool({ connectionString: researchUrl.toString(), max: 2 });
});

after(async () => {
  await pool?.end();
  await researchPool?.end();
  await admin?.end();
});

let fixture = 0;

beforeEach(async () => {
  const n = ++fixture;
  symbol = `LP${n}`;

  const { rows: users } = await admin.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, 'Loop') RETURNING id`,
    [`loop-${n}@example.com`],
  );
  userId = users[0]!.id;

  const { rows: mandates } = await admin.query<{ id: string; kind: string }>(
    `INSERT INTO mandates (user_id, kind, name, target_weight)
     VALUES ($1, 'active', 'Active', 0.5), ($1, 'long_term', 'Long-Term', 0.5)
     RETURNING id, kind`,
    [userId],
  );
  activeMandateId = mandates.find((m) => m.kind === "active")!.id;

  const { rows: accounts } = await admin.query<{ id: string }>(
    `INSERT INTO accounts (user_id, broker, external_id, is_live)
     VALUES ($1, 'stub', $2, false) RETURNING id`,
    [userId, `ACCT-${n}`],
  );
  accountId = accounts[0]!.id;

  const { rows: sources } = await admin.query<{ id: string }>(
    `SELECT id FROM sources WHERE slug = 'synthetic'`,
  );
  const { rows: securities } = await admin.query<{ id: string }>(
    `INSERT INTO securities (symbol, asset_class, source_id) VALUES ($1, 'equity', $2) RETURNING id`,
    [symbol, sources[0]!.id],
  );
  securityId = securities[0]!.id;

  // A short, calm history. The loop reads it through pit_bars_daily, so the
  // observed_at stamps have to be in the past for any of it to be visible.
  await admin.query(`SELECT vesti_ensure_daily_partition(2026)`);
  for (let i = 0; i < 40; i += 1) {
    const date = new Date(Date.UTC(2026, 0, 5));
    date.setUTCDate(date.getUTCDate() + i);
    const iso = date.toISOString().slice(0, 10);
    const close = 100 + i * 0.25;
    await admin.query(
      `INSERT INTO bars_daily
         (security_id, session_date, open, high, low, close, volume, tape, source_id, observed_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, 8000000, 'synthetic', $7,
               ($2::date + interval '22 hours') AT TIME ZONE 'UTC')`,
      [securityId, iso, close - 0.2, close + 0.8, close - 0.9, close, sources[0]!.id],
    );
  }
});

async function promoteAlwaysBuy(strategy: Strategy): Promise<void> {
  await registerStrategy(researchPool, { userId, strategy });
  await promoteStrategy(researchPool, {
    userId,
    slug: strategy.key,
    codeVersion: strategy.version,
    to: "validating",
    rationale: "test",
  });
  await promoteStrategy(researchPool, {
    userId,
    slug: strategy.key,
    codeVersion: strategy.version,
    to: "paper_approved",
    rationale: "test",
  });
}

describe("the session refuses for the right reasons", () => {
  it("marks equity but trades nothing when no strategy is promoted", async () => {
    // The correct behaviour for a system whose Strategy Lab does not exist yet.
    // Not an error, and emphatically not a reason to skip the mark.
    const broker = new StubBroker();
    const outcome = await runSession({
      pool,
      broker,
      accountId,
      strategies: [new AlwaysBuy(() => symbol)],
      asOf: AS_OF,
    });

    assert.equal(outcome.traded, false);
    assert.match(outcome.haltReason ?? "", /no strategy is promoted/);
    assert.equal(broker.submitted.length, 0);
    assert.equal(outcome.snapshots.length, 2, "both mandates marked even on a halt");
  });

  it("refuses to trade on a ledger that disagrees with the broker", async () => {
    // Sizing against a portfolio that does not exist, and exiting lots that may
    // not be there. A drift is a stop condition, not a warning.
    const strategy = new AlwaysBuy(() => symbol);
    await promoteAlwaysBuy(strategy);

    const broker = new StubBroker();
    broker.positions = [{ symbol: "GHOST", quantity: 500, averageCost: 10 }];

    const outcome = await runSession({
      pool,
      broker,
      accountId,
      strategies: [strategy],
      asOf: AS_OF,
    });

    assert.equal(outcome.reconciled, false);
    assert.match(outcome.haltReason ?? "", /does not agree with the broker/);
    assert.equal(broker.submitted.length, 0, "nothing may be submitted on a drifted ledger");

    const { rows } = await admin.query<{ balanced: boolean }>(
      `SELECT balanced FROM reconciliation_runs WHERE account_id = $1`,
      [accountId],
    );
    assert.deepEqual(rows.map((r) => r.balanced), [false], "the failed run is recorded");
  });

  it("does nothing at all while the kill switch is tripped", async () => {
    const strategy = new AlwaysBuy(() => symbol);
    await promoteAlwaysBuy(strategy);
    await tripKillSwitch(pool, {
      accountId,
      reason: "drawdown limit breached",
      by: "operator",
    });

    const broker = new StubBroker();
    const outcome = await runSession({
      pool,
      broker,
      accountId,
      strategies: [strategy],
      asOf: AS_OF,
    });

    assert.match(outcome.haltReason ?? "", /kill switch tripped by operator/);
    assert.equal(broker.submitted.length, 0);
  });

  it("skips a day the market was closed", async () => {
    const broker = new StubBroker();
    const outcome = await runSession({
      pool,
      broker,
      accountId,
      strategies: [],
      asOf: "2026-01-01",
    });
    assert.match(outcome.haltReason ?? "", /not a trading day/);
  });

  it("submits when everything is clean and a strategy is promoted", async () => {
    const strategy = new AlwaysBuy(() => symbol);
    await promoteAlwaysBuy(strategy);

    const broker = new StubBroker();
    const outcome = await runSession({
      pool,
      broker,
      accountId,
      strategies: [strategy],
      asOf: AS_OF,
    });

    assert.equal(outcome.haltReason, null);
    assert.equal(outcome.traded, true);
    assert.equal(broker.submitted.length, 1);
    assert.equal(broker.submitted[0]!.symbol, symbol);
    assert.ok(broker.submitted[0]!.quantity >= 1);
    // Every submitted order carries the evaluation that authorised it — the
    // database would have rejected the order otherwise, but asserting it here
    // pins the loop rather than the trigger.
    assert.ok(broker.submitted[0]!.riskEvaluationId);
  });

  it("computes but submits nothing on a dry run", async () => {
    const strategy = new AlwaysBuy(() => symbol);
    await promoteAlwaysBuy(strategy);

    const broker = new StubBroker();
    const outcome = await runSession({
      pool,
      broker,
      accountId,
      strategies: [strategy],
      asOf: AS_OF,
      dryRun: true,
    });

    assert.equal(outcome.signalsConsidered, 1);
    assert.equal(broker.submitted.length, 0);
  });
});

describe("the kill switch, actually tripped", () => {
  it("makes the execution gate refuse a real order", async () => {
    // The assertion that turns the switch from a claim into a control: not that
    // the boolean reads true, but that an order driven at the gate is refused.
    await tripKillSwitch(pool, { accountId, reason: "halt", by: "operator" });

    const broker = guardedBroker(new StubBroker(), {
      isKillSwitchTripped: () => isKillSwitchTripped(pool, accountId),
      lookupRiskApproval: () => ({
        id: "any",
        symbol,
        side: "buy",
        approvedQuantity: 100,
        decision: "approve",
      }),
    });

    await assert.rejects(
      () =>
        broker.submitOrder({
          clientOrderId: "blocked",
          symbol,
          side: "buy",
          kind: "market",
          quantity: 1,
          timeInForce: "day",
          riskEvaluationId: "any",
        }),
      (error: unknown) =>
        error instanceof OrderRefusedError && error.code === "kill_switch_tripped",
    );
  });

  it("keeps the first reason when tripped twice", async () => {
    // An automatic re-trip must not bury the human note that says what actually
    // went wrong.
    await tripKillSwitch(pool, { accountId, reason: "operator saw something", by: "human" });
    await tripKillSwitch(pool, { accountId, reason: "daily loss limit", by: "auto" });
    const state = await killSwitchState(pool, accountId);
    assert.equal(state.reason, "operator saw something");
    assert.equal(state.trippedBy, "human");
  });

  it("will not reset without quoting back the reason", async () => {
    // The way a kill switch fails is being cleared by whoever is most
    // inconvenienced by it, before anyone established what happened.
    await tripKillSwitch(pool, { accountId, reason: "unexplained drift", by: "auto" });

    await assert.rejects(
      () => resetKillSwitch(pool, { accountId, by: "operator", acknowledgedReason: "whatever" }),
      /Refusing to reset/,
    );

    const cleared = await resetKillSwitch(pool, {
      accountId,
      by: "operator",
      acknowledgedReason: "unexplained drift",
    });
    assert.equal(cleared.isTripped, false);
  });
});

describe("the promotion ladder", () => {
  it("registers at experimental and refuses to trade there", async () => {
    const strategy = new AlwaysBuy(() => symbol);
    const registered = await registerStrategy(researchPool, { userId, strategy });
    assert.equal(registered.status, "experimental");

    const broker = new StubBroker();
    const outcome = await runSession({
      pool,
      broker,
      accountId,
      strategies: [strategy],
      asOf: AS_OF,
    });
    assert.match(outcome.haltReason ?? "", /no strategy is promoted/);
  });

  it("refuses to skip a rung", async () => {
    const strategy = new AlwaysBuy(() => symbol);
    await registerStrategy(researchPool, { userId, strategy });
    await assert.rejects(
      () =>
        promoteStrategy(researchPool, {
          userId,
          slug: strategy.key,
          codeVersion: 1,
          to: "paper_approved",
          rationale: "in a hurry",
        }),
      /One rung at a time/,
    );
  });

  it("refuses to reach live by hand at all", async () => {
    const strategy = new AlwaysBuy(() => symbol);
    await registerStrategy(researchPool, { userId, strategy });
    await assert.rejects(
      () =>
        promoteStrategy(researchPool, {
          userId,
          slug: strategy.key,
          codeVersion: 1,
          to: "live_scaled",
          rationale: "confident",
        }),
      /not reachable by hand/,
    );
  });

  it("requires a rationale, because it is the only record of why", async () => {
    const strategy = new AlwaysBuy(() => symbol);
    await registerStrategy(researchPool, { userId, strategy });
    await assert.rejects(
      () =>
        promoteStrategy(researchPool, {
          userId,
          slug: strategy.key,
          codeVersion: 1,
          to: "validating",
          rationale: "   ",
        }),
      /needs a rationale/,
    );
  });

  it("keeps the ladder a strategy climbed", async () => {
    // strategy_versions is append-only, so promotion appends. That history is
    // the point: when a live strategy turns out to be bad, who moved it and why
    // is the first question.
    const strategy = new AlwaysBuy(() => symbol);
    await registerStrategy(researchPool, { userId, strategy });
    await promoteStrategy(researchPool, {
      userId,
      slug: strategy.key,
      codeVersion: 1,
      to: "validating",
      rationale: "passed a smoke test",
    });
    await promoteStrategy(researchPool, {
      userId,
      slug: strategy.key,
      codeVersion: 1,
      to: "paper_approved",
      rationale: "ready for forward paper",
    });

    const { rows } = await admin.query<{ status: string; rationale: string }>(
      // Scoped to this fixture's user: `strategies` is keyed (user_id, slug),
      // so every test in this file owns its own copy of the same slug.
      `SELECT sv.status, sv.rationale FROM strategy_versions sv
         JOIN strategies st ON st.id = sv.strategy_id
        WHERE st.slug = $1 AND st.user_id = $2 ORDER BY sv.version`,
      [strategy.key, userId],
    );
    assert.deepEqual(
      rows.map((r) => r.status),
      ["experimental", "validating", "paper_approved"],
    );
    assert.equal(rows[2]!.rationale, "ready for forward paper");
  });

  it("re-registering does not demote a promoted strategy", async () => {
    // A deploy that runs `--register` on boot must not silently undo a
    // promotion.
    const strategy = new AlwaysBuy(() => symbol);
    await promoteAlwaysBuy(strategy);
    const again = await registerStrategy(researchPool, { userId, strategy });
    assert.equal(again.status, "paper_approved");
  });
});

describe("equity snapshots", () => {
  it("records one row per mandate and is idempotent on a re-run", async () => {
    const first = await snapshotEquity(pool, { accountId, asOf: AS_OF });
    const second = await snapshotEquity(pool, { accountId, asOf: AS_OF });
    assert.equal(first.length, 2);
    assert.deepEqual(
      first.map((s) => s.mandateName),
      second.map((s) => s.mandateName),
    );

    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM equity_snapshots WHERE account_id = $1 AND as_of = $2::date`,
      [accountId, AS_OF],
    );
    assert.equal(Number(rows[0]!.n), 2, "a re-run must update, not append");
  });
});
