/**
 * The backtester.
 *
 * It answers one question — what would this strategy have done — and the only
 * way that answer is worth anything is if the run is incapable of seeing the
 * future. Three properties do that work, and none of them is optional:
 *
 *   THE STRATEGY IS HANDED HISTORY, NOT THE SERIES. On session T it receives
 *   bars up to and including T and nothing after. That is enforced here by
 *   slicing, and upstream by the bars having come from `pit_bars_daily`, so a
 *   split announced in 2020 is not applied to a 2019 bar the market had not
 *   been told about.
 *
 *   ORDERS FILL THROUGH `SimBroker`, NOT AT THE CLOSE THAT PRODUCED THEM. A
 *   signal from T's close is submitted after T and is not eligible until T+1,
 *   where it pays the spread and market impact. Filling a decision at the price
 *   that caused it is the single most flattering error available, and it is
 *   structurally impossible here because the simulator holds the clock.
 *
 *   SIZING IS THE RISK ENGINE'S, exactly as in production. The same `evaluate`
 *   the live loop calls decides quantity and can refuse outright. A backtest
 *   that sizes differently from the system that will trade it is measuring a
 *   strategy nobody is going to run.
 *
 * What it deliberately does not do is decide whether the result is good. It
 * reports; `metrics.ts` scores; a human reads both. There is no threshold in
 * this file that a strategy can be tuned against.
 */

import { SimBroker, type SimBar } from "@vesti/core/broker/sim.ts";
import { DEFAULT_LIMITS, evaluate } from "@vesti/core/risk/engine.ts";
import type {
  ExistingPosition,
  MandateKind,
  MarketState,
  OrderIntent,
  PortfolioState,
  RiskLimits,
} from "@vesti/core/risk/types.ts";
import type {
  Strategy,
  StrategyBar,
  StrategyPosition,
} from "@vesti/core/strategy/types.ts";

export interface BacktestBar extends StrategyBar {
  symbol: string;
}

export interface BacktestOptions {
  strategy: Strategy;
  /** Per symbol, oldest first. Every symbol the strategy may consider. */
  bars: ReadonlyMap<string, readonly StrategyBar[]>;
  startingCash: number;
  /** Sector per symbol, for the risk engine's concentration limits. */
  sectors?: ReadonlyMap<string, string>;
  limits?: RiskLimits;
  /** Restricts the run to sessions on or after this date, after warmup. */
  from?: string;
  to?: string;
}

export interface BacktestTrade {
  symbol: string;
  side: "buy" | "sell";
  sessionDate: string;
  quantity: number;
  price: number;
  /** What the strategy said, so a surprising trade can be traced to a rule. */
  reasons: string[];
}

export interface EquityPoint {
  sessionDate: string;
  equity: number;
  cash: number;
  positionValue: number;
  openPositions: number;
}

export interface BacktestResult {
  strategyKey: string;
  from: string;
  to: string;
  sessions: number;
  startingCash: number;
  trades: BacktestTrade[];
  equity: EquityPoint[];
  /** Intents the risk engine refused, by reason. Silence here would hide a
   *  strategy whose signals are mostly unsizeable. */
  refusals: Map<string, number>;
  signals: number;
}

/** Sessions where at least one symbol traded, in order. */
function sessionDates(bars: ReadonlyMap<string, readonly StrategyBar[]>): string[] {
  const dates = new Set<string>();
  for (const series of bars.values()) for (const bar of series) dates.add(bar.sessionDate);
  return [...dates].sort();
}

/** Average dollar volume over the trailing window, for the liquidity cap. */
function averageDollarVolume(series: readonly StrategyBar[], window = 20): number {
  const recent = series.slice(-window);
  if (recent.length === 0) return 0;
  const total = recent.reduce((sum, bar) => sum + bar.close * bar.volume, 0);
  return total / recent.length;
}

/** ATR as a fraction of price, for volatility sizing and the impact term. */
function atrFraction(series: readonly StrategyBar[], period = 14): number {
  if (series.length < 2) return 0.02;
  const recent = series.slice(-(period + 1));
  let total = 0;
  for (let i = 1; i < recent.length; i++) {
    const bar = recent[i]!;
    const prior = recent[i - 1]!;
    total += Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prior.close),
      Math.abs(bar.low - prior.close),
    );
  }
  const atr = total / Math.max(1, recent.length - 1);
  const last = recent.at(-1)!.close;
  return last > 0 ? atr / last : 0.02;
}

export async function runBacktest(options: BacktestOptions): Promise<BacktestResult> {
  const { strategy, bars, startingCash } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const sectors = options.sectors ?? new Map<string, string>();

  const all = sessionDates(bars);
  const broker = new SimBroker({ startingCash });

  const trades: BacktestTrade[] = [];
  const equity: EquityPoint[] = [];
  const refusals = new Map<string, number>();
  let signalCount = 0;

  // Entry context per open position, so an exit can report holding period and
  // the stop the position was actually opened with.
  const openedOn = new Map<string, string>();
  const stops = new Map<string, number>();
  const reasonsFor = new Map<string, string[]>();

  let highWaterMark = startingCash;

  for (const [index, sessionDate] of all.entries()) {
    if (options.to && sessionDate > options.to) break;

    // Bars for this session, for every symbol that traded.
    const todays: SimBar[] = [];
    const history = new Map<string, readonly StrategyBar[]>();
    for (const [symbol, series] of bars) {
      // Everything up to and including today. Nothing after: this slice is the
      // look-ahead barrier.
      const upto = series.filter((bar) => bar.sessionDate <= sessionDate);
      if (upto.length === 0) continue;
      history.set(symbol, upto);

      const today = upto.at(-1)!;
      if (today.sessionDate !== sessionDate) continue;
      todays.push({
        symbol,
        sessionDate,
        open: today.open,
        high: today.high,
        low: today.low,
        close: today.close,
        volume: today.volume,
        atrFraction: atrFraction(upto),
      });
    }
    if (todays.length === 0) continue;

    // 1. Advance the clock. Orders submitted after the previous close become
    //    eligible now and fill against this bar, paying spread and impact.
    const fills = broker.openSession(sessionDate, todays);
    for (const fill of fills) {
      trades.push({
        symbol: fill.symbol,
        side: fill.side,
        sessionDate,
        quantity: fill.quantity,
        price: fill.price,
        reasons: reasonsFor.get(fill.symbol) ?? [],
      });
      if (fill.side === "buy" && !openedOn.has(fill.symbol)) {
        openedOn.set(fill.symbol, sessionDate);
      }
    }

    const positions = await broker.listPositions();
    const account = await broker.getAccount();

    // Positions are marked at this session's close. `BrokerPosition` carries
    // quantity and cost, not a price — marking is the caller's job, and doing
    // it from the bar the strategy just saw keeps equity and decisions on the
    // same instant.
    const closes = new Map(todays.map((bar) => [bar.symbol, bar.close]));
    const markOf = (symbol: string, fallback: number): number => closes.get(symbol) ?? fallback;

    const held = new Set(positions.map((p) => p.symbol));
    for (const symbol of [...openedOn.keys()]) {
      if (!held.has(symbol)) {
        openedOn.delete(symbol);
        stops.delete(symbol);
      }
    }

    const positionValue = positions.reduce(
      (sum, p) => sum + p.quantity * markOf(p.symbol, p.averageCost),
      0,
    );
    const totalEquity = account.cash + positionValue;
    highWaterMark = Math.max(highWaterMark, totalEquity);

    equity.push({
      sessionDate,
      equity: totalEquity,
      cash: account.cash,
      positionValue,
      openPositions: positions.length,
    });

    // Warm-up: the rules do not mean anything until they have their history,
    // and a `from` bound lets a run start after a burn-in without the strategy
    // seeing a truncated series.
    if (index < strategy.warmupSessions) continue;
    if (options.from && sessionDate < options.from) continue;

    // 2. Decide, from history that ends today.
    const strategyPositions: StrategyPosition[] = positions.map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      averageCost: p.averageCost,
      stopPrice: stops.get(p.symbol) ?? null,
      sessionsHeld: openedOn.has(p.symbol)
        ? all.indexOf(sessionDate) - all.indexOf(openedOn.get(p.symbol)!)
        : 0,
    }));

    const signals = strategy.evaluate({
      asOf: sessionDate,
      bars: history,
      positions: strategyPositions,
    });
    signalCount += signals.length;

    // 3. Size and submit. Fills land on the next session, never this one.
    for (const signal of signals) {
      const series = history.get(signal.symbol);
      if (!series || series.length === 0) continue;
      const last = series.at(-1)!;

      const existing: ExistingPosition[] = positions.map((p) => {
        const mark = markOf(p.symbol, p.averageCost);
        const stop = stops.get(p.symbol);
        return {
          symbol: p.symbol,
          mandate: strategy.mandate,
          sector: sectors.get(p.symbol) ?? null,
          marketValue: p.quantity * mark,
          // Dollars still at risk: what a stop-out would cost from here. A
          // position already above its stop carries less open risk than it did
          // at entry, and reporting the entry number would make the portfolio
          // look permanently fuller of risk than it is.
          openRisk: stop !== undefined ? Math.max(0, (mark - stop) * p.quantity) : 0,
          isBinaryEvent: false,
        };
      });

      const mandateEquity = {
        active: 0,
        catalyst: 0,
        long_term: 0,
      } as Record<MandateKind, number>;
      mandateEquity[strategy.mandate] = totalEquity;

      const portfolio: PortfolioState = {
        totalEquity,
        cash: account.cash,
        mandateEquity,
        positions: existing,
        drawdown: highWaterMark > 0 ? Math.max(0, 1 - totalEquity / highWaterMark) : 0,
        dayPnl: 0,
        openPositionCount: positions.length,
      };

      const market: MarketState = {
        averageDollarVolume: averageDollarVolume(series),
        spreadFraction: 0.0005,
        atrFraction: atrFraction(series),
        expectancyR: null,
        sampleSize: 0,
      };

      const intent: OrderIntent = {
        mandate: strategy.mandate,
        side: signal.kind === "entry" ? signal.side : "sell",
        symbol: signal.symbol,
        sector: sectors.get(signal.symbol) ?? null,
        entryPrice: last.close,
        stopPrice: signal.kind === "entry" ? signal.stopPrice : null,
        targetPrice: signal.kind === "entry" ? signal.targetPrice : null,
        tier: signal.kind === "entry" ? signal.tier : "standard",
        isBinaryEvent: false,
      };

      const ruling = evaluate(intent, portfolio, market, limits);
      if (ruling.decision === "reject" || ruling.approvedQuantity <= 0) {
        const code = ruling.violations[0]?.code ?? "no quantity approved";
        refusals.set(code, (refusals.get(code) ?? 0) + 1);
        continue;
      }

      // Whole shares, floored, with the same epsilon the live loop uses — the
      // engine sizes in dollars and lands on values like 218.99999999999997,
      // and rounding that to 219 here while production takes 218 would make the
      // backtest a measurement of a system nobody runs.
      //
      // An exit can never ask for more than is held either; letting a backtest
      // sell shares it does not own would manufacture cash.
      const holding = positions.find((p) => p.symbol === signal.symbol);
      const requested =
        intent.side === "sell"
          ? Math.min(ruling.approvedQuantity, holding?.quantity ?? 0)
          : ruling.approvedQuantity;
      const quantity = Math.floor(requested + 1e-9);
      if (quantity <= 0) continue;

      reasonsFor.set(signal.symbol, signal.reasons);
      if (signal.kind === "entry") stops.set(signal.symbol, signal.stopPrice);

      await broker.submitOrder({
        clientOrderId: `${strategy.key}-${sessionDate}-${signal.symbol}-${intent.side}`,
        symbol: signal.symbol,
        side: intent.side,
        kind: "market",
        quantity,
        timeInForce: "day",
        riskEvaluationId: "backtest",
      });
    }
  }

  return {
    strategyKey: strategy.key,
    from: equity[0]?.sessionDate ?? "",
    to: equity.at(-1)?.sessionDate ?? "",
    sessions: equity.length,
    startingCash,
    trades,
    equity,
    refusals,
    signals: signalCount,
  };
}
