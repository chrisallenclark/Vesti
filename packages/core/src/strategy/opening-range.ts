/**
 * DAY engine, Version 0.1: opening-range breakout with VWAP and volume
 * confirmation.
 *
 * READ THIS BEFORE PROMOTING IT.
 *
 * This is not a validated edge and no part of this file claims one. It has been
 * through no backtest, no walk-forward and no regime stratification, because
 * the Strategy Lab that would produce those is Phase 4. It ships at
 * `experimental` and the loop will not trade it until somebody promotes it by
 * hand, with their eyes open, to paper.
 *
 * What it IS for: proving that the machine can see a real market, decide, be
 * checked by the risk engine, reach the venue, take the fill back, carry the
 * position and close it — all inside one session, unattended, while somebody
 * watches. A daily swing strategy cannot demonstrate that; it opens a position
 * on Tuesday and closes it a fortnight later. The DAY engine can do the whole
 * loop in an hour, which is what makes the loop observable at all.
 *
 * The rules, and why each one is there:
 *
 *   OPENING RANGE. The high and low of the first thirty minutes. The open is
 *   the noisiest part of the session — overnight orders clearing, gaps being
 *   priced — and a level drawn from it is the first thing all day that a large
 *   number of participants can see and agree on. Nothing is traded until it is
 *   complete, which is also what keeps the first thirty minutes from producing
 *   signals off two bars of history.
 *
 *   BREAKOUT. The last completed bar closes above the range high. Closes, not
 *   touches: a wick through a level is the market testing it and the body
 *   closing through it is the market accepting it, and acting on the wick is
 *   how a breakout system spends its day buying the highs of failed pushes.
 *
 *   VWAP. Price must also be above the session's volume-weighted average.
 *   VWAP is where the day's average participant is, so a breakout below it is a
 *   rally inside a distribution — the sellers are still winning even though the
 *   level broke. This filter removes most of the failed morning pushes and
 *   costs a handful of the real ones. That trade is the right way round for a
 *   system that has to survive being wrong repeatedly.
 *
 *   VOLUME. The breakout bar must trade at a multiple of the session's average
 *   bar so far. A level that gives way on no volume gave way because nobody was
 *   there, and it will give way back for the same reason. Note that this is a
 *   RATIO against bars from the same feed, which is what makes it usable on the
 *   partial IEX tape the real-time path reads: the tape's share of consolidated
 *   volume cancels out of a ratio, where an absolute threshold would be
 *   silently wrong by a factor of forty.
 *
 *   NO CHASING. If price is already extended more than half the range width
 *   above the level, the move has happened and what is left is the part where
 *   the stop is far away and the reward is not. The rule is a bound rather than
 *   a judgement, so it does not need a human to apply it.
 *
 *   STOP. A quarter of the range width back INSIDE the range. The setup's claim
 *   is that the level now holds; price re-entering the range is that claim being
 *   falsified, and the stop belongs where the thesis dies rather than at a round
 *   percentage. This is the number handed to the risk engine to size against.
 *
 *   TARGET. Two times the risked distance. A day trade needs an exit rule that
 *   fires while somebody is still watching; letting winners run is correct for
 *   a trend system holding for weeks and is how an intraday system gives back
 *   its gains into the close.
 *
 *   FLAT BY THE CLOSE. Everything is closed at 15:45 ET regardless. Carrying an
 *   intraday position overnight converts it into a different trade with
 *   different risk — the gap — that nothing in the sizing accounted for.
 *
 *   ONE SHOT PER SYMBOL PER DAY. A name that has already been traded today is
 *   not looked at again. Without this, a symbol oscillating around its range
 *   high produces an entry, a stop, another entry and another stop, and the
 *   session's result is a commission report.
 */

import type { MandateKind } from "../risk/types.ts";
import type {
  IntradayBar,
  IntradayContext,
  IntradayEvaluation,
  IntradayPass,
  IntradaySignal,
  IntradayStrategy,
} from "./intraday.ts";
import { MARKET_OPEN_MINUTE } from "./intraday.ts";

export interface OpeningRangeConfig {
  /** Length of the opening range, in minutes from the open. */
  openingRangeMinutes?: number;
  /** No entries before this many minutes past the open. */
  entryOpensAtMinute?: number;
  /** No new entries after this wall-clock minute (ET). */
  entryClosesAtMinute?: number;
  /** Everything is flattened at or after this minute (ET). */
  flattenAtMinute?: number;
  /** Breakout bar volume must be at least this multiple of the session mean. */
  volumeMultiple?: number;
  /** Refuse an entry more than this multiple of the range width above the high. */
  maxExtensionMultiple?: number;
  /** Stop this fraction of the range width back inside the range. */
  stopFractionOfRange?: number;
  /** Target as a multiple of the risked distance. */
  targetR?: number;
  /** Range must be at least this fraction of price to be a real level. */
  minRangeFraction?: number;
  /** Range wider than this fraction of price is a gap, not a range. */
  maxRangeFraction?: number;
  /** Positions this strategy may carry at once. */
  maxConcurrentPositions?: number;
  /** Entries proposed in a single evaluation. One keeps the loop legible. */
  maxEntriesPerCycle?: number;
}

const DEFAULTS: Required<OpeningRangeConfig> = {
  openingRangeMinutes: 30,
  entryOpensAtMinute: 10 * 60, // 10:00 ET — the range must be complete
  entryClosesAtMinute: 15 * 60 + 30, // 15:30 ET
  flattenAtMinute: 15 * 60 + 45, // 15:45 ET
  volumeMultiple: 1.5,
  maxExtensionMultiple: 0.5,
  stopFractionOfRange: 0.25,
  targetR: 2,
  minRangeFraction: 0.001,
  maxRangeFraction: 0.03,
  maxConcurrentPositions: 3,
  maxEntriesPerCycle: 1,
};

export class OpeningRangeBreakout implements IntradayStrategy {
  readonly key = "day.opening_range_breakout";
  readonly version = 1;
  readonly mandate: MandateKind = "active";
  readonly engine = "DAY";
  readonly describe =
    "Long the opening-range high on volume, above session VWAP; stop back inside the range, 2R target, flat by 15:45 ET. UNVALIDATED.";

  private readonly config: Required<OpeningRangeConfig>;

  constructor(config: OpeningRangeConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  get warmupBars(): number {
    return this.config.openingRangeMinutes;
  }

  evaluate(context: IntradayContext): IntradayEvaluation {
    const signals: IntradaySignal[] = [];
    const passes: IntradayPass[] = [];

    // ── Exits first, and unconditionally ──────────────────────────────────
    // An exit that competes with entries for a per-cycle budget is a stop that
    // sometimes does not fire. Nothing below this block can consume the budget
    // these need.
    const held = new Set<string>();
    for (const position of context.positions) {
      held.add(position.symbol);
      const bars = context.bars.get(position.symbol);
      const last = bars?.at(-1);

      if (context.minuteOfDay >= this.config.flattenAtMinute) {
        signals.push({
          kind: "exit",
          symbol: position.symbol,
          quantity: position.quantity,
          referencePrice: last?.close ?? position.averageCost,
          exitReason: "session_end",
          reasons: [
            `flat by ${formatMinute(this.config.flattenAtMinute)} ET — an intraday position ` +
              `carried overnight is a different trade than the one that was sized`,
          ],
        });
        continue;
      }

      if (!last) {
        // No data for something we are holding is a reason to say so loudly,
        // not a reason to conclude there is nothing to do.
        passes.push({ symbol: position.symbol, code: "no_bars", reason: "held but no bars this session" });
        continue;
      }

      // The bar LOW against the stop, not the close: if price traded through
      // the stop inside the bar, the stop was hit, and reading the close would
      // mean a position that dipped through its invalidation and recovered gets
      // carried on a thesis that was already falsified.
      if (position.stopPrice !== null && last.low <= position.stopPrice) {
        signals.push({
          kind: "exit",
          symbol: position.symbol,
          quantity: position.quantity,
          referencePrice: last.close,
          exitReason: "stop",
          reasons: [
            `stop ${position.stopPrice.toFixed(2)} breached — low ${last.low.toFixed(2)} ` +
              `is back inside the opening range`,
          ],
        });
        continue;
      }

      if (position.targetPrice !== null && last.high >= position.targetPrice) {
        signals.push({
          kind: "exit",
          symbol: position.symbol,
          quantity: position.quantity,
          referencePrice: last.close,
          exitReason: "target",
          reasons: [
            `target ${position.targetPrice.toFixed(2)} reached — high ${last.high.toFixed(2)} ` +
              `at ${this.config.targetR}R`,
          ],
        });
      }
    }

    // ── Entries ───────────────────────────────────────────────────────────
    if (context.minuteOfDay < this.config.entryOpensAtMinute) {
      return { signals, passes };
    }
    if (context.minuteOfDay >= this.config.entryClosesAtMinute) {
      return { signals, passes };
    }
    if (context.positions.length >= this.config.maxConcurrentPositions) {
      return { signals, passes };
    }

    const candidates: Array<{ signal: IntradaySignal; volumeRatio: number; symbol: string }> = [];

    for (const [symbol, bars] of context.bars) {
      if (held.has(symbol)) continue;
      if (context.tradedToday.has(symbol)) {
        passes.push({
          symbol,
          code: "already_traded",
          reason: "already traded today — one shot per symbol per session",
        });
        continue;
      }
      if (bars.length < this.config.openingRangeMinutes) {
        passes.push({
          symbol,
          code: "warming_up",
          reason: `${bars.length} bar(s) this session, needs ${this.config.openingRangeMinutes}`,
        });
        continue;
      }

      const range = openingRange(bars, context.sessionDate, this.config.openingRangeMinutes);
      if (!range) {
        passes.push({ symbol, code: "no_opening_range", reason: "no complete opening range" });
        continue;
      }

      const last = bars.at(-1)!;
      const width = range.high - range.low;
      const rangeFraction = width / last.close;

      if (rangeFraction < this.config.minRangeFraction) {
        passes.push({
          symbol,
          code: "range_too_tight",
          reason: `opening range ${(rangeFraction * 100).toFixed(2)}% is too tight to be a level`,
        });
        continue;
      }
      if (rangeFraction > this.config.maxRangeFraction) {
        passes.push({
          symbol,
          code: "range_is_a_gap",
          reason: `opening range ${(rangeFraction * 100).toFixed(2)}% is a gap, not a range`,
        });
        continue;
      }

      if (last.close <= range.high) {
        passes.push({
          symbol,
          code: "no_breakout",
          reason: `${last.close.toFixed(2)} has not closed above the range high ${range.high.toFixed(2)}`,
        });
        continue;
      }

      const vwap = sessionVwap(bars);
      if (vwap === null) {
        passes.push({
          symbol,
          code: "no_volume",
          reason: "no volume this session — cannot compute VWAP",
        });
        continue;
      }
      if (last.close <= vwap) {
        passes.push({
          symbol,
          code: "below_vwap",
          reason: `broke out at ${last.close.toFixed(2)} but is below VWAP ${vwap.toFixed(2)}`,
        });
        continue;
      }

      const meanVolume = averageVolume(bars);
      const volumeRatio = meanVolume > 0 ? last.volume / meanVolume : 0;
      if (volumeRatio < this.config.volumeMultiple) {
        passes.push({
          symbol,
          code: "thin_volume",
          reason:
            `breakout on ${volumeRatio.toFixed(2)}x average volume, ` +
            `needs ${this.config.volumeMultiple}x`,
        });
        continue;
      }

      const extension = (last.close - range.high) / width;
      if (extension > this.config.maxExtensionMultiple) {
        passes.push({
          symbol,
          code: "too_extended",
          reason:
            `already ${extension.toFixed(2)}x the range above the high — ` +
            `too extended to enter`,
        });
        continue;
      }

      const stopPrice = round2(range.high - this.config.stopFractionOfRange * width);
      const risk = last.close - stopPrice;
      if (!(risk > 0)) {
        passes.push({ symbol, code: "bad_stop", reason: "stop is not below the entry price" });
        continue;
      }
      const targetPrice = round2(last.close + this.config.targetR * risk);

      candidates.push({
        symbol,
        volumeRatio,
        signal: {
          kind: "entry",
          symbol,
          side: "buy",
          referencePrice: last.close,
          stopPrice,
          targetPrice,
          // Never above the floor tier: a rule set nobody has validated has not
          // earned a size multiplier, whatever it looks like on the day.
          tier: "experimental",
          reasons: [
            `closed ${last.close.toFixed(2)} above the opening-range high ${range.high.toFixed(2)}`,
            `above session VWAP ${vwap.toFixed(2)}`,
            `on ${volumeRatio.toFixed(2)}x the session's average bar volume`,
            `stop ${stopPrice.toFixed(2)} is ${(this.config.stopFractionOfRange * 100).toFixed(0)}% ` +
              `of the range back inside it; target ${targetPrice.toFixed(2)} at ${this.config.targetR}R`,
          ],
          signal: {
            openingRangeHigh: round2(range.high),
            openingRangeLow: round2(range.low),
            openingRangeWidth: round2(width),
            vwap: round2(vwap),
            volumeRatio: Number(volumeRatio.toFixed(3)),
            extensionMultiple: Number(extension.toFixed(3)),
            barTs: last.ts,
            barsThisSession: bars.length,
            minuteOfDay: context.minuteOfDay,
          },
        },
      });
    }

    // Strongest volume confirmation first, ties broken by symbol so two runs
    // over the same data cannot pick different names.
    candidates.sort((a, b) => b.volumeRatio - a.volumeRatio || a.symbol.localeCompare(b.symbol));

    const room = Math.min(
      this.config.maxEntriesPerCycle,
      this.config.maxConcurrentPositions - context.positions.length,
    );
    for (const candidate of candidates.slice(0, Math.max(0, room))) {
      signals.push(candidate.signal);
    }
    for (const candidate of candidates.slice(Math.max(0, room))) {
      passes.push({
        symbol: candidate.symbol,
        code: "lost_the_slot",
        reason: "qualified, but a stronger breakout took this cycle's slot",
      });
    }

    return { signals, passes };
  }
}

// ── Session arithmetic ──────────────────────────────────────────────────────

/**
 * High and low of the first `minutes` of the session.
 *
 * Returns null unless the range is COMPLETE — a bar stamped at or after the end
 * of the window has to exist, which is the proof that the window closed rather
 * than that the data ran out. Without that check a worker starting at 09:45
 * would draw a fifteen-minute range and call it a thirty-minute one.
 */
export function openingRange(
  bars: readonly IntradayBar[],
  sessionDate: string,
  minutes: number,
): { high: number; low: number } | null {
  const endMinute = MARKET_OPEN_MINUTE + minutes;
  let high = -Infinity;
  let low = Infinity;
  let sawWindow = false;
  let sawAfter = false;

  for (const bar of bars) {
    const minute = easternMinuteOf(bar.ts);
    if (minute === null) continue;
    if (minute < MARKET_OPEN_MINUTE) continue; // pre-market print
    if (minute < endMinute) {
      sawWindow = true;
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
    } else {
      sawAfter = true;
    }
  }

  if (!sawWindow || !sawAfter || !Number.isFinite(high) || !Number.isFinite(low)) return null;
  void sessionDate;
  return { high, low };
}

/**
 * Session VWAP from the bars supplied.
 *
 * Uses each bar's own VWAP when the venue gives one and the typical price
 * otherwise, which is the standard approximation and is within a cent on a
 * one-minute bar of a liquid name.
 */
export function sessionVwap(bars: readonly IntradayBar[]): number | null {
  let notional = 0;
  let volume = 0;
  for (const bar of bars) {
    const price = bar.vwap ?? (bar.high + bar.low + bar.close) / 3;
    notional += price * bar.volume;
    volume += bar.volume;
  }
  return volume > 0 ? notional / volume : null;
}

/** Mean bar volume across the session so far, excluding the newest bar. */
export function averageVolume(bars: readonly IntradayBar[]): number {
  if (bars.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < bars.length - 1; i += 1) total += bars[i]!.volume;
  return total / (bars.length - 1);
}

/** Minutes since midnight ET for a bar timestamp, or null if unparseable. */
function easternMinuteOf(ts: string): number | null {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function formatMinute(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
