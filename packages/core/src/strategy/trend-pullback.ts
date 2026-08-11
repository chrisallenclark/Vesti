/**
 * Reference strategy for the Active mandate: trend, pullback, reclaim.
 *
 * READ THIS BEFORE PROMOTING IT.
 *
 * This exists so the autonomous loop has something real to run and so the
 * `Strategy` interface is exercised by an implementation rather than a stub. It
 * is NOT a validated edge. It has been through no backtest, no walk-forward, no
 * regime stratification and no trial-count deflation, because none of those
 * exist yet — that is Phase 4. It ships at `experimental`, and the loop will
 * not trade it until somebody explicitly promotes it.
 *
 * If it is promoted and it makes money over a few weeks, that is not evidence.
 * Twenty trades cannot distinguish a real edge from a lucky one, and the
 * scorecard is built to say so. The honest use of this strategy is as a
 * generator of realistic order flow so that the loop, the ledger, the
 * reconciliation and the equity curve are all exercised against a live venue
 * before a strategy anybody believes in is put behind them.
 *
 * The rules, such as they are:
 *
 *   REGIME. Only long, only when the close is above the 200-day average. Trend
 *   filters do not create edge but they do remove the market's worst stretches
 *   from the sample, which is most of what a simple long system needs.
 *
 *   PULLBACK. Price must have traded below the 20-day average within the last
 *   five sessions — buying a trend that has not paused is buying extension.
 *
 *   RECLAIM. Entry on the session that closes back above the 20-day. Waiting
 *   for the reclaim rather than catching the low is what makes this mechanical:
 *   there is no judgement about whether the pullback is "done".
 *
 *   STOP. Two ATRs below the entry close, which is the number handed to the
 *   risk engine to size against. Not a round number and not a fixed percentage;
 *   the stop has to scale with how much the instrument actually moves or the
 *   same dollar risk buys wildly different odds across names.
 *
 *   EXIT. Close below the 20-day average, or the stop being breached
 *   intrasession. No profit target: capping the winners in a trend system is
 *   how a positive expectancy gets turned negative.
 */

import type { MandateKind } from "../risk/types.ts";
import { atr, sma } from "./indicators.ts";
import type { Strategy, StrategyContext, StrategySignal } from "./types.ts";

export interface TrendPullbackConfig {
  trendPeriod?: number;
  pullbackPeriod?: number;
  /** How recently price must have dipped below the fast average. */
  pullbackLookback?: number;
  atrPeriod?: number;
  atrStopMultiple?: number;
  /** Cap on simultaneous entries per session, so one loop cannot open twelve. */
  maxEntriesPerSession?: number;
}

const DEFAULTS = {
  trendPeriod: 200,
  pullbackPeriod: 20,
  pullbackLookback: 5,
  atrPeriod: 14,
  atrStopMultiple: 2,
  maxEntriesPerSession: 2,
};

export class TrendPullback implements Strategy {
  readonly key = "active.trend_pullback";
  readonly version = 1;
  readonly mandate: MandateKind = "active";
  readonly describe =
    "Long pullbacks within an established uptrend; ATR stop; exit on trend loss. UNVALIDATED.";

  private readonly config: Required<TrendPullbackConfig>;

  constructor(config: TrendPullbackConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  get warmupSessions(): number {
    // The slowest input decides. Running with less history than this does not
    // produce a weaker signal, it produces a different one.
    return this.config.trendPeriod + 1;
  }

  evaluate(context: StrategyContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const held = new Map(context.positions.map((p) => [p.symbol, p]));

    // Exits first, and unconditionally. An exit rule that competes with entry
    // rules for a per-session budget is a rule that sometimes fails to protect
    // the position it exists for.
    for (const position of context.positions) {
      const bars = context.bars.get(position.symbol);
      if (!bars || bars.length === 0) continue;
      const index = bars.length - 1;
      const last = bars[index]!;

      if (position.stopPrice !== null && last.low <= position.stopPrice) {
        signals.push({
          kind: "exit",
          symbol: position.symbol,
          quantity: position.quantity,
          reasons: [`stop ${position.stopPrice} breached (session low ${last.low})`],
        });
        continue;
      }

      const fast = sma(bars, index, this.config.pullbackPeriod);
      if (fast !== null && last.close < fast) {
        signals.push({
          kind: "exit",
          symbol: position.symbol,
          quantity: position.quantity,
          reasons: [
            `close ${last.close} below the ${this.config.pullbackPeriod}-day average ${fast.toFixed(2)}`,
          ],
        });
      }
    }

    const candidates: Array<{ symbol: string; signal: StrategySignal; strength: number }> = [];

    for (const [symbol, bars] of context.bars) {
      if (held.has(symbol)) continue;
      const index = bars.length - 1;
      if (index < this.warmupSessions) continue;

      const last = bars[index]!;
      const slow = sma(bars, index, this.config.trendPeriod);
      const fast = sma(bars, index, this.config.pullbackPeriod);
      const range = atr(bars, index, this.config.atrPeriod);
      if (slow === null || fast === null || range === null || range <= 0) continue;

      if (last.close <= slow) continue; // not an uptrend
      if (last.close <= fast) continue; // has not reclaimed yet

      // Must actually have pulled back recently, and not on this bar — the
      // reclaim is the entry, so the dip has to be behind it.
      let pulledBack = false;
      for (let i = index - this.config.pullbackLookback; i < index; i += 1) {
        if (i < 0) continue;
        const priorFast = sma(bars, i, this.config.pullbackPeriod);
        if (priorFast !== null && bars[i]!.low < priorFast) {
          pulledBack = true;
          break;
        }
      }
      if (!pulledBack) continue;

      const stopPrice = Number((last.close - this.config.atrStopMultiple * range).toFixed(2));
      if (stopPrice <= 0 || stopPrice >= last.close) continue;

      candidates.push({
        symbol,
        strength: (last.close - slow) / slow,
        signal: {
          kind: "entry",
          symbol,
          side: "buy",
          stopPrice,
          targetPrice: null,
          // Never above the floor tier. Conviction is a communication device,
          // and a rule set nobody has validated has not earned a multiplier.
          tier: "experimental",
          reasons: [
            `close ${last.close} above the ${this.config.trendPeriod}-day average ${slow.toFixed(2)}`,
            `reclaimed the ${this.config.pullbackPeriod}-day average ${fast.toFixed(2)} after a pullback`,
            `stop at ${stopPrice} = ${this.config.atrStopMultiple} ATR (${range.toFixed(2)}) below`,
          ],
        },
      });
    }

    // Deterministic: strongest trend first, ties broken by symbol so two runs
    // over the same data cannot pick different names.
    candidates.sort((a, b) => b.strength - a.strength || a.symbol.localeCompare(b.symbol));
    for (const candidate of candidates.slice(0, this.config.maxEntriesPerSession)) {
      signals.push(candidate.signal);
    }

    return signals;
  }
}
