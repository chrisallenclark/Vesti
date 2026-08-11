import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rng } from "./random.ts";

function draw(count: number, source: () => number): number[] {
  return Array.from({ length: count }, source);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

describe("seeded random", () => {
  it("reproduces its stream exactly from the same seed", () => {
    assert.deepEqual(draw(500, rng(42).next), draw(500, rng(42).next));
    assert.deepEqual(draw(500, rng("vesti").next), draw(500, rng("vesti").next));
  });

  it("diverges on a different seed", () => {
    assert.notDeepEqual(draw(50, rng(42).next), draw(50, rng(43).next));
    assert.notDeepEqual(draw(50, rng("a").next), draw(50, rng("b").next));
  });

  it("stays inside [0, 1)", () => {
    const values = draw(20_000, rng(7).next);
    assert.ok(values.every((v) => v >= 0 && v < 1));
    // A generator that clusters would quietly bias every series built on it.
    assert.ok(Math.abs(mean(values) - 0.5) < 0.01, `mean ${mean(values)}`);
  });

  it("produces a standard normal that is actually standard", () => {
    const values = draw(50_000, rng("normal").normal);
    assert.ok(Math.abs(mean(values)) < 0.02, `mean ${mean(values)}`);
    assert.ok(Math.abs(stdev(values) - 1) < 0.02, `stdev ${stdev(values)}`);
    // Box-Muller returns a cached second value; a bug there shows up as an
    // exhausted tail rather than a wrong mean.
    assert.ok(values.some((v) => v > 3) && values.some((v) => v < -3), "tails are missing");
  });

  it("survives a degenerate seed", () => {
    const values = draw(100, rng(0).next);
    assert.ok(new Set(values).size > 90, "a zero seed must not collapse the stream");
  });

  it("forks independently of how much the parent has drawn", () => {
    // The property the universe generator depends on: adding a symbol must not
    // rewrite the series of every other symbol.
    const early = rng("root");
    const forkedFirst = draw(20, early.fork("NVDA").next);

    const late = rng("root");
    draw(1_000, late.next); // exhaust the parent
    const forkedLater = draw(20, late.fork("NVDA").next);

    assert.deepEqual(forkedFirst, forkedLater);
  });

  it("gives differently-labelled forks different streams", () => {
    const root = rng("root");
    assert.notDeepEqual(draw(50, root.fork("AAA").next), draw(50, root.fork("BBB").next));
  });

  it("bounds int and range, and honours chance", () => {
    const source = rng("bounds");
    const ints = draw(5_000, () => source.int(10));
    assert.ok(ints.every((v) => Number.isInteger(v) && v >= 0 && v < 10));
    assert.equal(new Set(ints).size, 10, "every bucket should be reachable");

    const ranged = draw(5_000, () => source.range(-3, 7));
    assert.ok(ranged.every((v) => v >= -3 && v < 7));

    const hits = draw(20_000, () => (source.chance(0.25) ? 1 : 0));
    assert.ok(Math.abs(mean(hits) - 0.25) < 0.02, `rate ${mean(hits)}`);
  });
});
