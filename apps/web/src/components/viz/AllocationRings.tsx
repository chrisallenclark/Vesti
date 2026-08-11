import { ringOffset } from "./geometry.ts";

export interface RingSlice {
  label: string;
  fraction: number;
  color: string;
}

/**
 * Concentric rings, one per mandate, each read against its own track.
 *
 * Note the tradeoff this inherits from the Apple Activity model: equal
 * fractions on different radii produce different arc lengths, so rings are not
 * directly comparable to each other. Each is read against its own track. The
 * legend carries the comparable numbers.
 */
export function AllocationRings({
  slices,
  size = 118,
  strokeWidth = 9,
}: {
  slices: readonly RingSlice[];
  size?: number;
  strokeWidth?: number;
}) {
  const center = size / 2;
  const outer = center - strokeWidth / 2 - 2;
  const step = 12;

  const description = slices
    .map((s) => `${s.label} ${(s.fraction * 100).toFixed(0)} percent`)
    .join(", ");

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Allocation: ${description}`}
    >
      <g fill="none" strokeLinecap="round" strokeWidth={strokeWidth}>
        {slices.map((slice, index) => {
          const r = outer - index * step;
          const c = 2 * Math.PI * r;
          return (
            <circle key={`${slice.label}-track`} cx={center} cy={center} r={r} stroke="var(--track)" strokeDasharray={c} />
          );
        })}
        {slices.map((slice, index) => {
          const r = outer - index * step;
          const c = 2 * Math.PI * r;
          return (
            <circle
              key={slice.label}
              cx={center}
              cy={center}
              r={r}
              stroke={slice.color}
              strokeDasharray={c}
              strokeDashoffset={ringOffset(r, slice.fraction)}
              /* -90deg puts the start of every ring at 12 o'clock. */
              transform={`rotate(-90 ${center} ${center})`}
            />
          );
        })}
      </g>
    </svg>
  );
}
