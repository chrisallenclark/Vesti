import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTradingDay } from "../market/calendar.ts";
import {
  generateSeries,
  generateUniverse,
  type SyntheticBar,
  type SyntheticSeries,
} from "./generator.ts";

function assertCoherent(bars: readonly SyntheticBar[]): void {
  for (const bar of bars) {
    assert.ok(Number.isFinite(bar.open) && bar.open > 0, `${bar.sessionDate}: bad open`);
    assert.ok(bar.low > 0, `${bar.sessionDate}: non-positive low`);
    assert.ok(bar.high >= bar.low, `${bar.sessionDate}: high below low`);
    assert.ok(
      bar.high >= bar.open && bar.high >= bar.close,
      `${bar.sessionDate}: high ${bar.high} below open ${bar.open} / close ${bar.close}`,
    );
    assert.ok(
      bar.low <= bar.open && bar.low <= bar.close,
      `${bar.sessionDate}: low ${bar.low} above open ${bar.open} / close ${bar.close}`,
    );
    assert.ok(
      bar.vwap >= bar.low && bar.vwap <= bar.high,
      `${bar.sessionDate}: vwap ${bar.vwap} outside range`,
    );
    assert.ok(bar.volume > 0 && Number.isInteger(bar.volume), `${bar.sessionDate}: bad volume`);
    assert.ok(isTradingDay(bar.sessionDate), `${bar.sessionDate} is not a session`);
  }
}

function logReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    out.push(Math.log((values[i] as number) / (values[i - 1] as number)));
  }
  return out;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  for (let i = 0; i < a.length; i += 1) cov += ((a[i] as number) - ma) * ((b[i] as number) - mb);
  return cov / a.length / (stdev(a) * stdev(b));
}

const BASE = {
  symbol: "SYNX",
  seed: 1234,
  startDate: "2020-01-02",
  startPrice: 100,
} as const;

describe("synthetic bars are internally coherent", () => {
  it("produces bars that could actually have printed", () => {
    const series = generateSeries({
      ...BASE,
      regimes: [
        { kind: "trend_up", sessions: 120 },
        { kind: "choppy", sessions: 80 },
        { kind: "crash", sessions: 40 },
        { kind: "recovery", sessions: 60 },
        { kind: "high_vol", sessions: 50 },
        { kind: "trend_down", sessions: 60 },
      ],
    });
    assert.equal(series.bars.length, 410);
    assertCoherent(series.bars);
  });

  it("survives a long crash without producing a negative price", () => {
    const series = generateSeries({
      ...BASE,
      regimes: [{ kind: "crash", sessions: 800 }],
    });
    assertCoherent(series.bars);
    assert.ok(series.bars.every((b) => b.low >= 1));
  });

  it("emits exactly the requested number of sessions, on session dates only", () => {
    const series = generateSeries({
      ...BASE,
      startDate: "2024-11-27", // a Wednesday before Thanksgiving
      regimes: [{ kind: "choppy", sessions: 5 }],
    });
    assert.deepEqual(
      series.bars.map((b) => b.sessionDate),
      ["2024-11-27", "2024-11-29", "2024-12-02", "2024-12-03", "2024-12-04"],
    );
  });
});

describe("determinism", () => {
  const spec = { ...BASE, regimes: [{ kind: "choppy" as const, sessions: 200 }] };

  it("reproduces the same series from the same seed", () => {
    assert.deepEqual(generateSeries(spec).bars, generateSeries(spec).bars);
  });

  it("produces a different series from a different seed", () => {
    const other = generateSeries({ ...spec, seed: 1235 });
    assert.notDeepEqual(generateSeries(spec).bars, other.bars);
  });

  it("gives each symbol an independent stream", () => {
    // Adding a ticker to a universe must not rewrite the history of the others.
    const a1 = generateSeries({ ...spec, symbol: "AAA" });
    const b1 = generateSeries({ ...spec, symbol: "BBB" });
    const a2 = generateSeries({ ...spec, symbol: "AAA" });
    assert.deepEqual(a1.bars, a2.bars);
    assert.notDeepEqual(
      a1.bars.map((b) => b.close),
      b1.bars.map((b) => b.close),
    );
  });
});

describe("regimes behave as labelled", () => {
  const sessions = 600;
  const series = (kind: "trend_up" | "trend_down" | "choppy" | "high_vol"): SyntheticSeries =>
    generateSeries({ ...BASE, regimes: [{ kind, sessions }] });

  it("trends up when it says it is trending up", () => {
    const returns = logReturns(series("trend_up").truth.map((t) => t.continuousClose));
    assert.ok(mean(returns) > 0, `expected positive drift, got ${mean(returns)}`);
  });

  it("trends down when it says it is trending down", () => {
    const returns = logReturns(series("trend_down").truth.map((t) => t.continuousClose));
    assert.ok(mean(returns) < 0, `expected negative drift, got ${mean(returns)}`);
  });

  it("is meaningfully more volatile in a high-vol regime", () => {
    const quiet = stdev(logReturns(series("choppy").truth.map((t) => t.continuousClose)));
    const loud = stdev(logReturns(series("high_vol").truth.map((t) => t.continuousClose)));
    assert.ok(loud > quiet * 2, `high_vol ${loud} should dwarf choppy ${quiet}`);
  });

  it("mean-reverts in a choppy regime rather than wandering", () => {
    const closes = series("choppy").truth.map((t) => t.continuousClose);
    const drift = Math.abs(Math.log((closes.at(-1) as number) / (closes[0] as number)));
    // A driftless random walk over 600 sessions at 1% daily vol would typically
    // end ~25% away; the anchor should keep it far tighter than that.
    assert.ok(drift < 0.25, `choppy regime drifted ${(drift * 100).toFixed(1)}%`);
  });
});

describe("corporate actions", () => {
  const spec = {
    ...BASE,
    regimes: [{ kind: "trend_up" as const, sessions: 300 }],
    splits: [
      { atSession: 100, ratio: 4, announceLeadSessions: 15 },
      { atSession: 220, ratio: 2, announceLeadSessions: 10 },
    ],
    dividends: [
      { atSession: 60, amount: 0.5, announceLeadSessions: 20 },
      { atSession: 180, amount: 0.25, announceLeadSessions: 20 },
    ],
  };

  it("prints raw prices, so a split visibly cuts the quoted price", () => {
    const series = generateSeries(spec);
    const before = series.bars[99] as SyntheticBar;
    const on = series.bars[100] as SyntheticBar;
    const ratio = before.close / on.close;
    // Roughly 4, plus one session of ordinary price movement.
    assert.ok(ratio > 3.7 && ratio < 4.3, `expected a ~4x drop in the print, got ${ratio}`);
    // And the share count quadruples with it.
    assert.ok(on.volume > before.volume * 2.5, "split should multiply printed volume");
  });

  it("announces every action strictly before it goes ex", () => {
    const series = generateSeries(spec);
    assert.equal(series.corporateActions.length, 4);
    for (const action of series.corporateActions) {
      assert.ok(
        action.announcedAt.slice(0, 10) < action.exDate,
        `${action.kind} announced ${action.announcedAt} for ex-date ${action.exDate}`,
      );
    }
  });

  it("reconstructs the true continuous series from raw prices and split history", () => {
    // This is the same backward adjustment the PIT layer performs: divide by the
    // product of every split with an ex-date AFTER the bar. If that arithmetic is
    // wrong anywhere, the reconstruction diverges from the known truth here
    // rather than silently in a backtest three months from now.
    const series = generateSeries(spec);
    const splits = series.corporateActions.filter((a) => a.kind === "split");
    const totalSplitFactor = splits.reduce((acc, a) => acc * (a.splitRatio as number), 1);

    for (let i = 0; i < series.bars.length; i += 1) {
      const bar = series.bars[i] as SyntheticBar;
      const truth = series.truth[i] as (typeof series.truth)[number];
      const futureFactor = splits
        .filter((a) => a.exDate > bar.sessionDate)
        .reduce((acc, a) => acc * (a.splitRatio as number), 1);
      const adjusted = bar.close / futureFactor;
      const reconstructed = adjusted * totalSplitFactor;
      // Raw prints are rounded to the cent, which is worth up to half a cent
      // per share times the divisor in force.
      const tolerance = 0.005 * truth.splitDivisor + 1e-9;
      assert.ok(
        Math.abs(reconstructed - truth.continuousClose) <= tolerance,
        `${bar.sessionDate}: reconstructed ${reconstructed} vs truth ${truth.continuousClose}`,
      );
    }
  });

  it("takes the dividend out of the share price on the ex-date", () => {
    const withDividend = generateSeries(spec);
    const without = generateSeries({ ...spec, dividends: [] });
    // Identical random streams up to the ex-date; the only difference is the cash
    // that left the share, so the continuous price must sit strictly lower after.
    const a = (withDividend.truth[60] as { continuousClose: number }).continuousClose;
    const b = (without.truth[60] as { continuousClose: number }).continuousClose;
    assert.ok(a < b, `ex-dividend close ${a} should be below the no-dividend close ${b}`);
  });
});

describe("universe", () => {
  const universe = generateUniverse({
    seed: "vesti-test",
    startDate: "2021-01-04",
    regimes: [
      { kind: "trend_up", sessions: 250 },
      { kind: "crash", sessions: 30 },
      { kind: "recovery", sessions: 120 },
    ],
    members: [
      { symbol: "HIGHB", startPrice: 90, beta: 1.4, idiosyncratic: 0.5 },
      { symbol: "LOWB", startPrice: 45, beta: 0.9, idiosyncratic: 0.5 },
      { symbol: "INDEP", startPrice: 30, beta: 0, idiosyncratic: 1 },
    ],
  });

  const closesOf = (symbol: string): number[] => {
    const found = universe.find((s) => s.symbol === symbol);
    assert.ok(found, `${symbol} missing`);
    return found.truth.map((t) => t.continuousClose);
  };

  it("keeps every member coherent", () => {
    for (const series of universe) assertCoherent(series.bars);
  });

  it("correlates members that share a market factor", () => {
    const r = correlation(logReturns(closesOf("HIGHB")), logReturns(closesOf("LOWB")));
    assert.ok(r > 0.6, `expected co-movement, got r=${r.toFixed(3)}`);
  });

  it("leaves a zero-beta member uncorrelated", () => {
    const r = correlation(logReturns(closesOf("HIGHB")), logReturns(closesOf("INDEP")));
    assert.ok(Math.abs(r) < 0.25, `expected independence, got r=${r.toFixed(3)}`);
  });

  it("gives the higher-beta member the larger drawdown in the crash", () => {
    const drawdown = (closes: readonly number[]): number => {
      const window = closes.slice(250, 280);
      const peak = Math.max(...window);
      return (peak - Math.min(...window)) / peak;
    };
    assert.ok(
      drawdown(closesOf("HIGHB")) > drawdown(closesOf("LOWB")),
      "beta 1.4 should fall further than beta 0.9",
    );
  });
});
