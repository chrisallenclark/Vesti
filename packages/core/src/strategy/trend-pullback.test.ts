/**
 * The reference strategy's rules, against hand-built series.
 *
 * Built rather than generated, because each case exists to pin one rule: a
 * strategy test that only asserts "it produced some signals" passes just as
 * happily when the regime filter is inverted.
 *
 * The warm-up assertions matter more than they look. An indicator that seeds
 * itself over partial history is a different, faster indicator wearing the same
 * name, and a strategy that silently trades during its own warm-up has been
 * validated on rules it does not run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TrendPullback } from "./trend-pullback.ts";
import type { StrategyBar, StrategyContext, EntrySignal, ExitSignal } from "./types.ts";

/** A series that rises steadily, so the 200-day trend filter is satisfied. */
function uptrend(sessions: number, start = 100, drift = 0.4): StrategyBar[] {
  const bars: StrategyBar[] = [];
  let close = start;
  for (let i = 0; i < sessions; i += 1) {
    close += drift;
    bars.push({
      sessionDate: session(i),
      open: close - 0.1,
      high: close + 0.6,
      low: close - 0.6,
      close,
      volume: 5_000_000,
    });
  }
  return bars;
}

function session(index: number): string {
  const date = new Date(Date.UTC(2024, 0, 2));
  date.setUTCDate(date.getUTCDate() + index);
  return date.toISOString().slice(0, 10);
}

/** Dips the last `dipLength` bars below the fast average, then reclaims on the final one. */
function withPullbackAndReclaim(bars: StrategyBar[], dipLength = 3): StrategyBar[] {
  const out = bars.map((b) => ({ ...b }));
  const last = out.length - 1;
  for (let i = last - dipLength; i < last; i += 1) {
    const bar = out[i]!;
    bar.close -= 6;
    bar.low = bar.close - 1.5;
    bar.high = bar.close + 0.5;
    bar.open = bar.close + 0.2;
  }
  const final = out[last]!;
  final.close += 2;
  final.high = final.close + 0.5;
  final.low = final.close - 3;
  return out;
}

function context(bars: Record<string, StrategyBar[]>, positions: StrategyContext["positions"] = []): StrategyContext {
  const map = new Map(Object.entries(bars));
  const any = Object.values(bars)[0] ?? [];
  return { asOf: any.at(-1)?.sessionDate ?? "2024-01-02", bars: map, positions };
}

const strategy = new TrendPullback();

describe("TrendPullback entries", () => {
  it("takes nothing until it has its full warm-up of history", () => {
    // 200-day filter on 150 days of data is a much faster line by the same
    // name. Refusing is the only honest answer.
    const bars = withPullbackAndReclaim(uptrend(150));
    const signals = strategy.evaluate(context({ SHORTHIST: bars }));
    assert.deepEqual(signals, []);
  });

  it("enters on a reclaim after a pullback inside an uptrend", () => {
    const bars = withPullbackAndReclaim(uptrend(260));
    const signals = strategy.evaluate(context({ TREND: bars }));
    const entry = signals.find((s): s is EntrySignal => s.kind === "entry");
    assert.ok(entry, "expected an entry");
    assert.equal(entry.symbol, "TREND");
    assert.equal(entry.side, "buy");
    assert.equal(entry.tier, "experimental", "unvalidated rules may not claim conviction");
    assert.ok(entry.stopPrice < bars.at(-1)!.close, "stop must sit below the entry");
    assert.ok(entry.reasons.length >= 3, "the reasons are what reaches the pre-trade record");
  });

  it("refuses a downtrend however deep the pullback", () => {
    // The regime filter is the one rule doing real work in a simple long
    // system. Inverting it would still produce plausible-looking trades.
    const falling = uptrend(260, 300, -0.4);
    const signals = strategy.evaluate(context({ FALLING: withPullbackAndReclaim(falling) }));
    assert.deepEqual(signals.filter((s) => s.kind === "entry"), []);
  });

  it("refuses an uptrend that has not pulled back", () => {
    // Buying a trend that never paused is buying extension.
    const signals = strategy.evaluate(context({ EXTENDED: uptrend(260) }));
    assert.deepEqual(signals.filter((s) => s.kind === "entry"), []);
  });

  it("does not enter a name it already holds", () => {
    const bars = withPullbackAndReclaim(uptrend(260));
    const signals = strategy.evaluate(
      context({ TREND: bars }, [
        { symbol: "TREND", quantity: 10, averageCost: 100, stopPrice: 1, sessionsHeld: 5 },
      ]),
    );
    assert.deepEqual(signals.filter((s) => s.kind === "entry"), []);
  });

  it("caps entries per session and picks deterministically", () => {
    const bars = {
      AAA: withPullbackAndReclaim(uptrend(260, 100, 0.4)),
      BBB: withPullbackAndReclaim(uptrend(260, 100, 0.6)),
      CCC: withPullbackAndReclaim(uptrend(260, 100, 0.5)),
    };
    const first = strategy.evaluate(context(bars)).filter((s) => s.kind === "entry");
    const second = strategy.evaluate(context(bars)).filter((s) => s.kind === "entry");
    assert.equal(first.length, 2, "default cap is two entries a session");
    assert.deepEqual(
      first.map((s) => s.symbol),
      second.map((s) => s.symbol),
      "the same data must select the same names, or no run is reproducible",
    );
  });
});

describe("TrendPullback exits", () => {
  it("exits when the session low breaches the stop", () => {
    const bars = uptrend(260);
    const last = bars.at(-1)!;
    const signals = strategy.evaluate(
      context({ HELD: bars }, [
        {
          symbol: "HELD",
          quantity: 25,
          averageCost: 100,
          stopPrice: last.low + 1,
          sessionsHeld: 9,
        },
      ]),
    );
    const exit = signals.find((s): s is ExitSignal => s.kind === "exit");
    assert.ok(exit);
    assert.equal(exit.quantity, 25);
    assert.match(exit.reasons[0] ?? "", /stop/);
  });

  it("exits on losing the fast average even with the stop intact", () => {
    const bars = uptrend(260);
    // Drop the final close well below the 20-day line without touching the stop.
    const broken = bars.map((b) => ({ ...b }));
    const last = broken.at(-1)!;
    last.close -= 20;
    last.low = last.close - 1;

    const signals = strategy.evaluate(
      context({ HELD: broken }, [
        { symbol: "HELD", quantity: 8, averageCost: 50, stopPrice: 1, sessionsHeld: 30 },
      ]),
    );
    const exit = signals.find((s): s is ExitSignal => s.kind === "exit");
    assert.ok(exit);
    assert.match(exit.reasons[0] ?? "", /average/);
  });

  it("produces exits even when the entry budget is already full", () => {
    // An exit that competes with entries for a per-session cap is a stop that
    // sometimes does not fire.
    const held = uptrend(260);
    held.at(-1)!.close -= 20;
    held.at(-1)!.low = held.at(-1)!.close - 1;

    const signals = strategy.evaluate(
      context(
        {
          HELD: held,
          AAA: withPullbackAndReclaim(uptrend(260, 100, 0.4)),
          BBB: withPullbackAndReclaim(uptrend(260, 100, 0.6)),
          CCC: withPullbackAndReclaim(uptrend(260, 100, 0.5)),
        },
        [{ symbol: "HELD", quantity: 8, averageCost: 50, stopPrice: 1, sessionsHeld: 30 }],
      ),
    );
    assert.equal(signals.filter((s) => s.kind === "exit").length, 1);
    assert.equal(signals.filter((s) => s.kind === "entry").length, 2);
  });
});
