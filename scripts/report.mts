/**
 * Renders the backtest JSON into a page you can look at.
 *
 * Self-contained HTML with inline SVG — no build step, no dependencies, no
 * network at view time — because the thing publishing it is a CI job and the
 * thing reading it is a browser, and anything in between is a way for the
 * report to stop matching the run that produced it.
 *
 * The design rule here is the same one `metrics.ts` follows: nothing is shown
 * without the number that qualifies it. The equity curve is drawn against the
 * benchmark on the same axis, because a rising line on its own is the most
 * misleading chart in finance.
 */

import { readFile, writeFile } from "node:fs/promises";

interface Metrics {
  from: string;
  to: string;
  years: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  maxDrawdownDate: string;
  annualisedVolatility: number;
  sharpe: number;
  exposure: number;
  averageDeployed: number;
  trades: number;
  roundTrips: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  startingEquity: number;
  endingEquity: number;
}

interface Point {
  sessionDate: string;
  equity: number;
}

interface Report {
  strategy: { key: string; version: number; describe: string };
  window: { from: string; to: string; sessions: number };
  startingCash: number;
  metrics: Metrics;
  benchmark: { symbol: string; metrics: Metrics } | null;
  equity: Point[];
  benchmarkEquity: Point[];
  perYear: Array<{ label: string; metrics: Metrics }>;
  stress: Array<{ label: string; metrics: Metrics }>;
  refusals: Array<{ code: string; count: number }>;
  generatedAt?: string;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const money = (v: number): string =>
  `$${Math.round(v).toLocaleString("en-US")}`;
const escape = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Two series on one axis, downsampled to keep the SVG small. */
function chart(strategy: Point[], benchmark: Point[]): string {
  const width = 900;
  const height = 320;
  const pad = { top: 16, right: 16, bottom: 28, left: 64 };

  const every = Math.max(1, Math.floor(strategy.length / 600));
  const a = strategy.filter((_, i) => i % every === 0);
  const b = benchmark.filter((_, i) => i % every === 0);
  if (a.length === 0) return "<p class=\"muted\">No equity curve.</p>";

  const values = [...a.map((p) => p.equity), ...b.map((p) => p.equity)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const x = (i: number, n: number): number =>
    pad.left + (i / Math.max(1, n - 1)) * (width - pad.left - pad.right);
  const y = (v: number): number =>
    pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);

  const path = (points: Point[]): string =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i, points.length).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");

  const ticks = [min, min + span / 2, max].map(
    (v) =>
      `<text x="${pad.left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tick">${money(v)}</text>` +
      `<line x1="${pad.left}" y1="${y(v).toFixed(1)}" x2="${width - pad.right}" y2="${y(v).toFixed(1)}" class="grid"/>`,
  ).join("");

  const first = a[0]!.sessionDate;
  const last = a.at(-1)!.sessionDate;

  return `
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Equity curve against benchmark">
  ${ticks}
  ${b.length ? `<path d="${path(b)}" class="bench"/>` : ""}
  <path d="${path(a)}" class="strat"/>
  <text x="${pad.left}" y="${height - 8}" class="tick">${first}</text>
  <text x="${width - pad.right}" y="${height - 8}" text-anchor="end" class="tick">${last}</text>
</svg>`;
}

function statRow(label: string, value: string, note = ""): string {
  return `<div class="stat"><dt>${escape(label)}</dt><dd>${escape(value)}${
    note ? `<span class="note">${escape(note)}</span>` : ""
  }</dd></div>`;
}

function metricsBlock(m: Metrics): string {
  return `
<dl class="stats">
  ${statRow("Total return", pct(m.totalReturn), `${pct(m.cagr)} a year`)}
  ${statRow("Max drawdown", pct(m.maxDrawdown), m.maxDrawdownDate)}
  ${statRow("Volatility", pct(m.annualisedVolatility), `Sharpe ${m.sharpe.toFixed(2)}`)}
  ${statRow("Capital used", pct(m.averageDeployed), `held something ${pct(m.exposure)} of sessions`)}
  ${statRow("Round trips", m.roundTrips.toLocaleString(), m.roundTrips ? `${pct(m.winRate)} won` : "")}
  ${statRow(
    "Expectancy",
    m.roundTrips ? money(m.expectancy) : "—",
    m.roundTrips ? `profit factor ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞"}` : "",
  )}
</dl>`;
}

function periodTable(rows: Array<{ label: string; metrics: Metrics }>): string {
  if (rows.length === 0) return "";
  return `
<table>
  <thead><tr><th>Period</th><th>Return</th><th>Drawdown</th><th>Round trips</th></tr></thead>
  <tbody>
    ${rows
      .map(
        (r) =>
          `<tr><td>${escape(r.label)}</td><td class="${r.metrics.totalReturn < 0 ? "neg" : "pos"}">${pct(
            r.metrics.totalReturn,
          )}</td><td>${pct(r.metrics.maxDrawdown)}</td><td>${r.metrics.roundTrips}</td></tr>`,
      )
      .join("\n    ")}
  </tbody>
</table>`;
}

function render(report: Report): string {
  const m = report.metrics;
  const b = report.benchmark;
  const edge = b ? m.totalReturn - b.metrics.totalReturn : null;

  return `<title>Vesti Backtest</title>
<style>
  :root {
    --bg: #ffffff; --fg: #16181d; --muted: #5b6270; --line: #e3e6ec;
    --strat: #2f6fe4; --bench: #9aa2b1; --pos: #17794d; --neg: #b3261e; --card: #f7f8fa;
  }
  :root:not([data-theme="light"]) { }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0f1115; --fg: #e8eaee; --muted: #9aa2b1; --line: #262a33;
      --strat: #6ea8ff; --bench: #6b7280; --pos: #4ade80; --neg: #f87171; --card: #171a21;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0f1115; --fg: #e8eaee; --muted: #9aa2b1; --line: #262a33;
    --strat: #6ea8ff; --bench: #6b7280; --pos: #4ade80; --neg: #f87171; --card: #171a21;
  }
  body { background: var(--bg); color: var(--fg); margin: 0;
         font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 18px; margin: 40px 0 12px; }
  .muted { color: var(--muted); }
  .sub { color: var(--muted); margin: 0 0 28px; font-size: 14px; }
  .verdict { background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--neg);
             border-radius: 8px; padding: 16px 18px; margin: 24px 0; }
  .verdict.ahead { border-left-color: var(--pos); }
  .verdict strong { font-size: 17px; }
  svg { width: 100%; height: auto; display: block; margin: 8px 0 4px; }
  .grid { stroke: var(--line); stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 11px; }
  .strat { fill: none; stroke: var(--strat); stroke-width: 2; }
  .bench { fill: none; stroke: var(--bench); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .legend { display: flex; gap: 18px; font-size: 13px; color: var(--muted); margin-bottom: 20px; }
  .swatch { display: inline-block; width: 14px; height: 3px; vertical-align: middle; margin-right: 6px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
  @media (max-width: 700px) { .cols { grid-template-columns: 1fr; } }
  .stats { margin: 0; }
  .stat { display: flex; justify-content: space-between; gap: 12px;
          padding: 7px 0; border-bottom: 1px solid var(--line); }
  .stat dt { color: var(--muted); font-size: 14px; }
  .stat dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .note { display: block; color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 7px 8px; border-bottom: 1px solid var(--line); font-size: 14px; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--muted); font-weight: 500; font-size: 13px; }
  .pos { color: var(--pos); } .neg { color: var(--neg); }
  .caveat { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
            padding: 16px 18px; margin-top: 32px; font-size: 14px; }
  .caveat h2 { margin-top: 0; font-size: 15px; }
  .caveat li { margin-bottom: 8px; }
  .wrap { overflow-x: auto; }
</style>
<main>
  <h1>${escape(report.strategy.key)} <span class="muted">v${report.strategy.version}</span></h1>
  <p class="sub">
    ${escape(report.window.from)} → ${escape(report.window.to)} ·
    ${report.window.sessions.toLocaleString()} sessions ·
    ${money(report.startingCash)} starting capital${
      report.generatedAt ? ` · generated ${escape(report.generatedAt)}` : ""
    }
  </p>

  ${
    edge !== null && b
      ? `<div class="verdict${edge >= 0 ? " ahead" : ""}">
    <strong>${edge >= 0 ? "Ahead of" : "Behind"} buy and hold by ${pct(Math.abs(edge))}.</strong>
    <div class="muted">The strategy returned ${pct(m.totalReturn)} while holding
    ${escape(b.symbol)} returned ${pct(b.metrics.totalReturn)} over the same window.
    It did so with ${pct(m.maxDrawdown)} maximum drawdown against ${pct(b.metrics.maxDrawdown)},
    and with ${pct(m.averageDeployed)} of capital deployed on average against ${pct(
      b.metrics.averageDeployed,
    )} — most of the difference in volatility is cash, not skill.</div>
  </div>`
      : ""
  }

  <div class="legend">
    <span><i class="swatch" style="background: var(--strat)"></i>${escape(report.strategy.key)}</span>
    ${b ? `<span><i class="swatch" style="background: var(--bench)"></i>buy and hold ${escape(b.symbol)}</span>` : ""}
  </div>
  ${chart(report.equity, report.benchmarkEquity)}

  <div class="cols">
    <section>
      <h2>Strategy</h2>
      ${metricsBlock(m)}
    </section>
    ${b ? `<section><h2>Buy and hold ${escape(b.symbol)}</h2>${metricsBlock(b.metrics)}</section>` : ""}
  </div>

  <h2>By year</h2>
  <div class="wrap">${periodTable(report.perYear)}</div>

  <h2>Stress windows</h2>
  <div class="wrap">${periodTable(report.stress)}</div>

  ${
    report.refusals.length
      ? `<h2>Refused by the risk engine</h2>
  <div class="wrap"><table>
    <thead><tr><th>Reason</th><th>Count</th></tr></thead>
    <tbody>${report.refusals
      .map((r) => `<tr><td>${escape(r.code)}</td><td>${r.count.toLocaleString()}</td></tr>`)
      .join("")}</tbody>
  </table></div>`
      : ""
  }

  <div class="caveat">
    <h2>What this is not</h2>
    <ul>
      <li><strong>Not evidence these rules would have been chosen.</strong> One pass,
      one universe, one parameter set. No walk-forward, no out-of-sample split, no
      penalty for the number of variants tried.</li>
      <li><strong>Survivorship applies.</strong> The universe is companies that exist
      today, so the backtest never holds a name that went to zero. Every return here
      is optimistic by an unknown amount.</li>
      <li><strong>Sharpe is computed against a zero risk-free rate</strong>, which
      flatters a strategy sitting mostly in cash.</li>
      <li><strong>Fills are pessimistic but simulated.</strong> Orders cross a
      session after the signal, pay the spread and pay square-root impact — closer
      to honest than most backtests, still not a real venue.</li>
    </ul>
  </div>
</main>`;
}

async function main(): Promise<void> {
  const input = process.argv[2] ?? "backtest.json";
  const output = process.argv[3] ?? "site/index.html";
  const report = JSON.parse(await readFile(input, "utf8")) as Report;
  await writeFile(output, render(report));
  process.stdout.write(`Wrote ${output}\n`);
}

await main();
