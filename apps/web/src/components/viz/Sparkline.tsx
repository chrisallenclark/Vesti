import { sparkline, toPointsAttr } from "./geometry.ts";

/**
 * Compact price history. Direction is carried by colour AND by the caller's
 * accompanying glyph — never by colour alone.
 */
export function Sparkline({
  values,
  width = 64,
  height = 26,
  positive,
  label,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  positive: boolean;
  label?: string;
}) {
  const points = sparkline(values, width, height);
  if (points.length === 0) return null;

  const last = points[points.length - 1]!;
  const stroke = positive ? "var(--positive)" : "var(--negative)";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={toPointsAttr(points)}
      />
      {/* Emphasised endpoint — where the series actually ended. */}
      <circle cx={last.x} cy={last.y} r={2.2} fill={stroke} />
    </svg>
  );
}
