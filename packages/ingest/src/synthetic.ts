/**
 * The synthetic generator, wearing the same interface as a real vendor.
 *
 * This is what makes the whole pipeline runnable and testable with no network
 * and no API key: symbols resolve, partitions provision, bars validate, splits
 * land in `corporate_actions` with honest announcement times, and the PIT layer
 * has something to adjust. The only thing that changes when real keys arrive is
 * which class is constructed in the CLI.
 *
 * Every bar is tagged `tape = 'synthetic'`, so no generated print can ever be
 * confused with something that traded.
 */

import {
  generateSeries,
  type RegimeSegment,
  type SyntheticSpec,
} from "@vesti/core/sim/generator.ts";
import type {
  MarketDataProvider,
  RawCorporateAction,
  RawDailyBar,
  Tape,
} from "./provider.ts";

export interface SyntheticProviderOptions {
  seed: number | string;
  /** Per-symbol overrides; anything absent falls back to the defaults below. */
  profiles?: Record<string, Partial<Omit<SyntheticSpec, "symbol" | "seed">>>;
  /** Regime sequence applied to every symbol without its own profile. */
  regimes?: readonly RegimeSegment[];
  startPrice?: number;
}

/**
 * A full market cycle rather than a single mood: about six years of sessions
 * covering two advances, a crash, a recovery, chop, and a decline. A strategy
 * validated only against an uptrend has not been validated.
 */
const DEFAULT_REGIMES: readonly RegimeSegment[] = [
  { kind: "trend_up", sessions: 320 },
  { kind: "choppy", sessions: 180 },
  { kind: "crash", sessions: 45 },
  { kind: "recovery", sessions: 150 },
  { kind: "trend_up", sessions: 260 },
  { kind: "high_vol", sessions: 120 },
  { kind: "trend_down", sessions: 200 },
  { kind: "choppy", sessions: 240 },
];

export class SyntheticProvider implements MarketDataProvider {
  readonly slug = "synthetic";
  readonly tape: Tape = "synthetic";

  constructor(private readonly options: SyntheticProviderOptions) {}

  async fetchDailyBars(
    symbols: readonly string[],
    from: string,
    to: string,
  ): Promise<RawDailyBar[]> {
    return this.build(symbols, from).bars.filter(
      (bar) => bar.sessionDate >= from && bar.sessionDate <= to,
    );
  }

  async fetchCorporateActions(
    symbols: readonly string[],
    from: string,
    to: string,
  ): Promise<RawCorporateAction[]> {
    return this.build(symbols, from).actions.filter(
      (action) => action.exDate >= from && action.exDate <= to,
    );
  }

  private build(
    symbols: readonly string[],
    from: string,
  ): { bars: RawDailyBar[]; actions: RawCorporateAction[] } {
    const bars: RawDailyBar[] = [];
    const actions: RawCorporateAction[] = [];

    for (const symbol of symbols) {
      const profile = this.options.profiles?.[symbol] ?? {};
      const series = generateSeries({
        symbol,
        seed: this.options.seed,
        startDate: profile.startDate ?? from,
        startPrice: profile.startPrice ?? this.options.startPrice ?? 100,
        regimes: profile.regimes ?? this.options.regimes ?? DEFAULT_REGIMES,
        ...(profile.baseVolume !== undefined ? { baseVolume: profile.baseVolume } : {}),
        ...(profile.splits !== undefined ? { splits: profile.splits } : {}),
        ...(profile.dividends !== undefined ? { dividends: profile.dividends } : {}),
      });

      for (const bar of series.bars) {
        bars.push({
          symbol: bar.symbol,
          sessionDate: bar.sessionDate,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          tradeCount: bar.tradeCount,
          vwap: bar.vwap,
        });
      }

      for (const action of series.corporateActions) {
        actions.push({
          symbol: action.symbol,
          kind: action.kind,
          exDate: action.exDate,
          announcedAt: action.announcedAt,
          ...(action.splitRatio !== undefined ? { splitRatio: action.splitRatio } : {}),
          ...(action.cashAmount !== undefined ? { cashAmount: action.cashAmount } : {}),
        });
      }
    }

    return { bars, actions };
  }
}
