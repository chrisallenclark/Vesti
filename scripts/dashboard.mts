/**
 * The page that answers "is it working?".
 *
 * Reads what the sessions actually recorded — equity snapshots, open lots,
 * fills — and renders it as one self-contained page. No build step and no
 * network at view time, so what is published is what the database held at
 * publish time and nothing can drift in between.
 *
 * The editorial rule is the one the rest of this project follows: never a
 * number without the thing that qualifies it. Profit is shown against the
 * benchmark over the same window, because a system that made 4% while the
 * market made 9% lost, and a page that reports only the 4% is lying by
 * omission. Session count is shown next to every P&L figure, because two weeks
 * of paper trading cannot distinguish an edge from a coin landing well.
 */

import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";

const pct = (v: number): string => `${v >= 0 ? "" : "−"}${(Math.abs(v) * 100).toFixed(2)}%`;
const money = (v: number): string =>
  `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const escape = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface CurvePoint {
  as_of: string;
  equity: string;
  cash: string;
  positions_value: string;
  realized_pnl: string;
  unrealized_pnl: string;
}

interface Position {
  symbol: string;
  mandate: string;
  remaining: string;
  cost_basis: string;
  stop_price: string | null;
  opened_at: string;
  last_close: string | null;
}

interface Fill {
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  filled_at: string;
  mandate: string;
}

function sparkline(points: Array<{ date: string; value: number }>, benchmark: Array<{ date: string; value: number }>): string {
  if (points.length < 2) {
    return `<p class="muted empty">The curve appears once two sessions have been recorded.
      One point is a balance, not a trend.</p>`;
  }
  const width = 900;
  const height = 260;
  const pad = { top: 14, right: 14, bottom: 26, left: 72 };

  const all = [...points.map((p) => p.value), ...benchmark.map((p) => p.value)];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || Math.abs(max) * 0.01 || 1;

  const x = (i: number, n: number): number =>
    pad.left + (i / Math.max(1, n - 1)) * (width - pad.left - pad.right);
  const y = (v: number): number =>
    pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);
  const path = (series: Array<{ value: number }>): string =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i, series.length).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");

  const ticks = [min, (min + max) / 2, max]
    .map(
      (v) =>
        `<line x1="${pad.left}" y1="${y(v).toFixed(1)}" x2="${width - pad.right}" y2="${y(v).toFixed(1)}" class="grid"/>` +
        `<text x="${pad.left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tick">${money(v)}</text>`,
    )
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Equity over time">
    ${ticks}
    ${benchmark.length > 1 ? `<path d="${path(benchmark)}" class="bench"/>` : ""}
    <path d="${path(points)}" class="strat"/>
    <text x="${pad.left}" y="${height - 6}" class="tick">${escape(points[0]!.date)}</text>
    <text x="${width - pad.right}" y="${height - 6}" text-anchor="end" class="tick">${escape(points.at(-1)!.date)}</text>
  </svg>`;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is unset.");
  const output = process.argv[2] ?? "site/index.html";
  const hasBacktest = process.argv.includes("--with-backtest");

  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
  await client.connect();

  try {
    const { rows: accounts } = await client.query<{ id: string; external_id: string | null }>(
      `SELECT id, external_id FROM accounts WHERE broker = 'alpaca' ORDER BY created_at LIMIT 1`,
    );
    const account = accounts[0];

    let curve: CurvePoint[] = [];
    let positions: Position[] = [];
    let fills: Fill[] = [];
    let killed = false;

    if (account) {
      ({ rows: curve } = await client.query<CurvePoint>(
        `SELECT as_of::text,
                sum(equity)::text          AS equity,
                sum(cash)::text            AS cash,
                sum(positions_value)::text AS positions_value,
                sum(realized_pnl)::text    AS realized_pnl,
                sum(unrealized_pnl)::text  AS unrealized_pnl
           FROM equity_snapshots
          WHERE account_id = $1
          GROUP BY as_of
          ORDER BY as_of`,
        [account.id],
      ));

      ({ rows: positions } = await client.query<Position>(
        `SELECT s.symbol, m.name AS mandate, l.remaining::text, l.cost_basis::text,
                l.stop_price::text, l.opened_at::date::text AS opened_at,
                (SELECT b.close::text FROM bars_daily b
                  WHERE b.security_id = s.id ORDER BY b.session_date DESC LIMIT 1) AS last_close
           FROM lots l
           JOIN securities s ON s.id = l.security_id
           JOIN mandates m   ON m.id = l.mandate_id
          WHERE l.account_id = $1 AND l.remaining > 0
          ORDER BY s.symbol`,
        [account.id],
      ));

      ({ rows: fills } = await client.query<Fill>(
        `SELECT s.symbol, o.side, f.quantity::text, f.price::text,
                f.filled_at::text, m.name AS mandate
           FROM fills f
           JOIN orders o     ON o.id = f.order_id
           JOIN securities s ON s.id = o.security_id
           JOIN mandates m   ON m.id = o.mandate_id
          WHERE o.account_id = $1
          ORDER BY f.filled_at DESC
          LIMIT 40`,
        [account.id],
      ));

      const { rows: kill } = await client.query<{ is_tripped: boolean }>(
        `SELECT is_tripped FROM kill_switch_state WHERE account_id = $1`,
        [account.id],
      );
      killed = kill[0]?.is_tripped ?? false;
    }

    // The benchmark on the same axis and the same starting capital, so "up
    // $400" can be read against what doing nothing would have earned.
    let benchmark: Array<{ date: string; value: number }> = [];
    if (curve.length > 0) {
      const { rows: spy } = await client.query<{ session_date: string; close: string }>(
        `SELECT b.session_date::text, b.close::text
           FROM bars_daily b JOIN securities s ON s.id = b.security_id
          WHERE s.symbol = 'SPY' AND b.session_date >= $1::date
          ORDER BY b.session_date`,
        [curve[0]!.as_of],
      );
      const start = Number(curve[0]!.equity);
      const first = Number(spy[0]?.close ?? 0);
      if (first > 0) {
        const byDate = new Map(spy.map((r) => [r.session_date, Number(r.close)]));
        let last = first;
        benchmark = curve.map((p) => {
          last = byDate.get(p.as_of) ?? last;
          return { date: p.as_of, value: (start * last) / first };
        });
      }
    }

    const startEquity = curve.length ? Number(curve[0]!.equity) : 0;
    const nowEquity = curve.length ? Number(curve.at(-1)!.equity) : 0;
    const pnl = nowEquity - startEquity;
    const ret = startEquity > 0 ? pnl / startEquity : 0;
    const benchReturn =
      benchmark.length > 1 && benchmark[0]!.value > 0
        ? benchmark.at(-1)!.value / benchmark[0]!.value - 1
        : null;

    const marketValue = (p: Position): number =>
      Number(p.remaining) * Number(p.last_close ?? p.cost_basis);
    const openValue = positions.reduce((sum, p) => sum + marketValue(p), 0);

    const backtestLink = hasBacktest
      ? `<a href="backtest.html">Backtest report →</a>`
      : `<span class="muted">Backtest report published separately</span>`;

    const html = `<title>Vesti Paper Trading</title>
<style>
  :root { --bg:#fff; --fg:#16181d; --muted:#5b6270; --line:#e3e6ec; --card:#f7f8fa;
          --strat:#2f6fe4; --bench:#9aa2b1; --pos:#17794d; --neg:#b3261e; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#0f1115; --fg:#e8eaee; --muted:#9aa2b1; --line:#262a33; --card:#171a21;
    --strat:#6ea8ff; --bench:#6b7280; --pos:#4ade80; --neg:#f87171; } }
  :root[data-theme="dark"] { --bg:#0f1115; --fg:#e8eaee; --muted:#9aa2b1; --line:#262a33;
    --card:#171a21; --strat:#6ea8ff; --bench:#6b7280; --pos:#4ade80; --neg:#f87171; }
  body { background:var(--bg); color:var(--fg); margin:0;
         font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width:960px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:26px; margin:0 0 4px; letter-spacing:-0.01em; }
  h2 { font-size:17px; margin:36px 0 10px; }
  .sub { color:var(--muted); font-size:14px; margin:0 0 24px; }
  .muted { color:var(--muted); }
  .headline { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin:24px 0 8px; }
  @media (max-width:760px){ .headline{ grid-template-columns:repeat(2,1fr);} }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  .kpi .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .kpi .value { font-size:24px; font-variant-numeric:tabular-nums; margin-top:4px; }
  .kpi .note { color:var(--muted); font-size:12px; margin-top:2px; }
  .pos{color:var(--pos)} .neg{color:var(--neg)}
  svg{width:100%;height:auto;display:block;margin:6px 0}
  .grid{stroke:var(--line);stroke-width:1}
  .tick{fill:var(--muted);font-size:11px}
  .strat{fill:none;stroke:var(--strat);stroke-width:2}
  .bench{fill:none;stroke:var(--bench);stroke-width:1.5;stroke-dasharray:4 3}
  .legend{display:flex;gap:18px;font-size:13px;color:var(--muted);margin:4px 0 8px}
  .swatch{display:inline-block;width:14px;height:3px;vertical-align:middle;margin-right:6px}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th,td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--line);font-size:14px}
  th:first-child,td:first-child{text-align:left}
  th{color:var(--muted);font-weight:500;font-size:13px}
  .wrap{overflow-x:auto}
  .banner{border:1px solid var(--line);border-left:3px solid var(--neg);background:var(--card);
          border-radius:8px;padding:14px 16px;margin:16px 0}
  .caveat{background:var(--card);border:1px solid var(--line);border-radius:8px;
          padding:16px 18px;margin-top:36px;font-size:14px}
  .caveat h2{margin-top:0;font-size:15px}
  .empty{padding:24px 0}
  nav{margin-top:28px;font-size:14px}
</style>
<main>
  <h1>Paper trading</h1>
  <p class="sub">
    ${account ? `Alpaca paper ${escape(account.external_id ?? "")}` : "No account yet"} ·
    ${curve.length} session${curve.length === 1 ? "" : "s"} recorded ·
    updated ${escape(new Date().toISOString().replace("T", " ").slice(0, 16))} UTC
  </p>

  ${killed ? `<div class="banner"><strong>Kill switch tripped.</strong> The loop will not open positions until it is reset.</div>` : ""}

  <div class="headline">
    <div class="kpi"><div class="label">Equity</div>
      <div class="value">${money(nowEquity)}</div>
      <div class="note">${positions.length} open position${positions.length === 1 ? "" : "s"}</div></div>
    <div class="kpi"><div class="label">Profit</div>
      <div class="value ${pnl >= 0 ? "pos" : "neg"}">${money(pnl)}</div>
      <div class="note">${pct(ret)} since the first session</div></div>
    <div class="kpi"><div class="label">Buy &amp; hold SPY</div>
      <div class="value">${benchReturn === null ? "—" : pct(benchReturn)}</div>
      <div class="note">same window, same capital</div></div>
    <div class="kpi"><div class="label">In positions</div>
      <div class="value">${money(openValue)}</div>
      <div class="note">${nowEquity > 0 ? pct(openValue / nowEquity) : "—"} of equity</div></div>
  </div>

  ${
    benchReturn !== null && curve.length > 1
      ? `<p class="muted">Against the benchmark: <strong class="${ret - benchReturn >= 0 ? "pos" : "neg"}">${pct(
          ret - benchReturn,
        )}</strong> ${ret - benchReturn >= 0 ? "ahead of" : "behind"} simply holding SPY over the same ${curve.length} sessions.</p>`
      : ""
  }

  <div class="legend">
    <span><i class="swatch" style="background:var(--strat)"></i>paper account</span>
    <span><i class="swatch" style="background:var(--bench)"></i>buy and hold SPY</span>
  </div>
  ${sparkline(
    curve.map((p) => ({ date: p.as_of, value: Number(p.equity) })),
    benchmark,
  )}

  <h2>Open positions</h2>
  <div class="wrap">${
    positions.length
      ? `<table><thead><tr><th>Symbol</th><th>Mandate</th><th>Shares</th><th>Cost</th><th>Last</th><th>Value</th><th>Open P&amp;L</th><th>Stop</th></tr></thead><tbody>${positions
          .map((p) => {
            const last = Number(p.last_close ?? p.cost_basis);
            const open = (last - Number(p.cost_basis)) * Number(p.remaining);
            return `<tr><td>${escape(p.symbol)}</td><td>${escape(p.mandate)}</td><td>${Number(
              p.remaining,
            ).toLocaleString()}</td><td>${money(Number(p.cost_basis))}</td><td>${money(last)}</td><td>${money(
              marketValue(p),
            )}</td><td class="${open >= 0 ? "pos" : "neg"}">${money(open)}</td><td>${
              p.stop_price ? money(Number(p.stop_price)) : "—"
            }</td></tr>`;
          })
          .join("")}</tbody></table>`
      : `<p class="muted empty">Nothing open. The loop opens positions only when the rules fire and the risk engine approves the size.</p>`
  }</div>

  <h2>Recent fills</h2>
  <div class="wrap">${
    fills.length
      ? `<table><thead><tr><th>Filled</th><th>Symbol</th><th>Side</th><th>Shares</th><th>Price</th><th>Mandate</th></tr></thead><tbody>${fills
          .map(
            (f) =>
              `<tr><td>${escape(f.filled_at.slice(0, 16).replace("T", " "))}</td><td>${escape(
                f.symbol,
              )}</td><td>${escape(f.side)}</td><td>${Number(f.quantity).toLocaleString()}</td><td>${money(
                Number(f.price),
              )}</td><td>${escape(f.mandate)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="muted empty">No fills yet.</p>`
  }</div>

  <div class="caveat">
    <h2>How to read this</h2>
    <p><strong>${curve.length} session${curve.length === 1 ? "" : "s"} is not a result.</strong>
    A profit here is not evidence the strategy works, and neither is a loss evidence
    it does not. Distinguishing an edge from luck takes hundreds of trades, and this
    strategy has been through no walk-forward validation at all — it was promoted to
    exercise the machinery, not because anything suggested it earns money.</p>
    <p>Its ten-year backtest <strong>underperformed buy and hold by 184 points</strong>.
    The reasonable expectation is that this curve tracks below SPY. What this page is
    genuinely proving is that orders route, fills post to specific lots, the ledger
    reconciles against the broker's own count, and the curve is recorded every
    session — the parts that must be right before a strategy worth believing in
    goes behind them.</p>
  </div>

  <nav>${backtestLink}</nav>
</main>`;

    await writeFile(output, html);
    process.stdout.write(`Wrote ${output} (${curve.length} sessions, ${positions.length} positions)\n`);
  } finally {
    await client.end().catch(() => {});
  }
}

await main();
