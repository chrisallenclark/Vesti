import { rLadder } from "./geometry.ts";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/**
 * A trade plan on one track: what you lose on the left, what you're playing for
 * on the right, and where price actually is.
 *
 * Works for shorts as well as longs — direction is derived from the plan, so
 * the loss end is always on the left regardless of which way the trade points.
 */
export function RLadder({
  stop,
  entry,
  target,
  current,
  height = 62,
}: {
  stop: number;
  entry: number;
  target: number;
  current: number;
  height?: number;
}) {
  const width = 360;
  const geo = rLadder({ stop, entry, target, current, width });
  const mid = height / 2;

  return (
    <>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          `Stop ${money(stop)}, entry ${money(entry)}, current ${money(current)}, target ${money(target)}. ` +
          `Risking ${money(geo.riskPerShare)} per share for a planned ${geo.plannedR.toFixed(2)} R. ` +
          `Currently ${geo.currentR >= 0 ? "up" : "down"} ${Math.abs(geo.currentR).toFixed(2)} R.`
        }
      >
        <rect x={Math.min(geo.stopX, geo.entryX)} y={mid - 7} width={geo.riskWidth} height={14} rx={3} fill="var(--negative)" opacity={0.28} />
        <rect x={Math.min(geo.entryX, geo.targetX)} y={mid - 7} width={geo.rewardWidth} height={14} rx={3} fill="var(--positive)" opacity={0.22} />

        {/* Entry — the pivot the whole plan is measured from. */}
        <line x1={geo.entryX} y1={mid - 13} x2={geo.entryX} y2={mid + 13} stroke="var(--text-2)" strokeWidth={1.5} />
        {/* Endpoints, inset by 1px so the round caps are not clipped. */}
        <line x1={1} y1={mid - 11} x2={1} y2={mid + 11} stroke="var(--negative)" strokeWidth={2.5} strokeLinecap="round" />
        <line x1={width - 1} y1={mid - 11} x2={width - 1} y2={mid + 11} stroke="var(--positive)" strokeWidth={2.5} strokeLinecap="round" />

        <g transform={`translate(${geo.currentX} 0)`}>
          <line x1={0} y1={mid - 19} x2={0} y2={mid + 19} stroke="var(--accent)" strokeWidth={2} />
          <circle cx={0} cy={mid} r={5} fill="var(--accent)" />
        </g>
      </svg>

      <div className="ladderLegend">
        <div>
          Stop
          <b>{money(stop)}</b>
        </div>
        <div>
          Now
          <b style={{ color: "var(--accent)" }}>{money(current)}</b>
        </div>
        <div>
          Target
          <b>{money(target)}</b>
        </div>
      </div>
    </>
  );
}
