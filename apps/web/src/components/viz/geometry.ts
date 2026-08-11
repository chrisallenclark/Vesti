/**
 * Pure geometry for the visual primitives.
 *
 * Every data visual in this app is a claim about a number. An arc that renders
 * 6% as 60% of its track is not a cosmetic bug — it is a silent lie about how
 * much risk is open. So the maths lives here, separate from the components, and
 * is unit-tested against known values.
 *
 * No React, no DOM, no side effects.
 */

/** Clamps to [0,1]. Real inputs go out of range (a breached limit is >100%). */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function circumference(radius: number): number {
  return 2 * Math.PI * radius;
}

/**
 * `stroke-dashoffset` for a full-circle ring showing `fraction` of its track.
 * Offset counts backwards from a complete circle, so fraction 0 → full offset
 * (nothing drawn) and fraction 1 → zero offset (fully drawn).
 */
export function ringOffset(radius: number, fraction: number): number {
  const c = circumference(radius);
  return c * (1 - clamp01(fraction));
}

/**
 * Dash pattern for a partial arc — a gauge that sweeps `sweepDeg` rather than a
 * full circle. `dash` is the visible arc; `gap` is the remainder of the circle,
 * which must exceed the dash so the pattern never repeats into the gap.
 */
export function arcDash(radius: number, sweepDeg: number): { dash: number; gap: number } {
  const c = circumference(radius);
  const dash = c * (clamp01(sweepDeg / 360));
  return { dash, gap: c };
}

/** `stroke-dashoffset` to fill `fraction` of an arc of length `arcLength`. */
export function arcOffset(arcLength: number, fraction: number): number {
  return arcLength * (1 - clamp01(fraction));
}

export interface Point {
  x: number;
  y: number;
}

/**
 * SVG coordinates for an angle, measured clockwise from 3 o'clock — matching
 * how SVG renders a circle path, so rotate() transforms compose predictably.
 */
export function polar(cx: number, cy: number, radius: number, degrees: number): Point {
  const rad = (degrees * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/**
 * Normalises a series into polyline points. A flat series is centred rather
 * than pinned to an edge — a stock that did not move should not look like it
 * sat at its low all week.
 */
export function sparkline(values: readonly number[], width: number, height: number, pad = 2): Point[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [{ x: width / 2, y: height / 2 }];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const usable = height - pad * 2;
  const step = width / (values.length - 1);

  return values.map((value, index) => ({
    x: index * step,
    // SVG y grows downward, so a higher value sits nearer the top.
    y: span === 0 ? height / 2 : pad + usable * (1 - (value - min) / span),
  }));
}

export function toPointsAttr(points: readonly Point[]): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RLadderInput {
  stop: number;
  entry: number;
  target: number;
  current: number;
  width: number;
}

export interface RLadderGeometry {
  /** x positions along the track */
  stopX: number;
  entryX: number;
  targetX: number;
  currentX: number;
  /** width of the shaded risk band (stop → entry) */
  riskWidth: number;
  /** width of the shaded reward band (entry → target) */
  rewardWidth: number;
  /** risk per share in price terms */
  riskPerShare: number;
  /** planned reward-to-risk multiple */
  plannedR: number;
  /** where the trade currently stands, in R */
  currentR: number;
  /** true once price has passed the target or breached the stop */
  isBeyondTarget: boolean;
  isBeyondStop: boolean;
}

/**
 * Maps a trade plan onto a single horizontal track.
 *
 * Handles shorts as well as longs: for a short, target < entry < stop, and the
 * track runs the other way. Getting this wrong would paint a losing short as a
 * winner, so direction is derived rather than assumed.
 */
export function rLadder({ stop, entry, target, current, width }: RLadderInput): RLadderGeometry {
  const isLong = target > entry;
  const riskPerShare = Math.abs(entry - stop);

  const lo = Math.min(stop, target);
  const hi = Math.max(stop, target);
  const span = hi - lo;

  const project = (price: number): number => {
    if (span === 0) return 0;
    const t = (price - lo) / span;
    // A short's stop sits above its target; flip so "left" is always the loss end.
    return (isLong ? t : 1 - t) * width;
  };

  const stopX = project(stop);
  const entryX = project(entry);
  const targetX = project(target);
  const currentX = project(current);

  const gain = isLong ? current - entry : entry - current;
  const currentR = riskPerShare === 0 ? 0 : gain / riskPerShare;
  const plannedReward = Math.abs(target - entry);
  const plannedR = riskPerShare === 0 ? 0 : plannedReward / riskPerShare;

  return {
    stopX,
    entryX,
    targetX,
    currentX: Math.min(width, Math.max(0, currentX)),
    riskWidth: Math.abs(entryX - stopX),
    rewardWidth: Math.abs(targetX - entryX),
    riskPerShare,
    plannedR,
    currentR,
    isBeyondTarget: isLong ? current >= target : current <= target,
    isBeyondStop: isLong ? current <= stop : current >= stop,
  };
}

/**
 * Fraction of a risk budget consumed. Deliberately NOT clamped in the returned
 * `ratio` — a breach must be reportable as a breach, not silently pinned to
 * 100%. Callers clamp only when converting to a drawn length.
 */
export function budgetUsage(used: number, limit: number): { ratio: number; breached: boolean } {
  if (limit <= 0) return { ratio: 0, breached: used > 0 };
  const ratio = used / limit;
  return { ratio, breached: ratio > 1 };
}

export type RiskTone = "calm" | "warning" | "critical";

/** Risk state as a colour tone. Thresholds live here so every gauge agrees. */
export function riskTone(ratio: number): RiskTone {
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.7) return "warning";
  return "calm";
}
