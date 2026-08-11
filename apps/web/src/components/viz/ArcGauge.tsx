import { arcDash, arcOffset, budgetUsage, polar, riskTone } from "./geometry.ts";

const TONE_COLOR = {
  calm: "var(--accent)",
  warning: "var(--warning)",
  critical: "var(--critical)",
} as const;

/**
 * Risk against a budget, as an arc that fills toward a hard-limit tick.
 *
 * The arc sweeps 240° with the gap at the bottom. A breach fills the arc
 * completely and turns the stroke critical — it never wraps past the limit
 * tick, because a visual that keeps growing past its own limit stops meaning
 * anything.
 */
export function ArcGauge({
  used,
  limit,
  unit = "%",
  caption = "AT RISK",
  size = 128,
}: {
  used: number;
  limit: number;
  unit?: string;
  caption?: string;
  size?: number;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const r = cx - 18;
  const stroke = 10;

  const { dash } = arcDash(r, 240);
  const { ratio, breached } = budgetUsage(used, limit);
  const tone = riskTone(ratio);

  // The arc runs 150° → 30° clockwise, leaving the opening at the bottom.
  const end = polar(cx, cy, r, 30);
  const tickInner = polar(cx, cy, r + stroke / 2 + 1, 30);
  const tickOuter = polar(cx, cy, r + stroke / 2 + 8, 30);

  // The viewBox must clear the arc endpoints (which sit below centre) plus the
  // stroke and the limit tick, or the tick silently clips.
  const height = Math.ceil(end.y + stroke / 2 + 12);

  return (
    <svg
      width={size}
      height={height}
      viewBox={`0 0 ${size} ${height}`}
      role="img"
      aria-label={`${used}${unit} of a ${limit}${unit} limit, ${(ratio * 100).toFixed(0)} percent of budget used${breached ? " — limit breached" : ""}`}
    >
      <g fill="none" strokeWidth={stroke} strokeLinecap="round">
        <circle cx={cx} cy={cy} r={r} stroke="var(--track)" strokeDasharray={`${dash} ${2 * Math.PI * r}`} transform={`rotate(150 ${cx} ${cy})`} />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          stroke={TONE_COLOR[tone]}
          strokeDasharray={`${dash} ${2 * Math.PI * r}`}
          strokeDashoffset={arcOffset(dash, ratio)}
          transform={`rotate(150 ${cx} ${cy})`}
        />
      </g>

      {/* Hard limit, marked radially outward from the arc's end. */}
      <line
        x1={tickInner.x}
        y1={tickInner.y}
        x2={tickOuter.x}
        y2={tickOuter.y}
        stroke="var(--critical)"
        strokeWidth={2.5}
        strokeLinecap="round"
      />

      <text x={cx} y={cy - 2} textAnchor="middle" fill="var(--text-1)" fontSize={26} fontWeight={600} letterSpacing="-0.02em">
        {used}
        {unit}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fill="var(--text-3)" fontSize={10} letterSpacing="0.09em">
        {caption}
      </text>
    </svg>
  );
}
