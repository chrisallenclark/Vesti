/**
 * What an intraday strategy sees, and the shape of what it decides.
 *
 * Kept apart from the daily `Strategy` interface rather than generalised over
 * both, because the two differ in the one place a shared abstraction would have
 * to lie: WHEN the decision is made. A daily strategy stands on a completed
 * session and every bar it reads is final. An intraday strategy stands inside
 * an unfinished one, and the last bar it is handed is the newest CLOSED minute,
 * never the forming one — that distinction is the whole of the look-ahead
 * discipline here, and folding the two interfaces together would put it behind
 * a comment instead of a type.
 *
 * The other difference is the clock. A daily strategy has no concept of "too
 * early" or "too late"; an intraday one is mostly a set of rules about when it
 * is allowed to act. Time is therefore an explicit input rather than something
 * read from the environment, so the same code runs identically in a test, in a
 * replay and in the live worker.
 *
 * As with the daily interface: a strategy proposes, it does not size. It must
 * supply a stop, because where the setup is wrong is a property of the setup.
 */

import type { ConvictionTier, MandateKind } from "../risk/types.ts";

/** One completed minute (or N-minute) bar. */
export interface IntradayBar {
  /** Bar OPEN time, UTC ISO. Alpaca stamps bars this way and so do we. */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Volume-weighted average price for the bar, when the venue supplies one. */
  vwap: number | null;
}

/** A position the intraday engine is currently carrying. */
export interface IntradayPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  stopPrice: number | null;
  targetPrice: number | null;
  /** When the position was opened, UTC ISO. Drives time-based exits. */
  openedAt: string;
}

export interface IntradayContext {
  /** The session date in US/Eastern, YYYY-MM-DD. */
  sessionDate: string;
  /**
   * Now, as minutes since midnight US/Eastern. 570 = 09:30, 960 = 16:00.
   *
   * Minutes-since-midnight rather than a Date because every rule in every
   * intraday strategy is a comparison against a wall-clock boundary, and doing
   * that arithmetic on timestamps in each rule is how one of them ends up in
   * the wrong timezone.
   */
  minuteOfDay: number;
  /**
   * Bars per symbol for TODAY only, oldest first, each one closed.
   *
   * Today only is deliberate. An intraday setup defined against an opening
   * range or a session VWAP is defined against this session; carrying yesterday
   * in silently changes what both mean.
   */
  bars: ReadonlyMap<string, readonly IntradayBar[]>;
  positions: readonly IntradayPosition[];
  /**
   * Symbols already traded today, whatever the outcome.
   *
   * Passed in rather than derived from `positions`, because the rule that
   * matters is about symbols NOT currently held — a name that was stopped out
   * at 10:05 is exactly the one a breakout rule will want to buy again at
   * 10:20, and re-entering it is how a session turns into forty round trips.
   */
  tradedToday: ReadonlySet<string>;
}

export interface IntradayEntry {
  kind: "entry";
  symbol: string;
  side: "buy";
  /** The price the decision was made at: the close of the last completed bar. */
  referencePrice: number;
  stopPrice: number;
  targetPrice: number;
  tier: ConvictionTier;
  reasons: string[];
  /** Everything the rule looked at, for the decision record. */
  signal: Record<string, number | string | boolean | null>;
}

export interface IntradayExit {
  kind: "exit";
  symbol: string;
  quantity: number;
  referencePrice: number;
  /** Stable key for the rule that closed it: 'stop', 'target', 'session_end'. */
  exitReason: string;
  reasons: string[];
}

export type IntradaySignal = IntradayEntry | IntradayExit;

/**
 * A rejection with its cause, for a symbol that was looked at and passed over.
 *
 * Returned rather than discarded because "why didn't it buy that?" has to be
 * answerable at the moment it was true. A strategy that emits only its entries
 * is a strategy nobody can audit — and the feed the operator watches is mostly
 * made of these.
 */
export interface IntradayPass {
  symbol: string;
  /**
   * Stable key for WHICH rule declined, with no numbers in it.
   *
   * Separate from `reason` because the reason contains live prices and ratios
   * that change on every bar, which makes it useless as a de-duplication key:
   * "breakout on 0.91x average volume" and "breakout on 0.93x average volume"
   * are the same fact told twice. Suppressing on the code turns the feed into a
   * record of when the market's STORY about a symbol changed, which is the part
   * worth reading; suppressing on the reason would write seventeen rows a minute
   * and be read by nobody.
   */
  code: string;
  reason: string;
}

export interface IntradayEvaluation {
  signals: IntradaySignal[];
  passes: IntradayPass[];
}

export interface IntradayStrategy {
  readonly key: string;
  readonly version: number;
  readonly mandate: MandateKind;
  /** DAY | CATALYST | WEALTH. The engine a trade is attributed to. */
  readonly engine: string;
  readonly describe: string;
  /** Bars of the current session needed before any rule means anything. */
  readonly warmupBars: number;
  evaluate(context: IntradayContext): IntradayEvaluation;
}

// ── Session clock ───────────────────────────────────────────────────────────

export const MARKET_OPEN_MINUTE = 9 * 60 + 30; // 09:30 ET
export const MARKET_CLOSE_MINUTE = 16 * 60; // 16:00 ET

/**
 * Minutes since midnight US/Eastern, and the Eastern calendar date, for an
 * instant.
 *
 * Uses `Intl` with an explicit zone rather than arithmetic on a fixed offset,
 * because the offset changes twice a year and the failure mode of getting it
 * wrong is a worker that trades an hour early — which looks like a strategy bug
 * for as long as it takes somebody to check the clock.
 */
export function easternClock(at: Date): { sessionDate: string; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  // en-CA renders midnight as "24" in some ICU versions; normalise it to 0 so
  // the first minute of the day does not sort after the last.
  const hour = Number(get("hour")) % 24;

  return {
    sessionDate: `${get("year")}-${get("month")}-${get("day")}`,
    minuteOfDay: hour * 60 + Number(get("minute")),
  };
}
