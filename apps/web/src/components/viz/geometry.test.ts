/**
 * Geometry tests.
 *
 * These guard against a specific class of bug: a visual that renders confidently
 * and is wrong. A gauge showing 6% risk as a nearly-full arc, or a short trade
 * painted as a winner while it loses, would both look entirely plausible.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  arcDash,
  arcOffset,
  budgetUsage,
  circumference,
  clamp01,
  polar,
  rLadder,
  riskTone,
  ringOffset,
  sparkline,
} from "./geometry.ts";

const close = (actual: number, expected: number, tolerance = 0.05, message?: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`,
  );

describe("clamp01", () => {
  it("passes through valid fractions and clamps the rest", () => {
    assert.equal(clamp01(0.42), 0.42);
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(3), 1);
  });

  it("treats NaN as zero rather than propagating it into a path", () => {
    // A NaN in a dash offset silently blanks the whole visual.
    assert.equal(clamp01(Number.NaN), 0);
  });
});

describe("ringOffset", () => {
  it("draws nothing at 0 and everything at 1", () => {
    const r = 52;
    assert.equal(ringOffset(r, 0), circumference(r));
    assert.equal(ringOffset(r, 1), 0);
  });

  it("matches the values hard-coded in the design prototype", () => {
    // Long-Term 40% on r=52, Catalyst 34% on r=40, Active 17% on r=28.
    close(ringOffset(52, 0.4), 196.0, 0.1);
    close(ringOffset(40, 0.34), 165.9, 0.1);
    close(ringOffset(28, 0.17), 146.0, 0.1);
  });
});

describe("arc gauge", () => {
  it("computes a 240-degree arc on r=46", () => {
    const { dash } = arcDash(46, 240);
    close(dash, 192.68, 0.05);
  });

  it("fills proportionally — 35% of budget is 35% of the arc", () => {
    const { dash } = arcDash(46, 240);
    const offset = arcOffset(dash, 0.35);
    close(dash - offset, dash * 0.35, 0.01);
    close(offset, 125.24, 0.1);
  });

  it("never overdraws when the limit is breached", () => {
    const { dash } = arcDash(46, 240);
    // 150% of budget must still render as a full arc, not wrap around.
    assert.equal(arcOffset(dash, 1.5), 0);
  });
});

describe("polar", () => {
  it("places 0 degrees at 3 o'clock and 90 at the bottom (SVG y grows down)", () => {
    const right = polar(64, 64, 46, 0);
    close(right.x, 110);
    close(right.y, 64);

    const bottom = polar(64, 64, 46, 90);
    close(bottom.x, 64);
    close(bottom.y, 110);
  });

  it("locates the gauge arc endpoints used by the risk gauge", () => {
    // The 240-degree arc runs 150 -> 30 degrees, leaving the gap at the bottom.
    const start = polar(64, 64, 46, 150);
    const end = polar(64, 64, 46, 30);
    close(start.x, 24.17, 0.1);
    close(start.y, 87.0, 0.1);
    close(end.x, 103.83, 0.1);
    close(end.y, 87.0, 0.1);
  });
});

describe("sparkline", () => {
  it("spans the full width and puts the highest value nearest the top", () => {
    const points = sparkline([1, 5, 3], 64, 26);
    assert.equal(points.length, 3);
    assert.equal(points[0]!.x, 0);
    assert.equal(points[2]!.x, 64);
    assert.ok(points[1]!.y < points[0]!.y, "the peak must sit above the trough");
  });

  it("centres a flat series instead of pinning it to the floor", () => {
    // A stock that did not move must not look like it sat at its low all week.
    const points = sparkline([10, 10, 10], 64, 26);
    for (const p of points) assert.equal(p.y, 13);
  });

  it("survives degenerate input", () => {
    assert.deepEqual(sparkline([], 64, 26), []);
    assert.deepEqual(sparkline([7], 64, 26), [{ x: 32, y: 13 }]);
  });
});

describe("rLadder — long trades", () => {
  // The NVDA position from the prototype.
  const geo = rLadder({ stop: 851, entry: 878.4, target: 960, current: 906.2, width: 360 });

  it("computes R multiples that match the trade plan", () => {
    close(geo.riskPerShare, 27.4, 0.001);
    close(geo.plannedR, 2.978, 0.001);
    close(geo.currentR, 1.015, 0.001);
  });

  it("positions the markers along the track", () => {
    assert.equal(geo.stopX, 0);
    close(geo.entryX, 90.5, 0.1);
    close(geo.currentX, 182.3, 0.1);
    assert.equal(geo.targetX, 360);
  });

  it("splits the track into risk and reward bands that tile it exactly", () => {
    close(geo.riskWidth + geo.rewardWidth, 360, 0.01);
  });

  it("does not claim the target or stop has been reached", () => {
    assert.equal(geo.isBeyondTarget, false);
    assert.equal(geo.isBeyondStop, false);
  });
});

describe("rLadder — short trades", () => {
  // Short: stop ABOVE entry, target BELOW. Direction is derived, not assumed —
  // treating this as a long would paint a losing short as a winner.
  const winning = rLadder({ stop: 110, entry: 100, target: 80, current: 92, width: 360 });

  it("reads a falling price as profit", () => {
    close(winning.riskPerShare, 10, 0.001);
    close(winning.plannedR, 2, 0.001);
    close(winning.currentR, 0.8, 0.001);
  });

  it("orients the track so the loss end is always on the left", () => {
    assert.equal(winning.stopX, 0, "stop anchors the left edge");
    assert.equal(winning.targetX, 360, "target anchors the right edge");
    assert.ok(winning.currentX > winning.entryX, "profit moves right");
  });

  it("detects a breached stop on a short", () => {
    const losing = rLadder({ stop: 110, entry: 100, target: 80, current: 112, width: 360 });
    assert.equal(losing.isBeyondStop, true);
    assert.ok(losing.currentR < -1, "past the stop is worse than -1R");
  });
});

describe("rLadder — degenerate input", () => {
  it("does not divide by zero when stop equals entry", () => {
    const geo = rLadder({ stop: 100, entry: 100, target: 120, current: 110, width: 360 });
    assert.equal(geo.riskPerShare, 0);
    assert.equal(geo.currentR, 0);
    assert.equal(geo.plannedR, 0);
    assert.ok(Number.isFinite(geo.entryX));
  });

  it("keeps the current marker on the track when price runs past the target", () => {
    const geo = rLadder({ stop: 851, entry: 878.4, target: 960, current: 1200, width: 360 });
    assert.equal(geo.currentX, 360, "marker pins to the edge rather than overflowing");
    assert.ok(geo.currentR > geo.plannedR, "but the R multiple still reports the truth");
    assert.equal(geo.isBeyondTarget, true);
  });
});

describe("budgetUsage and riskTone", () => {
  it("reports a breach rather than silently pinning to the limit", () => {
    const over = budgetUsage(7.2, 6);
    close(over.ratio, 1.2, 0.001);
    assert.equal(over.breached, true);
  });

  it("treats any usage against a zero limit as a breach", () => {
    assert.equal(budgetUsage(0.1, 0).breached, true);
    assert.equal(budgetUsage(0, 0).breached, false);
  });

  it("escalates tone at 70% and 90% of budget", () => {
    assert.equal(riskTone(0.35), "calm");
    assert.equal(riskTone(0.69), "calm");
    assert.equal(riskTone(0.7), "warning");
    assert.equal(riskTone(0.89), "warning");
    assert.equal(riskTone(0.9), "critical");
    assert.equal(riskTone(1.4), "critical");
  });
});
