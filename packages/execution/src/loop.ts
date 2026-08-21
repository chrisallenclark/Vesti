/**
 * One autonomous session.
 *
 * Signal → construction → risk → gate → venue → fill → ledger → mark, run
 * unattended and idempotent so a scheduler can invoke it and a re-run after a
 * crash finishes the job rather than doubling it.
 *
 * The order of the phases is the design, and most of it is about refusing:
 *
 *   1. RECONCILE FIRST, and refuse to trade if it fails. Trading on a ledger
 *      that disagrees with the broker means sizing against a portfolio that
 *      does not exist and exiting lots that may not be there. A drift is a stop
 *      condition, not a warning to log and continue past.
 *   2. KILL SWITCH, per session as well as per order. The gate catches it at
 *      submission; checking here means a halted account does no work at all.
 *   3. EXITS BEFORE ENTRIES. An exit frees risk budget and cash that an entry
 *      may need, and more importantly a stop that fires must never lose a race
 *      with a new position for a per-session cap.
 *   4. PROMOTION GATE. A strategy trades only at `paper_approved` or above.
 *      With nothing promoted the loop runs, marks equity, and opens nothing —
 *      which is the correct behaviour for a system whose Strategy Lab does not
 *      exist yet, not a failure to do anything.
 *   5. MARK EQUITY ALWAYS, including on the sessions it refuses to trade. The
 *      curve is the deliverable; a gap in it cannot be filled in later.
 *
 * What it deliberately does NOT do is decide whether a strategy is any good.
 * Promotion is Phase 4's deterministic gate. This runs what it is told to run.
 */

import pg from "pg";
import { guardedBroker } from "@vesti/core/broker/guard.ts";
import { isTradingDay, previousTradingDay } from "@vesti/core/market/calendar.ts";
import { DEFAULT_LIMITS, evaluate } from "@vesti/core/risk/engine.ts";
import type { MandateKind, MarketState, PortfolioState, RiskLimits } from "@vesti/core/risk/types.ts";
import {
  TRADEABLE_ON_PAPER,
  type Strategy,
  type StrategyBar,
  type StrategyContext,
  type StrategyPosition,
  type StrategySignal,
  type StrategyStatus,
} from "@vesti/core/strategy/types.ts";
import type { BrokerAdapter } from "@vesti/core/broker/types.ts";
import type { FillPollingBroker } from "./fills.ts";
import { snapshotEquity, type MandateSnapshot } from "./equity.ts";
import { pollFills } from "./fills.ts";
import { isKillSwitchTripped, killSwitchState } from "./killswitch.ts";
import { OrderLedger } from "./ledger.ts";
import { reconcile } from "./reconcile.ts";
import { findSelfCrosses } from "./selfcross.ts";

/** Everything a session needs from a venue. Structural, so tests can drive it. */
export type SessionBroker = BrokerAdapter & FillPollingBroker;

export interface LoopOptions {
  pool: pg.Pool;
  broker: SessionBroker;
  accountId: string;
  /** Strategies to consider. Each still has to clear the promotion gate. */
  strategies: readonly Strategy[];
  /** Session being decided. Defaults to the last completed trading day. */
  asOf?: string;
  limits?: RiskLimits;
  /**
   * How stale a clean reconciliation may be before the loop refuses to trade.
   * Generous by default — a daily loop reconciles at the start of every run —
   * but not unbounded, because "we checked at some point" is not a control.
   */
  maxReconciliationAgeHours?: number;
  /** Report only. Everything is computed and nothing is submitted. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface LoopOutcome {
  asOf: string;
  traded: boolean;
  /** Why nothing was submitted, when nothing was. */
  haltReason: string | null;
  reconciled: boolean;
  signalsConsidered: number;
  ordersSubmitted: Array<{ orderId: string; symbol: string; side: string; quantity: number }>;
  refusals: Array<{ symbol: string; side: string; reason: string }>;
  snapshots: MandateSnapshot[];
}

const HOUR_MS = 60 * 60 * 1000;

export async function runSession(options: LoopOptions): Promise<LoopOutcome> {
  const {
    pool,
    broker,
    accountId,
    strategies,
    limits = DEFAULT_LIMITS,
    maxReconciliationAgeHours = 24,
    dryRun = false,
  } = options;
  const log = options.log ?? (() => {});
  const ledger = new OrderLedger(pool);

  // Defaults to the last completed session, never today: a strategy deciding
  // from a bar that is still forming is reading a number that will change.
  const asOf = options.asOf ?? previousTradingDay(new Date().toISOString().slice(0, 10));

  const outcome: LoopOutcome = {
    asOf,
    traded: false,
    haltReason: null,
    reconciled: false,
    signalsConsidered: 0,
    ordersSubmitted: [],
    refusals: [],
    snapshots: [],
  };

  const halt = async (reason: string): Promise<LoopOutcome> => {
    outcome.haltReason = reason;
    log(`halt: ${reason}`);
    // Marked even on a halt. A session where nothing traded is still a point on
    // the curve, and leaving it out would make a flat stretch indistinguishable
    // from an outage.
    outcome.snapshots = await snapshotEquity(pool, { accountId, asOf });
    return outcome;
  };

  if (!isTradingDay(asOf)) return halt(`${asOf} is not a trading day`);

  // ── 1. Reconcile ────────────────────────────────────────────────────────
  const positions = await broker.listPositions();
  const account = await broker.getAccount();
  const report = await reconcile(pool, { accountId, positions });
  await pool.query(
    `INSERT INTO reconciliation_runs (account_id, balanced, positions_checked, discrepancies)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [accountId, report.balanced, report.positionsChecked, JSON.stringify(report.discrepancies)],
  );
  outcome.reconciled = report.balanced;

  if (!report.balanced) {
    for (const d of report.discrepancies) {
      log(`  ${d.kind} ${d.symbol ?? ""}: ledger ${d.ledger} vs broker ${d.broker}`);
    }
    return halt(
      `ledger does not agree with the broker (${report.discrepancies.length} discrepancies)`,
    );
  }

  const lastClean = await lastCleanReconciliation(pool, accountId);
  if (lastClean && Date.now() - lastClean.getTime() > maxReconciliationAgeHours * HOUR_MS) {
    return halt(`last clean reconciliation is older than ${maxReconciliationAgeHours}h`);
  }

  // ── 2. Kill switch ──────────────────────────────────────────────────────
  if (await isKillSwitchTripped(pool, accountId)) {
    const state = await killSwitchState(pool, accountId);
    return halt(`kill switch tripped by ${state.trippedBy}: ${state.reason}`);
  }

  // ── 3. Catch up on anything that filled while we were not looking ───────
  const openOrders = await openOrderIds(pool, accountId);
  if (openOrders.length > 0) {
    log(`reconciling ${openOrders.length} open order(s) against the venue`);
    await pollFills(broker, ledger, openOrders, { onError: (e) => log(`  poll: ${String(e)}`) });
  }

  // ── 4. Signals ──────────────────────────────────────────────────────────
  const promoted = await promotedStrategies(pool, accountId, strategies);
  if (promoted.length === 0) {
    return halt(
      "no strategy is promoted to paper_approved — the loop ran, marked equity, and traded nothing",
    );
  }

  const universe = await universeSymbols(pool);
  const submitted: LoopOutcome["ordersSubmitted"] = [];

  for (const { strategy, strategyVersionId } of promoted) {
    const mandateId = await mandateIdFor(pool, accountId, strategy.mandate);
    if (!mandateId) {
      log(`no ${strategy.mandate} mandate on this account; skipping ${strategy.key}`);
      continue;
    }

    const bars = await loadPitBars(pool, {
      symbols: universe,
      asOf,
      sessions: strategy.warmupSessions + 10,
    });
    const positionsHeld = await mandatePositions(pool, { accountId, mandateId, asOf });

    const signals = strategy.evaluate({
      asOf,
      bars,
      positions: positionsHeld,
    } satisfies StrategyContext);
    outcome.signalsConsidered += signals.length;
    log(`${strategy.key}: ${signals.length} signal(s)`);

    // Exits first — see the header. An exit that loses a race with an entry is
    // a stop that did not fire.
    const ordered = [...signals].sort((a, b) => rank(a) - rank(b));

    for (const signal of ordered) {
      try {
        const placed = await actOnSignal({
          pool,
          ledger,
          broker,
          accountId,
          mandateId,
          mandateKind: strategy.mandate,
          strategyVersionId,
          signal,
          asOf,
          limits,
          account,
          dryRun,
          log,
        });
        if (placed) submitted.push(placed);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        outcome.refusals.push({
          symbol: signal.symbol,
          side: signal.kind === "exit" ? "sell" : signal.side,
          reason,
        });
        // One refused signal must not abandon the rest of the session — an
        // unsized entry is routine, and a stop later in the list still needs to
        // fire.
        log(`  refused ${signal.symbol}: ${reason}`);
      }
    }
  }

  outcome.ordersSubmitted = submitted;
  outcome.traded = submitted.length > 0;

  // ── 5. Mark ─────────────────────────────────────────────────────────────
  outcome.snapshots = await snapshotEquity(pool, { accountId, asOf });
  for (const snapshot of outcome.snapshots) {
    log(
      `${snapshot.mandateName}: equity $${snapshot.equity.toFixed(2)} ` +
        `(${snapshot.positionCount} position(s), realised $${snapshot.realizedPnl.toFixed(2)})`,
    );
  }

  return outcome;
}

function rank(signal: StrategySignal): number {
  return signal.kind === "exit" ? 0 : 1;
}

interface ActParams {
  pool: pg.Pool;
  ledger: OrderLedger;
  broker: SessionBroker;
  accountId: string;
  mandateId: string;
  mandateKind: MandateKind;
  strategyVersionId: string;
  signal: StrategySignal;
  asOf: string;
  limits: RiskLimits;
  account: { cash: number; equity: number };
  dryRun: boolean;
  log: (message: string) => void;
}

/**
 * Takes one signal all the way to a submitted order, or refuses it.
 *
 * Every refusal is thrown rather than returned as null, so the caller records
 * it. A signal that vanishes silently is indistinguishable from one that was
 * never produced, which makes "why didn't it take that trade?" unanswerable.
 */
async function actOnSignal(params: ActParams): Promise<LoopOutcome["ordersSubmitted"][number] | null> {
  const { pool, ledger, broker, accountId, mandateId, strategyVersionId, signal, asOf, dryRun, log } =
    params;

  const securityId = await securityIdFor(pool, signal.symbol);
  if (!securityId) throw new Error(`${signal.symbol} is not in securities`);

  const side = signal.kind === "exit" ? "sell" : signal.side;

  const crosses = await findSelfCrosses(pool, { accountId, securityId, side });
  if (crosses.length > 0) {
    throw new Error(
      `self-cross: ${crosses.map((c) => `${c.mandateName} ${c.side}`).join(", ")} already working`,
    );
  }

  const bars = await loadPitBars(pool, { symbols: [signal.symbol], asOf, sessions: 30 });
  const history = bars.get(signal.symbol) ?? [];
  const last = history.at(-1);
  if (!last) throw new Error(`no bars for ${signal.symbol} as of ${asOf}`);

  // The signal's own symbol is marked at the price the ruling references. The
  // reference is a PIT-adjusted close and the marks below come from raw
  // `bars_daily`, so on any symbol carrying an announced split the two disagree
  // — and the engine sizes a sell as market value over the reference price, so
  // the disagreement makes a full exit come back fractional and floor to fewer
  // shares than are held. A stop that sells all but one share is not a stop.
  const portfolio = await portfolioState(pool, accountId, params.account.cash, asOf, {
    [signal.symbol]: last.close,
  });
  const market: MarketState = {
    averageDollarVolume: averageDollarVolume(history),
    spreadFraction: 0.0005,
    atrFraction: atrFraction(history),
    // No measured expectancy exists until Phase 4 produces one. Null is the
    // honest value and the engine reads it as "no evidence to size up on".
    expectancyR: null,
    sampleSize: 0,
  };

  const held = await ledger.positionForMandate(accountId, mandateId, securityId);
  // Shares already committed to a working order on this side. A re-run of a
  // session whose exit has not filled yet would otherwise submit the exit a
  // second time, and two sells against one position is a short.
  const working = await ledger.workingQuantity({ accountId, mandateId, securityId, side });
  const requested =
    signal.kind === "exit"
      ? Math.min(signal.quantity, held.quantity - working)
      : Number.MAX_SAFE_INTEGER;
  if (signal.kind === "exit" && requested <= 0) {
    throw new Error(
      working > 0
        ? `an exit for ${working} share(s) is already working`
        : `nothing held in this mandate to exit`,
    );
  }

  const ruling = evaluate(
    {
      mandate: params.mandateKind,
      side,
      symbol: signal.symbol,
      sector: null,
      entryPrice: last.close,
      stopPrice: signal.kind === "entry" ? signal.stopPrice : null,
      targetPrice: signal.kind === "entry" ? signal.targetPrice : null,
      tier: signal.kind === "entry" ? signal.tier : "standard",
      isBinaryEvent: false,
    },
    portfolio,
    market,
    params.limits,
  );

  const quantity = Math.floor(Math.min(requested, ruling.approvedQuantity) + 1e-9);
  if (ruling.decision === "reject" || quantity < 1) {
    const why = ruling.violations.map((v) => v.code).join(", ") || "sized below one share";
    throw new Error(`risk engine: ${why}`);
  }

  if (dryRun) {
    log(`  would ${side} ${quantity} ${signal.symbol} (${signal.reasons.join("; ")})`);
    return null;
  }

  const orderId = await ledger.recordIntent({
    accountId,
    mandateId,
    securityId,
    side,
    kind: "market",
    quantity,
    timeInForce: "day",
    strategyVersionId,
  });
  const attached = await ledger.recordRiskRuling(orderId, {
    decision: ruling.decision,
    requestedQuantity: quantity,
    approvedQuantity: quantity,
    violations: ruling.violations,
    inputs: { asOf, entryPrice: last.close, reasons: signal.reasons },
    engineVersion: ruling.engineVersion,
  });

  const guarded = guardedBroker(broker, {
    isKillSwitchTripped: () => isKillSwitchTripped(pool, accountId),
    lookupRiskApproval: () => ({
      id: attached.riskEvaluationId,
      symbol: signal.symbol,
      side,
      approvedQuantity: quantity,
      decision: ruling.decision,
    }),
  });

  const state = await guarded.submitOrder({
    clientOrderId: orderId,
    symbol: signal.symbol,
    side,
    kind: "market",
    quantity,
    timeInForce: "day",
    riskEvaluationId: attached.riskEvaluationId,
  });
  await ledger.recordSubmission(orderId, state.brokerOrderId);
  log(`  ${side} ${quantity} ${signal.symbol} -> ${state.brokerOrderId}`);

  return { orderId, symbol: signal.symbol, side, quantity };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Bars through the PIT layer, as of the session's own close.
 *
 * Deliberately NOT a plain read of `bars_daily`. Going through
 * `pit_bars_daily` means the strategy sees split adjustments exactly as they
 * were knowable on the day, so the live loop and the backtester are looking at
 * the same series — which is the only thing that makes a backtest a prediction
 * about this code rather than about different code.
 */
async function loadPitBars(
  pool: pg.Pool,
  params: { symbols: readonly string[]; asOf: string; sessions: number },
): Promise<Map<string, StrategyBar[]>> {
  const bars = new Map<string, StrategyBar[]>();
  if (params.symbols.length === 0) return bars;

  const { rows } = await pool.query<{
    symbol: string;
    session_date: Date;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>(
    `SELECT s.symbol, p.session_date, p.open, p.high, p.low, p.close, p.volume
       FROM securities s
       JOIN LATERAL (
         SELECT * FROM pit_bars_daily(($2::date + 1)::timestamptz, s.id)
          ORDER BY session_date DESC LIMIT $3
       ) p ON true
      WHERE s.symbol = ANY($1) AND s.delisted_at IS NULL
      ORDER BY s.symbol, p.session_date`,
    [params.symbols, params.asOf, params.sessions],
  );

  for (const row of rows) {
    const list = bars.get(row.symbol) ?? [];
    list.push({
      sessionDate: row.session_date.toISOString().slice(0, 10),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    });
    bars.set(row.symbol, list);
  }
  return bars;
}

async function mandatePositions(
  pool: pg.Pool,
  params: { accountId: string; mandateId: string; asOf: string },
): Promise<StrategyPosition[]> {
  const { rows } = await pool.query<{
    symbol: string;
    quantity: string;
    cost: string;
    stop_price: string | null;
    opened_at: Date;
  }>(
    `SELECT s.symbol,
            sum(l.remaining)                AS quantity,
            sum(l.remaining * l.cost_basis) AS cost,
            min(l.stop_price)               AS stop_price,
            min(l.opened_at)                AS opened_at
       FROM lots l
       JOIN securities s ON s.id = l.security_id
      WHERE l.account_id = $1 AND l.mandate_id = $2 AND l.remaining > 0
      GROUP BY s.symbol`,
    [params.accountId, params.mandateId],
  );

  return rows.map((row) => {
    const quantity = Number(row.quantity);
    const opened = row.opened_at.toISOString().slice(0, 10);
    return {
      symbol: row.symbol,
      quantity,
      averageCost: Number(row.cost) / quantity,
      stopPrice: row.stop_price === null ? null : Number(row.stop_price),
      sessionsHeld: Math.max(0, countTradingDays(opened, params.asOf)),
    };
  });
}

function countTradingDays(from: string, to: string): number {
  let count = 0;
  let cursor = from;
  while (cursor < to && count < 5000) {
    cursor = nextDay(cursor);
    if (isTradingDay(cursor)) count += 1;
  }
  return count;
}

function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Strategies the database has promoted to paper or beyond.
 *
 * The registry is code and the promotion is data, on purpose. A strategy's
 * rules must be reviewable and versioned in the repository; whether it is
 * allowed to trade is an operational state that changes without a deploy — and
 * being able to pause one at 3pm without shipping is the point.
 */
async function promotedStrategies(
  pool: pg.Pool,
  accountId: string,
  strategies: readonly Strategy[],
): Promise<{ strategy: Strategy; strategyVersionId: string }[]> {
  if (strategies.length === 0) return [];

  // `strategy_versions` is append-only, so a promotion is a NEW row rather than
  // a status update — the ladder a strategy climbed stays readable, which is
  // the point of the table. `version` therefore counts revisions of the record,
  // and the identity of the RULES lives in `spec.code_version`. The current
  // standing of a rule set is the status on its highest revision.
  const { rows } = await pool.query<{
    id: string;
    slug: string;
    code_version: string | null;
    status: StrategyStatus;
  }>(
    // Scoped to the account's OWNER, not just the slug. `strategies` is keyed
    // (user_id, slug), so two users can hold the same slug at different rungs —
    // and matching on slug alone would let one account's promotion authorise
    // trading on another's.
    `SELECT DISTINCT ON (st.slug, sv.spec->>'code_version')
            sv.id, st.slug, sv.spec->>'code_version' AS code_version, sv.status
       FROM strategy_versions sv
       JOIN strategies st ON st.id = sv.strategy_id
       JOIN accounts a    ON a.user_id = st.user_id
      WHERE a.id = $2 AND st.slug = ANY($1)
      ORDER BY st.slug, sv.spec->>'code_version', sv.version DESC`,
    [strategies.map((s) => s.key), accountId],
  );

  // The VERSION ID travels with the strategy, not just its name. Every order
  // has to record which strategy placed it: an order without one opens a lot
  // without one, and a lot no engine claims is a position nothing will ever
  // exit. Returning the pair here is what makes that impossible to forget at
  // the call site.
  const promoted = new Map(
    rows
      .filter((row) => TRADEABLE_ON_PAPER.has(row.status))
      .map((row) => [`${row.slug}@${row.code_version}`, row.id] as const),
  );
  return strategies.flatMap((strategy) => {
    const strategyVersionId = promoted.get(`${strategy.key}@${strategy.version}`);
    return strategyVersionId ? [{ strategy, strategyVersionId }] : [];
  });
}

async function universeSymbols(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ symbol: string }>(
    `SELECT DISTINCT s.symbol
       FROM securities s
       JOIN bars_daily b ON b.security_id = s.id
      WHERE s.delisted_at IS NULL AND s.is_tradable
      ORDER BY s.symbol`,
  );
  return rows.map((r) => r.symbol);
}

async function securityIdFor(pool: pg.Pool, symbol: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM securities WHERE symbol = $1 AND delisted_at IS NULL`,
    [symbol],
  );
  return rows[0]?.id ?? null;
}

async function mandateIdFor(
  pool: pg.Pool,
  accountId: string,
  kind: MandateKind,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT m.id FROM mandates m JOIN accounts a ON a.user_id = m.user_id
      WHERE a.id = $1 AND m.kind = $2`,
    [accountId, kind],
  );
  return rows[0]?.id ?? null;
}

async function openOrderIds(pool: pg.Pool, accountId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE account_id = $1 AND status IN ('pending_new', 'working', 'partially_filled')`,
    [accountId],
  );
  return rows.map((r) => r.id);
}

async function lastCleanReconciliation(pool: pg.Pool, accountId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ ran_at: Date }>(
    `SELECT ran_at FROM reconciliation_runs
      WHERE account_id = $1 AND balanced ORDER BY ran_at DESC LIMIT 1`,
    [accountId],
  );
  return rows[0]?.ran_at ?? null;
}

async function portfolioState(
  pool: pg.Pool,
  accountId: string,
  brokerCash: number,
  asOf: string,
  /** Overrides the price a symbol is valued at. See the call site. */
  marks: Readonly<Record<string, number>> = {},
): Promise<PortfolioState> {
  const { rows } = await pool.query<{
    mandate_kind: MandateKind;
    symbol: string;
    quantity: string;
    cost: string;
    stop: string | null;
    close: string | null;
  }>(
    `SELECT m.kind AS mandate_kind, s.symbol,
            sum(l.remaining)                AS quantity,
            sum(l.remaining * l.cost_basis) AS cost,
            min(l.stop_price)               AS stop,
            max(p.close)                    AS close
       FROM lots l
       JOIN mandates m   ON m.id = l.mandate_id
       JOIN securities s ON s.id = l.security_id
       LEFT JOIN LATERAL (
         SELECT b.close FROM bars_daily b
          WHERE b.security_id = l.security_id AND b.session_date <= $2::date
          ORDER BY b.session_date DESC LIMIT 1
       ) p ON true
      WHERE l.account_id = $1 AND l.remaining > 0
      GROUP BY m.kind, s.symbol`,
    [accountId, asOf],
  );

  const mandateEquity: Record<MandateKind, number> = { active: 0, catalyst: 0, long_term: 0 };
  const positions = rows.map((row) => {
    const quantity = Number(row.quantity);
    const cost = Number(row.cost);
    // Market value, not cost. The engine derives sellable size from market
    // value over the reference price, so cost basis here makes an exit of a
    // position whose price has moved come back fractional and get refused.
    const mark = marks[row.symbol] ?? (row.close === null ? null : Number(row.close));
    const marketValue = mark === null ? cost : quantity * mark;
    mandateEquity[row.mandate_kind] += marketValue;
    const stop = row.stop === null ? null : Number(row.stop);
    return {
      symbol: row.symbol,
      sector: null,
      mandate: row.mandate_kind,
      marketValue,
      openRisk: stop === null ? 0 : Math.max(0, marketValue - stop * quantity),
      isBinaryEvent: false,
    };
  });

  const { rows: weights } = await pool.query<{ kind: MandateKind; target_weight: string }>(
    `SELECT m.kind, m.target_weight FROM mandates m
      JOIN accounts a ON a.user_id = m.user_id WHERE a.id = $1`,
    [accountId],
  );
  for (const weight of weights) {
    mandateEquity[weight.kind] += brokerCash * Number(weight.target_weight);
  }

  const invested = positions.reduce((sum, p) => sum + p.marketValue, 0);
  return {
    totalEquity: brokerCash + invested,
    cash: brokerCash,
    mandateEquity,
    positions,
    drawdown: 0,
    dayPnl: 0,
    openPositionCount: positions.length,
  };
}

function averageDollarVolume(bars: readonly StrategyBar[]): number {
  const recent = bars.slice(-20);
  if (recent.length === 0) return 0;
  return recent.reduce((sum, b) => sum + b.close * b.volume, 0) / recent.length;
}

function atrFraction(bars: readonly StrategyBar[]): number {
  const recent = bars.slice(-20);
  if (recent.length === 0) return 0.02;
  return recent.reduce((sum, b) => sum + (b.high - b.low) / b.close, 0) / recent.length;
}
