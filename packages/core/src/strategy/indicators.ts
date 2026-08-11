/**
 * The handful of indicators the reference strategy needs.
 *
 * Written here rather than pulled from a library for one reason: every one of
 * these returns `null` when it does not have enough history, instead of
 * quietly computing over whatever it has. A 200-day average of 40 days of data
 * is not a 200-day average — it is a much faster line wearing the same name,
 * and a regime filter built on one is a different filter than the backtest
 * validated. Most libraries seed such series and move on.
 *
 * All pure, all total, none of them look at anything after the index asked for.
 */

import type { StrategyBar } from "./types.ts";

/** Simple moving average ending at `index`, or null before there is enough. */
export function sma(
  bars: readonly StrategyBar[],
  index: number,
  period: number,
): number | null {
  if (period <= 0 || index < period - 1 || index >= bars.length) return null;
  let total = 0;
  for (let i = index - period + 1; i <= index; i += 1) total += bars[i]!.close;
  return total / period;
}

/**
 * Wilder's Average True Range, as a plain average over `period`.
 *
 * True range rather than high−low, because a gap through yesterday's close is
 * real range that a naive high−low silently discards — and gaps are exactly
 * when a stop distance matters most.
 */
export function atr(
  bars: readonly StrategyBar[],
  index: number,
  period: number,
): number | null {
  if (period <= 0 || index < period || index >= bars.length) return null;
  let total = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const bar = bars[i]!;
    const previousClose = bars[i - 1]!.close;
    total += Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  }
  return total / period;
}

/** Highest close over the trailing `period` sessions, inclusive of `index`. */
export function highestClose(
  bars: readonly StrategyBar[],
  index: number,
  period: number,
): number | null {
  if (period <= 0 || index < period - 1 || index >= bars.length) return null;
  let highest = -Infinity;
  for (let i = index - period + 1; i <= index; i += 1) {
    highest = Math.max(highest, bars[i]!.close);
  }
  return highest;
}
