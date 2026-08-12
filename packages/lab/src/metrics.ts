/**
 * Scoring a backtest, including the parts that are unflattering.
 *
 * Every number here is computed the boring way and reported next to the one
 * that qualifies it. A return with no drawdown beside it, or a Sharpe with no
 * trade count, is a number chosen to persuade rather than inform.
 *
 * Two are load-bearing:
 *
 *   THE BENCHMARK. A strategy that returned 40% over a decade in which the
 *   index returned 200% lost, and saying so requires computing both over the
 *   same window with the same starting capital. Absolute return alone cannot
 *   distinguish an edge from having been in the market.
 *
 *   THE SAMPLE SIZE. Expectancy from thirty trades is a rumour. It is reported
 *   alongside every per-trade statistic so that no ratio here can be read
 *   without also seeing how little may be behind it.
 *
 * Deliberately absent: any pass/fail threshold. A promotion gate belongs to the
 * validation ladder, where the trial count that produced a result is also
 * known. A threshold here would be something to tune against.
 */

import type { BacktestResult, EquityPoint } from "./engine.ts";

export interface RoundTrip {
  symbol: string;
  entryDate: string;
  exitDate: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  returnFraction: number;
  sessionsHeld: number;
}

export interface Metrics {
  from: string;
  to: string;
  years: number;
  startingEquity: number;
  endingEquity: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  /** Largest peak-to-trough, as a fraction, and when it bottomed. */
  maxDrawdownDate: string;
  annualisedVolatility: number;
  sharpe: number;
  /** Fraction of sessions holding at least one position. */
  exposure: number;
  /**
   * Average fraction of equity actually in positions.
   *
   * Reported next to `exposure` because the two are easily confused and the
   * difference decides whether a Sharpe ratio means anything: a book that holds
   * something on 90% of sessions but only ever commits 8% of its capital is
   * mostly cash, and cash has no volatility. Comparing that Sharpe to a fully
   * invested benchmark's flatters it enormously.
   */
  averageDeployed: number;
  trades: number;
  roundTrips: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  expectancy: number;
}

const TRADING_DAYS = 252;

/** Pairs buys and sells per symbol, FIFO, into completed round trips. */
export function roundTrips(result: BacktestResult): RoundTrip[] {
  const open = new Map<string, { date: string; quantity: number; price: number }[]>();
  const completed: RoundTrip[] = [];
  const sessionIndex = new Map(result.equity.map((point, i) => [point.sessionDate, i]));

  for (const trade of result.trades) {
    if (trade.side === "buy") {
      const lots = open.get(trade.symbol) ?? [];
      lots.push({ date: trade.sessionDate, quantity: trade.quantity, price: trade.price });
      open.set(trade.symbol, lots);
      continue;
    }

    let remaining = trade.quantity;
    const lots = open.get(trade.symbol) ?? [];
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0]!;
      const matched = Math.min(remaining, lot.quantity);
      const pnl = (trade.price - lot.price) * matched;
      completed.push({
        symbol: trade.symbol,
        entryDate: lot.date,
        exitDate: trade.sessionDate,
        quantity: matched,
        entryPrice: lot.price,
        exitPrice: trade.price,
        pnl,
        returnFraction: lot.price > 0 ? (trade.price - lot.price) / lot.price : 0,
        sessionsHeld:
          (sessionIndex.get(trade.sessionDate) ?? 0) - (sessionIndex.get(lot.date) ?? 0),
      });
      lot.quantity -= matched;
      remaining -= matched;
      if (lot.quantity <= 0) lots.shift();
    }
    open.set(trade.symbol, lots);
  }

  return completed;
}

function drawdown(equity: readonly EquityPoint[]): { max: number; date: string } {
  let peak = equity[0]?.equity ?? 0;
  let max = 0;
  let date = equity[0]?.sessionDate ?? "";
  for (const point of equity) {
    peak = Math.max(peak, point.equity);
    const dd = peak > 0 ? 1 - point.equity / peak : 0;
    if (dd > max) {
      max = dd;
      date = point.sessionDate;
    }
  }
  return { max, date };
}

/** Session-over-session returns, for volatility and Sharpe. */
function dailyReturns(equity: readonly EquityPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prior = equity[i - 1]!.equity;
    if (prior > 0) returns.push(equity[i]!.equity / prior - 1);
  }
  return returns;
}

export function summarise(result: BacktestResult): Metrics {
  const equity = result.equity;
  const start = equity[0]?.equity ?? result.startingCash;
  const end = equity.at(-1)?.equity ?? start;
  const years = equity.length / TRADING_DAYS;

  const returns = dailyReturns(equity);
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length
    : 0;
  const dailyVol = Math.sqrt(variance);

  const dd = drawdown(equity);
  const completed = roundTrips(result);
  const wins = completed.filter((t) => t.pnl > 0);
  const losses = completed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  return {
    from: result.from,
    to: result.to,
    years,
    startingEquity: start,
    endingEquity: end,
    totalReturn: start > 0 ? end / start - 1 : 0,
    cagr: start > 0 && years > 0 ? (end / start) ** (1 / years) - 1 : 0,
    maxDrawdown: dd.max,
    maxDrawdownDate: dd.date,
    annualisedVolatility: dailyVol * Math.sqrt(TRADING_DAYS),
    // Zero risk-free rate, stated rather than hidden: at a 4% cash rate this
    // flatters a low-return strategy, and correcting it is one subtraction the
    // reader can make once they know it has not been made.
    sharpe: dailyVol > 0 ? (mean / dailyVol) * Math.sqrt(TRADING_DAYS) : 0,
    exposure: equity.length
      ? equity.filter((p) => p.openPositions > 0).length / equity.length
      : 0,
    averageDeployed: equity.length
      ? equity.reduce((sum, p) => sum + (p.equity > 0 ? p.positionValue / p.equity : 0), 0) /
        equity.length
      : 0,
    trades: result.trades.length,
    roundTrips: completed.length,
    winRate: completed.length ? wins.length / completed.length : 0,
    averageWin: wins.length ? grossWin / wins.length : 0,
    averageLoss: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: completed.length ? (grossWin - grossLoss) / completed.length : 0,
  };
}

/**
 * Buy and hold, over the same window and the same starting capital.
 *
 * Whole shares bought on the first session and held, which is what the
 * comparison has to be: a strategy is not beaten by an index it could not have
 * bought, and fractional-share arithmetic would quietly hand the benchmark
 * capital the strategy never had.
 */
export function buyAndHold(
  bars: readonly { sessionDate: string; close: number }[],
  startingCash: number,
): { equity: EquityPoint[]; metrics: Metrics } {
  const first = bars[0];
  if (!first || first.close <= 0) {
    const empty: EquityPoint[] = [];
    return {
      equity: empty,
      metrics: summarise({
        strategyKey: "buy-and-hold",
        from: "",
        to: "",
        sessions: 0,
        startingCash,
        trades: [],
        equity: empty,
        refusals: new Map(),
        signals: 0,
      }),
    };
  }

  const shares = Math.floor(startingCash / first.close);
  const residual = startingCash - shares * first.close;
  const equity: EquityPoint[] = bars.map((bar) => ({
    sessionDate: bar.sessionDate,
    equity: shares * bar.close + residual,
    cash: residual,
    positionValue: shares * bar.close,
    openPositions: shares > 0 ? 1 : 0,
  }));

  return {
    equity,
    metrics: summarise({
      strategyKey: "buy-and-hold",
      from: equity[0]!.sessionDate,
      to: equity.at(-1)!.sessionDate,
      sessions: equity.length,
      startingCash,
      trades: [],
      equity,
      refusals: new Map(),
      signals: 0,
    }),
  };
}

/**
 * The same metrics over sub-periods.
 *
 * A decade-long average hides the question that matters — what happened in the
 * bad stretches — and a strategy whose entire edge came from one year is a
 * different proposition from one that worked in eight. Splitting by calendar
 * year is the crudest useful cut; the regime engine that does it properly is
 * still ahead.
 */
export function byPeriod(
  result: BacktestResult,
  periods: ReadonlyArray<{ label: string; from: string; to: string }>,
): Array<{ label: string; metrics: Metrics }> {
  return periods.map(({ label, from, to }) => {
    const equity = result.equity.filter((p) => p.sessionDate >= from && p.sessionDate <= to);
    const trades = result.trades.filter((t) => t.sessionDate >= from && t.sessionDate <= to);
    return {
      label,
      metrics: summarise({
        ...result,
        from,
        to,
        equity,
        trades,
        sessions: equity.length,
        startingCash: equity[0]?.equity ?? result.startingCash,
      }),
    };
  });
}
