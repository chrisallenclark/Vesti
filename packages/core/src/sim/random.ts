/**
 * Seeded pseudo-random numbers.
 *
 * Everything downstream of this file — synthetic price series, fill jitter,
 * Monte Carlo resampling — must be reproducible from a seed alone. A backtest
 * whose result changes between runs cannot be debugged, and a "surprising"
 * result you can't reproduce is indistinguishable from a bug.
 *
 * `fork` matters more than it looks: giving each symbol its own stream means
 * adding a ticker to a universe does not perturb the series of every other
 * ticker. Without it, re-running yesterday's backtest with one extra symbol
 * silently produces different history for all of them.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal, mean 0 variance 1. */
  normal(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** An independent stream derived from this one and a label. */
  fork(label: string): Rng;
}

/** FNV-1a, so a string seed is as good as a numeric one. */
function hashSeed(seed: number | string): number {
  if (typeof seed === "number") return seed >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rng(seed: number | string): Rng {
  const origin = hashSeed(seed);
  let state = origin;
  // A zero state makes mulberry32 degenerate; nudge it off.
  if (state === 0) state = 0x9e3779b9;

  let spare: number | null = null;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const normal = (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    // Box-Muller. `next()` can return exactly 0, and ln(0) is -Infinity.
    let u = 0;
    while (u === 0) u = next();
    const v = next();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };

  const self: Rng = {
    next,
    normal,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    range: (min, max) => min + next() * (max - min),
    chance: (probability) => next() < probability,
    // Derived from the ORIGINAL seed, not the mutated state, so a child stream
    // is the same whether you fork it before or after drawing from the parent.
    fork: (label) => rng(`${origin}:${label}`),
  };
  return self;
}
