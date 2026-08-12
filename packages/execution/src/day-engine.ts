/**
 * The DAY engine: one cycle of the autonomous intraday loop.
 *
 * This is the milestone the whole repository was building toward — real market
 * data → strategy → risk → gate → venue → fill → ledger → dashboard — running
 * unattended while somebody watches it.
 *
 * It reuses, rather than reimplements, everything that already worked: the
 * deterministic risk engine, `guardedBroker`, `OrderLedger`, the fill poller,
 * reconciliation, the kill switch. What is new here is only the parts that a
 * daily batch did not need — an intraday clock, a per-cycle view of positions
 * this engine actually opened, and observability.
 *
 * The order of the phases is the design, and most of it is about refusing:
 *
 *   1. FILLS FIRST, always, before anything else and regardless of everything
 *      else. A fill that has not been posted is a position with no stop
 *      watching it. This runs even when the market is closed, even when the
 *      kill switch is tripped, and even when the ledger is out of balance —
 *      posting a fill is how an out-of-balance ledger gets back INTO balance,
 *      so gating it behind reconciliation would be a deadlock.
 *
 *   2. RECONCILE, and refuse to trade if it fails. Sizing against a portfolio
 *      that does not exist is worse than not trading. Checked periodically
 *      rather than every cycle: it is two round trips and the ledger cannot
 *      drift between them without a fill, which phase 1 already caught.
 *
 *   3. KILL SWITCH. Checked here as well as inside the gate, so a halted
 *      account does no work at all rather than doing all of it and being
 *      refused at the last step.
 *
 *   4. PROMOTION GATE. The strategy trades only at `paper_approved` or above,
 *      and that is database state rather than code, so it can be revoked at
 *      3pm without a deploy.
 *
 *   5. EXITS BEFORE ENTRIES. An exit frees the risk budget and the cash an
 *      entry may want, and a stop that fires must never lose a race with a new
 *      position for a per-cycle cap.
 *
 * IDEMPOTENCE, which is the property that makes the whole thing restartable.
 * Every order carries our own uuid as its `client_order_id`, so a retry that
 * reaches the venue twice is refused as a duplicate and resolved by reading
 * back the order that already exists. Fills post cumulatively under a lock, so
 * the poller and the stream describing the same shares cannot book them twice.
 * And a restart re-derives its entire view of the world from the database and
 * the broker, holding nothing across cycles that would be wrong if the process
 * died — which is why "the worker restarted" is not an event anything has to
 * handle specially.
 */

import type pg from "pg";
import { guardedBroker } from "@vesti/core/broker/guard.ts";
import { DEFAULT_LIMITS, evaluate } from "@vesti/core/risk/engine.ts";
import type { MarketState, PortfolioState, RiskLimits } from "@vesti/core/risk/types.ts";
import type { MandateKind } from "@vesti/core/risk/types.ts";
import {
  easternClock,
  type IntradayBar,
  type IntradayContext,
  type IntradayPosition,
  type IntradaySignal,
  type IntradayStrategy,
} from "@vesti/core/strategy/intraday.ts";
import { TRADEABLE_ON_PAPER, type StrategyStatus } from "@vesti/core/strategy/types.ts";
import type { SessionBroker } from "./loop.ts";
import { pollFills } from "./fills.ts";
import { isKillSwitchTripped, killSwitchState } from "./killswitch.ts";
import { OrderLedger, type LotPlan } from "./ledger.ts";
import { IntradayMarketData, sessionOpenInstant } from "./market-data.ts";
import { Observer, describe } from "./observability.ts";
import { reconcile } from "./reconcile.ts";
import { findSelfCrosses } from "./selfcross.ts";

export interface DayEngineOptions {
  pool: pg.Pool;
  broker: SessionBroker;
  data: IntradayMarketData;
  observer: Observer;
  accountId: string;
  strategy: IntradayStrategy;
  /** Trading API root. Used for the venue clock, and asserted to be paper. */
  tradingBaseUrl: string;
  limits?: RiskLimits;
  /** Cycles between full reconciliations. */
  reconcileEvery?: number;
  /** Decide everything, submit nothing. */
  dryRun?: boolean;
}

export interface CycleOutcome {
  marketOpen: boolean;
  /** Null when the cycle traded or had nothing to trade; set when it refused. */
  haltReason: string | null;
  symbolsScanned: number;
  signals: number;
  submitted: Array<{ orderId: string; symbol: string; side: string; quantity: number }>;
  refusals: Array<{ symbol: string; reason: string }>;
  fillsPosted: number;
}

/**
 * One turn of the loop.
 *
 * Holds no state between calls beyond what the Observer keeps for de-duplicating
 * the feed. Everything else is re-read, because a worker that trusts its own
 * memory across a restart is a worker whose first cycle after a crash is its
 * most dangerous one.
 */
export class DayEngine {
  readonly #ledger: OrderLedger;
  #cyclesSinceReconcile = Number.MAX_SAFE_INTEGER; // force one on the first cycle
  #lastReconcileBalanced = false;

  constructor(private readonly options: DayEngineOptions) {
    this.#ledger = new OrderLedger(options.pool);
  }

  async cycle(now: Date = new Date()): Promise<CycleOutcome> {
    const { pool, broker, data, observer, accountId, strategy } = this.options;
    const outcome: CycleOutcome = {
      marketOpen: false,
      haltReason: null,
      symbolsScanned: 0,
      signals: 0,
      submitted: [],
      refusals: [],
      fillsPosted: 0,
    };

    // ── 1. Fills, unconditionally ─────────────────────────────────────────
    outcome.fillsPosted = await this.#postOutstandingFills();

    const clock = await data.fetchClock(this.options.tradingBaseUrl);
    outcome.marketOpen = clock.isOpen;

    // ── 2. Reconcile ──────────────────────────────────────────────────────
    const reconcileEvery = this.options.reconcileEvery ?? 20;
    if (this.#cyclesSinceReconcile >= reconcileEvery) {
      this.#cyclesSinceReconcile = 0;
      const positions = await broker.listPositions();
      const report = await reconcile(pool, { accountId, positions });
      this.#lastReconcileBalanced = report.balanced;
      await pool.query(
        `INSERT INTO reconciliation_runs (account_id, balanced, positions_checked, discrepancies)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [accountId, report.balanced, report.positionsChecked, JSON.stringify(report.discrepancies)],
      );
      if (!report.balanced) {
        for (const d of report.discrepancies) {
          await observer.say({
            level: "error",
            kind: "reconcile_drift",
            symbol: d.symbol ?? undefined,
            message: `${d.kind}: ledger ${d.ledger} vs broker ${d.broker}`,
            detail: { ...d },
          });
        }
      }
    } else {
      this.#cyclesSinceReconcile += 1;
    }

    if (!this.#lastReconcileBalanced) {
      outcome.haltReason = "ledger does not agree with the broker";
      return outcome;
    }

    // ── 3. Kill switch ────────────────────────────────────────────────────
    if (await isKillSwitchTripped(pool, accountId)) {
      const state = await killSwitchState(pool, accountId);
      outcome.haltReason = `kill switch tripped by ${state.trippedBy}: ${state.reason}`;
      return outcome;
    }

    // ── 4. Promotion ──────────────────────────────────────────────────────
    const standing = await strategyStanding(pool, accountId, strategy);
    if (!standing || !TRADEABLE_ON_PAPER.has(standing.status)) {
      outcome.haltReason = standing
        ? `${strategy.key} is ${standing.status}, not paper_approved`
        : `${strategy.key} is not registered`;
      return outcome;
    }

    if (!clock.isOpen) {
      outcome.haltReason = `market closed — next open ${clock.nextOpen}`;
      return outcome;
    }

    // ── 5. See ────────────────────────────────────────────────────────────
    const { sessionDate, minuteOfDay } = easternClock(now);
    const universe = await universeSymbols(pool);
    const bars = await data.fetchBars(universe, sessionOpenInstant(sessionDate));
    observer.markData();
    outcome.symbolsScanned = bars.size;

    const positions = await this.#enginePositions(standing.strategyVersionId);
    const tradedToday = await this.#tradedToday(standing.strategyVersionId, sessionDate);

    const evaluation = strategy.evaluate({
      sessionDate,
      minuteOfDay,
      bars: toStrategyBars(bars),
      positions,
      tradedToday,
    } satisfies IntradayContext);
    observer.markEvaluation();
    outcome.signals = evaluation.signals.length;

    for (const pass of evaluation.passes) {
      await observer.pass(pass.symbol, pass.reason);
    }

    // ── 6. Decide, check, submit ──────────────────────────────────────────
    // Exits first. `IntradayStrategy` already orders them first, but sorting
    // here too means a strategy that forgets cannot create a race for the cap.
    const ordered = [...evaluation.signals].sort(
      (a, b) => (a.kind === "exit" ? 0 : 1) - (b.kind === "exit" ? 0 : 1),
    );

    for (const signal of ordered) {
      try {
        const placed = await this.#act(signal, standing.strategyVersionId, sessionDate);
        if (placed) {
          outcome.submitted.push(placed);
          observer.markOrder();
        }
      } catch (error) {
        const reason = describe(error);
        outcome.refusals.push({ symbol: signal.symbol, reason });
        await observer.say({
          level: "warn",
          kind: "risk_refused",
          symbol: signal.symbol,
          message: `refused — ${reason}`,
          detail: { intent: signal.kind },
        });
        // Forget the suppressed pass reason: the next scan should say something
        // about this symbol rather than being deduplicated into silence right
        // after a refusal.
        observer.resetPass(signal.symbol);
      }
    }

    return outcome;
  }

  /**
   * Posts anything that has filled since we last looked.
   *
   * Sweeps EVERY open order on the account, not only this engine's. An order
   * left working by another engine or a previous process is still a fill that
   * has to reach the ledger, and reconciliation — which everything downstream
   * depends on — compares the whole account.
   */
  async #postOutstandingFills(): Promise<number> {
    const { pool, broker, observer, accountId } = this.options;
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM orders
        WHERE account_id = $1 AND status IN ('pending_new', 'working', 'partially_filled')`,
      [accountId],
    );
    if (rows.length === 0) return 0;

    let posted = 0;
    await pollFills(
      broker,
      this.#ledger,
      rows.map((r) => r.id),
      {
        lotPlanFor: (orderId) => this.#lotPlanFor(orderId),
        onFill: ({ orderId, posted: result }) => {
          if (!result.applied) return;
          posted += 1;
          void this.#announceFill(orderId, result);
        },
        onError: (error) => {
          observer.markError(error);
          void observer.say({ level: "error", kind: "fill_poll_error", message: describe(error) });
        },
      },
    );
    return posted;
  }

  async #announceFill(
    orderId: string,
    result: { filledQuantity: number; lotOpened: string | null; realizedPnl: number },
  ): Promise<void> {
    const { pool, observer } = this.options;
    const { rows } = await pool.query<{ symbol: string; side: string; price: string | null }>(
      `SELECT s.symbol, o.side,
              (SELECT sum(quantity * price) / nullif(sum(quantity), 0)
                 FROM fills WHERE order_id = o.id) AS price
         FROM orders o JOIN securities s ON s.id = o.security_id
        WHERE o.id = $1`,
      [orderId],
    );
    const row = rows[0];
    const price = row?.price === null || row?.price === undefined ? null : Number(row.price);

    await observer.say({
      level: "signal",
      kind: "fill",
      symbol: row?.symbol,
      orderId,
      message:
        `filled ${result.filledQuantity}` +
        (price === null ? "" : ` at $${price.toFixed(2)}`),
      detail: { filledQuantity: result.filledQuantity, price },
    });

    if (result.lotOpened !== null) {
      await this.options.observer.say({
        level: "signal",
        kind: "position_opened",
        symbol: row?.symbol,
        orderId,
        message: `position open — ${result.filledQuantity} share(s)`,
      });
    } else {
      await this.options.observer.say({
        level: "signal",
        kind: "position_closed",
        symbol: row?.symbol,
        orderId,
        message: `position closed — realised $${result.realizedPnl.toFixed(2)}`,
        detail: { realizedPnl: result.realizedPnl },
      });
      // The symbol is flat again; let the feed speak about it afresh.
      if (row?.symbol) this.options.observer.resetPass(row.symbol);
    }
  }

  /** The stop and target this order's decision recorded, for the lot it opens. */
  async #lotPlanFor(orderId: string): Promise<LotPlan | undefined> {
    const { rows } = await this.options.pool.query<{
      stop_price: string | null;
      target_price: string | null;
    }>(`SELECT stop_price, target_price FROM trade_decisions WHERE order_id = $1`, [orderId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      ...(row.stop_price === null ? {} : { stopPrice: Number(row.stop_price) }),
      ...(row.target_price === null ? {} : { targetPrice: Number(row.target_price) }),
    };
  }

  /**
   * Positions this engine opened, and only those.
   *
   * Identified by the strategy version stamped on each lot at entry, NOT by
   * mandate. Two strategies can share a mandate — the daily swing strategy and
   * this one both trade Active — and an intraday exit rule that swept every lot
   * in its mandate would close somebody else's multi-week position at 15:45
   * because its own clock said so.
   */
  async #enginePositions(strategyVersionId: string): Promise<IntradayPosition[]> {
    const { rows } = await this.options.pool.query<{
      symbol: string;
      quantity: string;
      cost: string;
      stop_price: string | null;
      target_price: string | null;
      opened_at: Date;
    }>(
      `SELECT s.symbol,
              sum(l.remaining)                AS quantity,
              sum(l.remaining * l.cost_basis) AS cost,
              min(l.stop_price)               AS stop_price,
              min(l.target_price)             AS target_price,
              min(l.opened_at)                AS opened_at
         FROM lots l
         JOIN securities s ON s.id = l.security_id
        WHERE l.account_id = $1 AND l.strategy_version_id = $2 AND l.remaining > 0
        GROUP BY s.symbol`,
      [this.options.accountId, strategyVersionId],
    );

    return rows.map((row) => {
      const quantity = Number(row.quantity);
      return {
        symbol: row.symbol,
        quantity,
        averageCost: Number(row.cost) / quantity,
        stopPrice: row.stop_price === null ? null : Number(row.stop_price),
        targetPrice: row.target_price === null ? null : Number(row.target_price),
        openedAt: row.opened_at.toISOString(),
      };
    });
  }

  /**
   * Symbols this engine has already ordered today, filled or not.
   *
   * Counted from ORDERS rather than fills on purpose. An order that was
   * submitted and cancelled still used its shot: re-proposing the same symbol
   * because nothing came back yet is how one signal becomes four orders while
   * the first is still working.
   */
  async #tradedToday(strategyVersionId: string, sessionDate: string): Promise<Set<string>> {
    const { rows } = await this.options.pool.query<{ symbol: string }>(
      `SELECT DISTINCT s.symbol
         FROM orders o JOIN securities s ON s.id = o.security_id
        WHERE o.account_id = $1
          AND o.strategy_version_id = $2
          AND (o.created_at AT TIME ZONE 'America/New_York')::date = $3::date
          AND o.status <> 'rejected_risk'`,
      [this.options.accountId, strategyVersionId, sessionDate],
    );
    return new Set(rows.map((r) => r.symbol));
  }

  /**
   * One signal, all the way to a submitted order — or a throw explaining why not.
   *
   * Refusals throw rather than returning null so the caller records them. A
   * signal that vanishes silently is indistinguishable from one that was never
   * produced, which makes "why didn't it take that trade?" unanswerable.
   */
  async #act(
    signal: IntradaySignal,
    strategyVersionId: string,
    sessionDate: string,
  ): Promise<CycleOutcome["submitted"][number] | null> {
    const { pool, broker, observer, accountId, strategy, dryRun } = this.options;

    const securityId = await securityIdFor(pool, signal.symbol);
    if (!securityId) throw new Error(`${signal.symbol} is not in securities`);

    const mandateId = await mandateIdFor(pool, accountId, strategy.mandate);
    if (!mandateId) throw new Error(`no ${strategy.mandate} mandate on this account`);

    const side = signal.kind === "exit" ? ("sell" as const) : ("buy" as const);

    // Detection, not netting: better a clear refusal here than a wash-trade
    // rejection after submission.
    const crosses = await findSelfCrosses(pool, { accountId, securityId, side });
    if (crosses.length > 0) {
      throw new Error(
        `self-cross: ${crosses.map((c) => `${c.mandateName} ${c.side}`).join(", ")} already working`,
      );
    }

    await observer.say({
      level: "signal",
      kind: signal.kind === "entry" ? "entry_signal" : "exit_signal",
      symbol: signal.symbol,
      message:
        signal.kind === "entry"
          ? `entry signal — ${signal.reasons.join("; ")}`
          : `exit signal (${signal.exitReason}) — ${signal.reasons.join("; ")}`,
      detail: signal.kind === "entry" ? signal.signal : { exitReason: signal.exitReason },
    });

    // ── The real risk engine, on real state ───────────────────────────────
    const account = await broker.getAccount();
    const portfolio = await portfolioState(pool, accountId, account.cash);
    const market = await marketState(pool, securityId);

    const held = await this.#ledger.positionForMandate(accountId, mandateId, securityId);
    const requested =
      signal.kind === "exit" ? Math.min(signal.quantity, held.quantity) : Number.MAX_SAFE_INTEGER;
    if (signal.kind === "exit" && requested <= 0) {
      throw new Error("nothing held in this mandate to exit");
    }

    const ruling = evaluate(
      {
        mandate: strategy.mandate,
        side,
        symbol: signal.symbol,
        sector: null,
        entryPrice: signal.referencePrice,
        stopPrice: signal.kind === "entry" ? signal.stopPrice : null,
        targetPrice: signal.kind === "entry" ? signal.targetPrice : null,
        tier: signal.kind === "entry" ? signal.tier : "standard",
        isBinaryEvent: false,
      },
      portfolio,
      market,
      this.options.limits ?? DEFAULT_LIMITS,
    );

    const quantity = Math.floor(Math.min(requested, ruling.approvedQuantity) + 1e-9);
    if (ruling.decision === "reject" || quantity < 1) {
      const why = ruling.violations.map((v) => v.code).join(", ") || "sized below one share";
      throw new Error(`risk engine: ${why}`);
    }

    if (dryRun) {
      await observer.say({
        level: "info",
        kind: "dry_run",
        symbol: signal.symbol,
        message: `would ${side} ${quantity} — dry run, nothing submitted`,
      });
      return null;
    }

    // ── Intent, ruling, thesis ────────────────────────────────────────────
    const orderId = await this.#ledger.recordIntent({
      accountId,
      mandateId,
      securityId,
      side,
      kind: "market",
      quantity,
      timeInForce: "day",
      strategyVersionId,
    });
    const attached = await this.#ledger.recordRiskRuling(orderId, {
      decision: ruling.decision,
      requestedQuantity: quantity,
      approvedQuantity: quantity,
      violations: ruling.violations,
      inputs: {
        sessionDate,
        referencePrice: signal.referencePrice,
        reasons: signal.reasons,
      },
      engineVersion: ruling.engineVersion,
    });

    await this.#recordDecision(orderId, signal, ruling.riskAmount, strategyVersionId);

    await observer.say({
      level: "signal",
      kind: "risk_approved",
      symbol: signal.symbol,
      orderId,
      message:
        `risk check passed — ${side} ${quantity} approved` +
        (signal.kind === "entry" ? `, risking $${ruling.riskAmount.toFixed(2)}` : ""),
      detail: { decision: ruling.decision, approvedQuantity: quantity },
    });

    // ── The gate, then the venue ──────────────────────────────────────────
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
    await this.#ledger.recordSubmission(orderId, state.brokerOrderId);

    await observer.say({
      level: "signal",
      kind: "order_submitted",
      symbol: signal.symbol,
      orderId,
      message: `PAPER ${side.toUpperCase()} submitted — ${quantity} share(s)`,
      detail: { brokerOrderId: state.brokerOrderId, status: state.status },
    });

    return { orderId, symbol: signal.symbol, side, quantity };
  }

  async #recordDecision(
    orderId: string,
    signal: IntradaySignal,
    riskAmount: number,
    strategyVersionId: string,
  ): Promise<void> {
    void strategyVersionId;
    const { strategy, accountId, pool } = this.options;
    await pool.query(
      `INSERT INTO trade_decisions
         (order_id, account_id, engine, strategy_key, strategy_version, trading_mode,
          intent, reasons, signal, reference_price, stop_price, target_price,
          risk_amount, exit_reason)
       VALUES ($1, $2, $3, $4, $5, 'paper', $6, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
      [
        orderId,
        accountId,
        strategy.engine,
        strategy.key,
        strategy.version,
        signal.kind,
        signal.reasons,
        JSON.stringify(signal.kind === "entry" ? signal.signal : {}),
        signal.referencePrice,
        signal.kind === "entry" ? signal.stopPrice : null,
        signal.kind === "entry" ? signal.targetPrice : null,
        signal.kind === "entry" ? riskAmount : null,
        signal.kind === "exit" ? signal.exitReason : null,
      ],
    );
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The current standing of this strategy for this account's owner.
 *
 * Scoped to the account's OWNER rather than the slug alone: `strategies` is
 * keyed (user_id, slug), and matching on slug would let one account's promotion
 * authorise trading on another's.
 *
 * `strategy_versions` is append-only, so a promotion is a new row rather than a
 * status update — the current standing is the status on the highest revision of
 * the matching code version.
 */
export async function strategyStanding(
  pool: pg.Pool,
  accountId: string,
  strategy: { key: string; version: number },
): Promise<{ strategyVersionId: string; status: StrategyStatus } | null> {
  const { rows } = await pool.query<{ id: string; status: StrategyStatus }>(
    `SELECT sv.id, sv.status
       FROM strategy_versions sv
       JOIN strategies st ON st.id = sv.strategy_id
       JOIN accounts a    ON a.user_id = st.user_id
      WHERE a.id = $1 AND st.slug = $2 AND sv.spec->>'code_version' = $3
      ORDER BY sv.version DESC
      LIMIT 1`,
    [accountId, strategy.key, String(strategy.version)],
  );
  const row = rows[0];
  return row ? { strategyVersionId: row.id, status: row.status } : null;
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

/**
 * Liquidity and volatility for the risk engine, from DAILY bars.
 *
 * Daily rather than the intraday feed, deliberately. The liquidity cap is about
 * how many shares can be moved without being the market, and that has to be
 * measured against CONSOLIDATED volume — the real-time IEX feed sees a few per
 * cent of it, and sizing against that number would refuse every trade the cap
 * was never meant to stop.
 */
async function marketState(pool: pg.Pool, securityId: string): Promise<MarketState> {
  const { rows } = await pool.query<{ adv: string | null; atr: string | null }>(
    `SELECT avg(close * volume) AS adv, avg((high - low) / close) AS atr
       FROM (SELECT close, volume, high, low FROM bars_daily
              WHERE security_id = $1 ORDER BY session_date DESC LIMIT 20) recent`,
    [securityId],
  );
  return {
    averageDollarVolume: Number(rows[0]?.adv ?? 0),
    spreadFraction: 0.0005,
    atrFraction: Number(rows[0]?.atr ?? 0.02),
    // No measured expectancy exists until the Strategy Lab produces one. Null
    // is the honest value and the engine reads it as "no evidence to size up".
    expectancyR: null,
    sampleSize: 0,
  };
}

/**
 * Portfolio state for the risk engine, from the ledger.
 *
 * Positions are marked at the last daily close rather than at cost: the engine
 * derives sellable size from market value over the reference price, so feeding
 * it cost basis makes an exit of a position that has moved come back fractional
 * and get refused — which would mean a stop that cannot fire.
 */
async function portfolioState(
  pool: pg.Pool,
  accountId: string,
  brokerCash: number,
): Promise<PortfolioState> {
  const { rows } = await pool.query<{
    mandate_kind: MandateKind;
    symbol: string;
    quantity: string;
    cost: string;
    stop: string | null;
    last_close: string | null;
  }>(
    `SELECT m.kind AS mandate_kind, s.symbol,
            sum(l.remaining)                AS quantity,
            sum(l.remaining * l.cost_basis) AS cost,
            min(l.stop_price)               AS stop,
            max(p.close)                    AS last_close
       FROM lots l
       JOIN mandates m   ON m.id = l.mandate_id
       JOIN securities s ON s.id = l.security_id
       LEFT JOIN LATERAL (
         SELECT b.close FROM bars_daily b
          WHERE b.security_id = l.security_id
          ORDER BY b.session_date DESC LIMIT 1
       ) p ON true
      WHERE l.account_id = $1 AND l.remaining > 0
      GROUP BY m.kind, s.symbol`,
    [accountId],
  );

  const mandateEquity: Record<MandateKind, number> = { active: 0, catalyst: 0, long_term: 0 };
  const positions = rows.map((row) => {
    const quantity = Number(row.quantity);
    const cost = Number(row.cost);
    const marketValue = row.last_close === null ? cost : quantity * Number(row.last_close);
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

  // Unallocated cash is split by target weight so each mandate has a budget
  // before it holds anything. Without this the first trade in a mandate sizes
  // against zero equity and the engine correctly refuses it.
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

function toStrategyBars(
  bars: ReadonlyMap<string, ReadonlyArray<{ ts: string; open: number; high: number; low: number; close: number; volume: number; vwap: number | null }>>,
): Map<string, IntradayBar[]> {
  const out = new Map<string, IntradayBar[]>();
  for (const [symbol, rows] of bars) {
    out.set(
      symbol,
      rows.map((r) => ({
        ts: r.ts,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        vwap: r.vwap,
      })),
    );
  }
  return out;
}
