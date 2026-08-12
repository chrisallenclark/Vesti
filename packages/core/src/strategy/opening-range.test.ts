import assert from "node:assert/strict";
import { test } from "node:test";
import { OpeningRangeBreakout, openingRange, sessionVwap } from "./opening-range.ts";
import { easternClock, type IntradayBar, type IntradayContext } from "./intraday.ts";

/**
 * These tests exist to pin the REFUSALS.
 *
 * The entry rule is one line and would pass a test that only checked it fires.
 * Everything that makes the strategy safe to run unattended is a condition that
 * stops it firing, and each of those is a line somebody could delete without
 * any of the happy-path assertions noticing.
 */

const SESSION = "2026-08-12"; // a Wednesday, EDT (UTC-4), so 09:30 ET = 13:30Z

/** A bar at `minute` minutes past 09:30 ET. */
function bar(minute: number, overrides: Partial<IntradayBar> = {}): IntradayBar {
  const total = 13 * 60 + 30 + minute; // UTC minutes, EDT
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return {
    ts: `${SESSION}T${hh}:${mm}:00Z`,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 1000,
    vwap: 100,
    ...overrides,
  };
}

/**
 * Thirty flat bars forming a 99.5–100.5 opening range, then `after`.
 *
 * The range bars all trade at the same volume, which makes the average the
 * breakout is measured against exactly 1000 and every volume assertion below a
 * plain multiple of it.
 */
function session(after: IntradayBar[]): IntradayBar[] {
  const bars: IntradayBar[] = [];
  for (let i = 0; i < 30; i += 1) bars.push(bar(i));
  return [...bars, ...after];
}

function context(bars: IntradayBar[], overrides: Partial<IntradayContext> = {}): IntradayContext {
  return {
    sessionDate: SESSION,
    minuteOfDay: 11 * 60, // 11:00 ET — inside the entry window
    bars: new Map([["AAPL", bars]]),
    positions: [],
    tradedToday: new Set(),
    ...overrides,
  };
}

/** A clean breakout: above the range high, above VWAP, on 2x volume. */
const BREAKOUT = bar(30, { open: 100.4, high: 100.9, low: 100.4, close: 100.8, vwap: 100.7, volume: 2000 });

test("takes a breakout above the range on volume and above VWAP", () => {
  const { signals } = new OpeningRangeBreakout().evaluate(context(session([BREAKOUT])));
  assert.equal(signals.length, 1);
  const signal = signals[0]!;
  assert.equal(signal.kind, "entry");
  assert.equal(signal.symbol, "AAPL");
  if (signal.kind !== "entry") throw new Error("unreachable");

  // Stop is a quarter of the 1.00 range back inside it: 100.50 − 0.25 = 100.25.
  assert.equal(signal.stopPrice, 100.25);
  // Target is 2R above the entry: 100.80 + 2 × (100.80 − 100.25) = 101.90.
  assert.equal(signal.targetPrice, 101.9);
  assert.equal(signal.tier, "experimental", "an unvalidated rule set must not size up");
  assert.ok(signal.reasons.length >= 3, "every entry carries the rule that fired");
});

test("refuses a breakout that has not closed above the range high", () => {
  const wick = bar(30, { high: 101, close: 100.4, low: 100.2, volume: 3000 });
  const { signals, passes } = new OpeningRangeBreakout().evaluate(context(session([wick])));
  assert.equal(signals.length, 0);
  assert.match(passes.find((p) => p.symbol === "AAPL")?.reason ?? "", /has not closed above/);
});

test("refuses a breakout below session VWAP", () => {
  // A narrow, valid opening range — but the shares inside it changed hands at
  // 105.50, so the day's average participant is above where the level broke.
  const heavy: IntradayBar[] = [];
  for (let i = 0; i < 30; i += 1) {
    heavy.push(bar(i, { open: 105, high: 105.1, low: 104.9, close: 105, vwap: 105.5 }));
  }
  const out = bar(30, { open: 105.1, high: 105.3, low: 105.05, close: 105.2, vwap: 105.2, volume: 5000 });
  const { signals, passes } = new OpeningRangeBreakout().evaluate(context([...heavy, out]));
  assert.equal(signals.length, 0);
  assert.match(passes.find((p) => p.symbol === "AAPL")?.reason ?? "", /below VWAP/);
});

test("refuses a breakout on thin volume", () => {
  const thin = { ...BREAKOUT, volume: 1200 }; // 1.2x, under the 1.5x floor
  const { signals, passes } = new OpeningRangeBreakout().evaluate(context(session([thin])));
  assert.equal(signals.length, 0);
  assert.match(passes.find((p) => p.symbol === "AAPL")?.reason ?? "", /average volume/);
});

test("refuses to chase a move already extended past the level", () => {
  const extended = { ...BREAKOUT, close: 101.6, high: 101.7, vwap: 101.5 };
  const { signals, passes } = new OpeningRangeBreakout().evaluate(context(session([extended])));
  assert.equal(signals.length, 0);
  assert.match(passes.find((p) => p.symbol === "AAPL")?.reason ?? "", /too extended/);
});

test("will not trade before the opening range is complete", () => {
  const partial: IntradayBar[] = [];
  for (let i = 0; i < 20; i += 1) partial.push(bar(i));
  const { signals } = new OpeningRangeBreakout().evaluate(
    context([...partial, BREAKOUT], { minuteOfDay: 9 * 60 + 50 }),
  );
  assert.equal(signals.length, 0, "09:50 is inside the range window");
});

test("will not open a new position after the entry window closes", () => {
  const { signals } = new OpeningRangeBreakout().evaluate(
    context(session([BREAKOUT]), { minuteOfDay: 15 * 60 + 31 }),
  );
  assert.equal(signals.length, 0);
});

test("will not re-enter a symbol it has already traded today", () => {
  const { signals, passes } = new OpeningRangeBreakout().evaluate(
    context(session([BREAKOUT]), { tradedToday: new Set(["AAPL"]) }),
  );
  assert.equal(signals.length, 0);
  assert.match(passes.find((p) => p.symbol === "AAPL")?.reason ?? "", /already traded today/);
});

test("exits when the bar low breaches the stop, even if the close recovered", () => {
  const dip = bar(40, { open: 100.8, high: 100.9, low: 100.1, close: 100.8, vwap: 100.5 });
  const { signals } = new OpeningRangeBreakout().evaluate(
    context(session([BREAKOUT, dip]), {
      positions: [
        {
          symbol: "AAPL",
          quantity: 10,
          averageCost: 100.8,
          stopPrice: 100.25,
          targetPrice: 101.9,
          openedAt: `${SESSION}T14:00:00Z`,
        },
      ],
    }),
  );
  const exit = signals.find((s) => s.kind === "exit");
  assert.ok(exit, "a stop breached inside the bar is a stop that fired");
  if (exit?.kind !== "exit") throw new Error("unreachable");
  assert.equal(exit.exitReason, "stop");
  assert.equal(exit.quantity, 10);
});

test("exits at the target", () => {
  const pop = bar(40, { open: 101, high: 102, low: 101, close: 101.8, vwap: 101.5 });
  const { signals } = new OpeningRangeBreakout().evaluate(
    context(session([BREAKOUT, pop]), {
      positions: [
        {
          symbol: "AAPL",
          quantity: 10,
          averageCost: 100.8,
          stopPrice: 100.25,
          targetPrice: 101.9,
          openedAt: `${SESSION}T14:00:00Z`,
        },
      ],
    }),
  );
  const exit = signals.find((s) => s.kind === "exit");
  if (exit?.kind !== "exit") throw new Error("expected an exit");
  assert.equal(exit.exitReason, "target");
});

test("flattens everything at the session-end cutoff, whatever the price is doing", () => {
  const { signals } = new OpeningRangeBreakout().evaluate(
    context(session([BREAKOUT]), {
      minuteOfDay: 15 * 60 + 45,
      positions: [
        {
          symbol: "AAPL",
          quantity: 10,
          averageCost: 100.8,
          stopPrice: 100.25,
          targetPrice: 101.9,
          openedAt: `${SESSION}T14:00:00Z`,
        },
      ],
    }),
  );
  assert.equal(signals.length, 1);
  const exit = signals[0]!;
  if (exit.kind !== "exit") throw new Error("expected an exit");
  assert.equal(exit.exitReason, "session_end");
});

test("respects the concurrent position cap", () => {
  const strategy = new OpeningRangeBreakout({ maxConcurrentPositions: 1 });
  const { signals } = strategy.evaluate(
    context(session([BREAKOUT]), {
      positions: [
        {
          symbol: "MSFT",
          quantity: 5,
          averageCost: 400,
          stopPrice: 390,
          targetPrice: 420,
          openedAt: `${SESSION}T14:00:00Z`,
        },
      ],
      bars: new Map([
        ["AAPL", session([BREAKOUT])],
        // MSFT is held; its bars exist so the exit rules can read them.
        ["MSFT", session([bar(30, { close: 400, high: 400.5, low: 399.5, vwap: 400 })])],
      ]),
    }),
  );
  assert.equal(signals.filter((s) => s.kind === "entry").length, 0);
});

test("takes at most one entry per cycle, strongest volume first", () => {
  const strong = { ...BREAKOUT, volume: 5000 };
  const weak = { ...BREAKOUT, volume: 2000 };
  const { signals, passes } = new OpeningRangeBreakout().evaluate(
    context([], {
      bars: new Map([
        ["AAPL", session([weak])],
        ["NVDA", session([strong])],
      ]),
    }),
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.symbol, "NVDA");
  assert.match(passes.find((p) => p.symbol === "AAPL")?.reason ?? "", /stronger breakout/);
});

test("an opening range needs a bar after the window to prove the window closed", () => {
  const partial: IntradayBar[] = [];
  for (let i = 0; i < 30; i += 1) partial.push(bar(i));
  assert.equal(openingRange(partial, SESSION, 30), null);
  assert.deepEqual(openingRange([...partial, bar(30)], SESSION, 30), { high: 100.5, low: 99.5 });
});

test("opening range ignores pre-market prints", () => {
  const premarket: IntradayBar = { ...bar(0), ts: `${SESSION}T12:00:00Z`, high: 200, low: 50 };
  const bars = [premarket, ...session([bar(30)])];
  assert.deepEqual(openingRange(bars, SESSION, 30), { high: 100.5, low: 99.5 });
});

test("session VWAP is volume weighted, and null with no volume", () => {
  const bars = [
    bar(0, { vwap: 100, volume: 100 }),
    bar(1, { vwap: 110, volume: 300 }),
  ];
  assert.equal(sessionVwap(bars), (100 * 100 + 110 * 300) / 400);
  assert.equal(sessionVwap([bar(0, { volume: 0 })]), null);
});

test("the eastern clock tracks daylight saving rather than a fixed offset", () => {
  // 13:30Z is 09:30 ET in summer...
  assert.deepEqual(easternClock(new Date("2026-08-12T13:30:00Z")), {
    sessionDate: "2026-08-12",
    minuteOfDay: 570,
  });
  // ...and 08:30 ET in winter, when the open is 14:30Z.
  assert.deepEqual(easternClock(new Date("2026-01-14T14:30:00Z")), {
    sessionDate: "2026-01-14",
    minuteOfDay: 570,
  });
});

test("midnight ET is minute zero, not minute 1440", () => {
  assert.equal(easternClock(new Date("2026-08-12T04:10:00Z")).minuteOfDay, 10);
});
