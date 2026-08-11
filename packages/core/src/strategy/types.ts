/**
 * What a strategy is, and what it is not.
 *
 * A strategy here is a PURE function from point-in-time bars to intents. It
 * cannot read the database, cannot call a model, cannot know the time, and
 * cannot see a bar dated after the session it is standing on. Those are not
 * stylistic restrictions — they are what makes the same code usable by the
 * backtester and the live loop without either being a reimplementation of the
 * other. A strategy that behaves differently in a backtest than in production
 * has invalidated the backtest, and you will not find out which one was wrong
 * until real money has answered the question.
 *
 * A strategy produces an INTENT. It does not size, and it may not: sizing is
 * the risk engine's, and a strategy able to choose its own size can overrule
 * every limit in the system by asking for more. The one number a strategy must
 * supply is the stop, because where the thesis is wrong is a property of the
 * setup and nothing downstream can infer it.
 */

import type { ConvictionTier, MandateKind, Side } from "../risk/types.ts";

/** One session of one instrument, already split-adjusted by the PIT layer. */
export interface StrategyBar {
  sessionDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** What the strategy already holds, so it can decide to exit as well as enter. */
export interface StrategyPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  /** The protective stop recorded on the lots at entry. */
  stopPrice: number | null;
  /** Sessions since the position was opened. Drives time-based exits. */
  sessionsHeld: number;
}

export interface StrategyContext {
  /** The session being decided. No bar after this date is visible. */
  asOf: string;
  /**
   * History per symbol, oldest first, ending at `asOf`.
   *
   * The loop builds this from `pit_bars_daily` with an as-of instant, so the
   * look-ahead prevention is the database's, not a convention this interface
   * asks implementers to respect.
   */
  bars: ReadonlyMap<string, readonly StrategyBar[]>;
  positions: readonly StrategyPosition[];
}

export interface EntrySignal {
  kind: "entry";
  symbol: string;
  side: Side;
  /** Where the thesis is wrong. Required — a setup without one cannot be sized. */
  stopPrice: number;
  targetPrice: number | null;
  tier: ConvictionTier;
  /** Why, in the words of the rule that fired. Ends up on the pre-trade record. */
  reasons: string[];
}

export interface ExitSignal {
  kind: "exit";
  symbol: string;
  /** Shares to close. The loop clamps this to what the mandate actually holds. */
  quantity: number;
  reasons: string[];
}

export type StrategySignal = EntrySignal | ExitSignal;

/**
 * The promotion ladder, mirrored from `strategy_status` in the database.
 *
 * The loop trades a strategy only at `paper_approved` or above. That gate is
 * the difference between a system that can run unattended and one that merely
 * does: promotion out of `experimental` is a deterministic evaluation against
 * Phase 4's validation ladder, never a judgement call and never a default.
 */
export type StrategyStatus =
  | "experimental"
  | "validating"
  | "paper_approved"
  | "live_limited"
  | "live_scaled"
  | "paused"
  | "retired";

export const TRADEABLE_ON_PAPER: ReadonlySet<StrategyStatus> = new Set([
  "paper_approved",
  "live_limited",
  "live_scaled",
]);

export interface Strategy {
  /** Stable identifier; matches `strategies.key` in the database. */
  readonly key: string;
  readonly version: number;
  readonly mandate: MandateKind;
  /** How many sessions of history the rules need before they mean anything. */
  readonly warmupSessions: number;
  readonly describe: string;
  evaluate(context: StrategyContext): StrategySignal[];
}
