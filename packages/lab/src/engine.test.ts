/**
 * The properties that make a backtest an argument rather than a story.
 *
 * These are not tests of the strategy. They are tests that the harness cannot
 * flatter one — that it cannot show a strategy a price before that price
 * existed, cannot fill a decision at the bar that produced it, and cannot sell
 * shares it never bought. Each of those bugs produces a better-looking result,
 * which is exactly why none of them would be noticed by reading the output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  Strategy,
  StrategyBar,
  StrategyContext,
  StrategySignal,
} from "@vesti/core/strategy/types.ts";
import { runBacktest } from "./engine.ts";
import { buyAndHold, roundTrips, summarise } from "./metrics.ts";

/** A rising series with a known shape, so expectations can be exact. */
function series(count: number, start = 100, step = 1): StrategyBar[] {
  const bars: StrategyBar[] = [];
  let date = new Date(Date.UTC(2020, 0, 6)); // a Monday
  for (let i = 0; i < count; i++) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      const close = start + i * step;
      bars.push({
        sessionDate: date.toISOString().slice(0, 10),
        open: close,
        high: close + 0.5,
        low: close - 0.5,
        close,
        volume: 5_000_000,
      });
    }
    date = new Date(date.getTime() + 86_400_000);
  }
  return bars;
}

/** Records every context it is given, and emits whatever it is told to. */
function spyStrategy(emit: (context: StrategyContext) => StrategySignal[]): {
  strategy: Strategy;
  seen: StrategyContext[];
} {
  const seen: StrategyContext[] = [];
  const strategy: Strategy = {
    key: "test.spy",
    version: 1,
    mandate: "active",
    warmupSessions: 0,
    describe: "records what it was shown",
    evaluate(context) {
      seen.push({
        asOf: context.asOf,
        bars: new Map([...context.bars].map(([k, v]) => [k, [...v]])),
        positions: [...context.positions],
      });
      return emit(context);
    },
  };
  return { strategy, seen };
}

describe("look-ahead", () => {
  it("never shows a strategy a bar dated after the session being decided", async () => {
    const bars = new Map([["AAA", series(40)]]);
    const { strategy, seen } = spyStrategy(() => []);

    await runBacktest({ strategy, bars, startingCash: 100_000 });

    assert.ok(seen.length > 0, "the strategy should have been consulted");
    for (const context of seen) {
      for (const [, history] of context.bars) {
        const last = history.at(-1);
        assert.ok(last, "history should not be empty");
        assert.ok(
          last.sessionDate <= context.asOf,
          `saw ${last.sessionDate} while deciding ${context.asOf}`,
        );
      }
    }
  });

  it("shows history that grows by exactly one session at a time", async () => {
    const bars = new Map([["AAA", series(30)]]);
    const { strategy, seen } = spyStrategy(() => []);

    await runBacktest({ strategy, bars, startingCash: 100_000 });

    for (let i = 1; i < seen.length; i++) {
      const before = seen[i - 1]!.bars.get("AAA")!.length;
      const after = seen[i]!.bars.get("AAA")!.length;
      assert.equal(after, before + 1, `history jumped from ${before} to ${after}`);
    }
  });

  it("respects warmup, so rules never fire on a truncated series", async () => {
    const bars = new Map([["AAA", series(40)]]);
    const { strategy, seen } = spyStrategy(() => []);
    const warmed: Strategy = { ...strategy, warmupSessions: 10, evaluate: strategy.evaluate };

    await runBacktest({ strategy: warmed, bars, startingCash: 100_000 });

    assert.ok(seen.length > 0);
    for (const context of seen) {
      assert.ok(
        context.bars.get("AAA")!.length > 10,
        "decided on fewer sessions than the warmup requires",
      );
    }
  });
});

describe("fills", () => {
  it("does not fill an order on the bar that produced it", async () => {
    const bars = new Map([["AAA", series(40)]]);
    // Annotated because control flow narrows the initial `null` to `never`
    // after the assignment inside the callback, and the assertion below needs
    // it to still be a string.
    let emitted: string | null = null as string | null;

    const { strategy } = spyStrategy((context) => {
      if (emitted !== null) return [];
      emitted = context.asOf;
      return [
        {
          kind: "entry",
          symbol: "AAA",
          side: "buy",
          stopPrice: context.bars.get("AAA")!.at(-1)!.close * 0.95,
          targetPrice: null,
          tier: "standard",
          reasons: ["test entry"],
        },
      ];
    });

    const result = await runBacktest({ strategy, bars, startingCash: 100_000 });

    assert.equal(result.trades.length, 1, "expected exactly one fill");
    assert.ok(emitted, "the signal should have been emitted");
    assert.ok(
      result.trades[0]!.sessionDate > emitted,
      `filled on ${result.trades[0]!.sessionDate}, the same session that decided it`,
    );
  });

  it("pays more than the close it decided from, never less", async () => {
    const bars = new Map([["AAA", series(40)]]);
    let signalled = false;

    const { strategy } = spyStrategy((context) => {
      if (signalled) return [];
      signalled = true;
      return [
        {
          kind: "entry",
          symbol: "AAA",
          side: "buy",
          stopPrice: context.bars.get("AAA")!.at(-1)!.close * 0.95,
          targetPrice: null,
          tier: "standard",
          reasons: ["test entry"],
        },
      ];
    });

    const result = await runBacktest({ strategy, bars, startingCash: 100_000 });
    const fill = result.trades[0]!;
    const fillBar = bars.get("AAA")!.find((b) => b.sessionDate === fill.sessionDate)!;

    // Spread and impact are costs, so a buy cannot fill below the bar's open in
    // a rising series. A harness that filled at the decision close would show a
    // free gain on every entry.
    assert.ok(
      fill.price >= fillBar.open,
      `filled at ${fill.price}, below the ${fillBar.open} open it should have crossed`,
    );
  });

  it("never sells more than is held", async () => {
    const bars = new Map([["AAA", series(60)]]);
    let bought = false;

    const { strategy } = spyStrategy((context) => {
      const held = context.positions.find((p) => p.symbol === "AAA");
      if (!bought) {
        bought = true;
        return [
          {
            kind: "entry",
            symbol: "AAA",
            side: "buy",
            stopPrice: context.bars.get("AAA")!.at(-1)!.close * 0.95,
            targetPrice: null,
            tier: "standard",
            reasons: ["entry"],
          },
        ];
      }
      // Asks to sell far more than could ever have been bought.
      if (held) {
        return [{ kind: "exit", symbol: "AAA", quantity: 100_000, reasons: ["exit"] }];
      }
      return [];
    });

    const result = await runBacktest({ strategy, bars, startingCash: 100_000 });

    const boughtQty = result.trades
      .filter((t) => t.side === "buy")
      .reduce((sum, t) => sum + t.quantity, 0);
    const soldQty = result.trades
      .filter((t) => t.side === "sell")
      .reduce((sum, t) => sum + t.quantity, 0);

    assert.ok(soldQty <= boughtQty, `sold ${soldQty} having bought only ${boughtQty}`);
  });

  it("orders whole shares only", async () => {
    const bars = new Map([["AAA", series(40)]]);
    let signalled = false;
    const { strategy } = spyStrategy((context) => {
      if (signalled) return [];
      signalled = true;
      return [
        {
          kind: "entry",
          symbol: "AAA",
          side: "buy",
          // An awkward stop, to push the sizing arithmetic off a round number.
          stopPrice: context.bars.get("AAA")!.at(-1)!.close * 0.9137,
          targetPrice: null,
          tier: "standard",
          reasons: ["entry"],
        },
      ];
    });

    const result = await runBacktest({ strategy, bars, startingCash: 100_000 });
    for (const trade of result.trades) {
      assert.equal(trade.quantity, Math.floor(trade.quantity), "fractional share ordered");
    }
  });
});

describe("accounting", () => {
  it("records an equity point for every session it ran", async () => {
    const bars = new Map([["AAA", series(40)]]);
    const { strategy } = spyStrategy(() => []);
    const result = await runBacktest({ strategy, bars, startingCash: 100_000 });

    assert.equal(result.equity.length, result.sessions);
    assert.equal(result.equity.length, bars.get("AAA")!.length);
    // Nothing traded, so equity is flat at the starting cash throughout.
    for (const point of result.equity) assert.equal(point.equity, 100_000);
  });

  it("pairs buys and sells into round trips, oldest lot first", () => {
    const result = {
      strategyKey: "t",
      from: "2020-01-06",
      to: "2020-01-10",
      sessions: 3,
      startingCash: 1000,
      refusals: new Map<string, number>(),
      signals: 0,
      equity: [
        { sessionDate: "2020-01-06", equity: 1000, cash: 1000, positionValue: 0, openPositions: 0 },
        { sessionDate: "2020-01-07", equity: 1000, cash: 0, positionValue: 1000, openPositions: 1 },
        { sessionDate: "2020-01-08", equity: 1100, cash: 1100, positionValue: 0, openPositions: 0 },
      ],
      trades: [
        { symbol: "AAA", side: "buy" as const, sessionDate: "2020-01-06", quantity: 10, price: 10, reasons: [] },
        { symbol: "AAA", side: "buy" as const, sessionDate: "2020-01-07", quantity: 10, price: 20, reasons: [] },
        { symbol: "AAA", side: "sell" as const, sessionDate: "2020-01-08", quantity: 15, price: 25, reasons: [] },
      ],
    };

    const trips = roundTrips(result);
    assert.equal(trips.length, 2);
    // The $10 lot is closed first and in full.
    assert.equal(trips[0]!.quantity, 10);
    assert.equal(trips[0]!.entryPrice, 10);
    assert.equal(trips[0]!.pnl, 150);
    // Then five shares of the $20 lot.
    assert.equal(trips[1]!.quantity, 5);
    assert.equal(trips[1]!.entryPrice, 20);
    assert.equal(trips[1]!.pnl, 25);
  });

  it("buys whole shares for the benchmark and keeps the remainder as cash", () => {
    const bars = [
      { sessionDate: "2020-01-06", close: 300 },
      { sessionDate: "2020-01-07", close: 330 },
    ];
    const { equity, metrics } = buyAndHold(bars, 1000);

    // 3 shares at 300 = 900, leaving 100 uninvested rather than 3.33 shares.
    assert.equal(equity[0]!.equity, 1000);
    assert.equal(equity[1]!.equity, 3 * 330 + 100);
    assert.ok(Math.abs(metrics.totalReturn - 0.09) < 1e-9);
  });

  it("reports zero return and no trades for an empty run", () => {
    const metrics = summarise({
      strategyKey: "t",
      from: "",
      to: "",
      sessions: 0,
      startingCash: 1000,
      trades: [],
      equity: [],
      refusals: new Map(),
      signals: 0,
    });
    assert.equal(metrics.totalReturn, 0);
    assert.equal(metrics.roundTrips, 0);
    assert.equal(metrics.sharpe, 0);
  });
});
