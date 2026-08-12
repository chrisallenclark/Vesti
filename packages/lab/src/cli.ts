/**
 * Run a backtest and print what it found.
 *
 *   npm run backtest -w @vesti/lab
 *   npm run backtest -w @vesti/lab -- --from 2016-01-04 --to 2026-08-11
 *   npm run backtest -w @vesti/lab -- --json report.json
 *
 * Reads with the backtest role, which holds no table grants at all and can
 * reach data only through the PIT functions. That is not ceremony: a backtester
 * that could read `bars_daily` directly could read tomorrow's bar, and no
 * amount of care in this file would prove that it had not.
 */

import pg from "pg";
import { writeFile } from "node:fs/promises";
import { TrendPullback } from "@vesti/core/strategy/trend-pullback.ts";
import { STARTER_UNIVERSE } from "./universe.ts";
import { loadBars } from "./data.ts";
import { runBacktest } from "./engine.ts";
import { buyAndHold, byPeriod, roundTrips, summarise, type Metrics } from "./metrics.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const say = (message = ""): void => void process.stdout.write(`${message}\n`);
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const money = (value: number): string =>
  `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function table(label: string, m: Metrics): void {
  say(`  ${label}`);
  say(`    return        ${pct(m.totalReturn).padStart(9)}   CAGR ${pct(m.cagr)}`);
  say(`    max drawdown  ${pct(m.maxDrawdown).padStart(9)}   on ${m.maxDrawdownDate}`);
  say(`    volatility    ${pct(m.annualisedVolatility).padStart(9)}   Sharpe ${m.sharpe.toFixed(2)}`);
  say(`    exposure      ${pct(m.exposure).padStart(9)}   ${m.roundTrips} round trip(s)`);
  say(`    capital used  ${pct(m.averageDeployed).padStart(9)}   average share of equity in positions`);
  if (m.roundTrips > 0) {
    say(
      `    win rate      ${pct(m.winRate).padStart(9)}   profit factor ${
        Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞"
      }`,
    );
    say(`    expectancy    ${money(m.expectancy).padStart(9)} per round trip`);
  }
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL_BACKTEST ?? process.env.DATABASE_URL_RESEARCH ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_BACKTEST is unset. See .env.example.");
  }

  const from = arg("from") ?? "2016-01-04";
  const to = arg("to") ?? new Date().toISOString().slice(0, 10);
  const startingCash = Number(arg("cash") ?? 100_000);
  const benchmarkSymbol = arg("benchmark") ?? "SPY";

  const strategy = new TrendPullback();
  const universe = (arg("symbols") ?? STARTER_UNIVERSE.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const pool = new pg.Pool({ connectionString, max: 4 });
  const client = await pool.connect();

  try {
    say();
    say(`Backtest — ${strategy.key} v${strategy.version}`);
    say("─".repeat(58));
    say(`  window     ${from} → ${to}`);
    say(`  universe   ${universe.length} symbol(s)`);
    say(`  capital    ${money(startingCash)}`);
    say();

    const loaded = await loadBars(client, { symbols: universe, from, to });
    if (loaded.missing.length > 0) {
      say(`  not in the database, skipped: ${loaded.missing.join(", ")}`);
    }
    const totalBars = [...loaded.bars.values()].reduce((sum, s) => sum + s.length, 0);
    say(`  loaded     ${totalBars.toLocaleString()} point-in-time bars`);

    // The benchmark is excluded from what the strategy may trade: comparing a
    // strategy against an index it was also buying measures very little.
    const tradable = new Map(loaded.bars);
    const benchmarkBars = tradable.get(benchmarkSymbol) ?? [];
    tradable.delete(benchmarkSymbol);

    const result = await runBacktest({
      strategy,
      bars: tradable,
      sectors: loaded.sectors,
      startingCash,
      from,
      to,
    });

    const metrics = summarise(result);
    say(`  sessions   ${result.sessions.toLocaleString()}`);
    say(`  signals    ${result.signals.toLocaleString()}, ${result.trades.length} fill(s)`);
    say();

    say("Strategy");
    table(`${strategy.key}`, metrics);
    say();

    if (benchmarkBars.length > 0) {
      const bench = buyAndHold(
        benchmarkBars.filter((b) => b.sessionDate >= result.from && b.sessionDate <= result.to),
        startingCash,
      );
      say("Benchmark");
      table(`buy and hold ${benchmarkSymbol}`, bench.metrics);
      say();
      const edge = metrics.totalReturn - bench.metrics.totalReturn;
      say(
        `  Difference: ${edge >= 0 ? "+" : ""}${pct(edge)} over the window — ` +
          `${edge >= 0 ? "ahead of" : "behind"} simply holding ${benchmarkSymbol}.`,
      );
      say();
    }

    // Calendar years, because a decade-long average hides which years carried
    // it and whether the bad ones were survivable.
    const years: Array<{ label: string; from: string; to: string }> = [];
    for (let y = Number(result.from.slice(0, 4)); y <= Number(result.to.slice(0, 4)); y++) {
      years.push({ label: String(y), from: `${y}-01-01`, to: `${y}-12-31` });
    }
    const perYear = byPeriod(result, years).filter((p) => p.metrics.years > 0);
    if (perYear.length > 1) {
      say("By year");
      for (const { label, metrics: m } of perYear) {
        say(
          `  ${label}  return ${pct(m.totalReturn).padStart(8)}   ` +
            `drawdown ${pct(m.maxDrawdown).padStart(7)}   ${m.roundTrips} trip(s)`,
        );
      }
      say();
    }

    // The stretches a long-only trend system should find hardest. Stated
    // explicitly because "it worked over ten years" and "it survived 2022" are
    // different claims and only the second one is load-bearing.
    const stress = byPeriod(result, [
      { label: "2018 Q4 selloff", from: "2018-10-01", to: "2018-12-31" },
      { label: "COVID crash", from: "2020-02-19", to: "2020-04-30" },
      { label: "2022 bear market", from: "2022-01-01", to: "2022-12-31" },
    ]).filter((p) => p.metrics.years > 0);
    if (stress.length > 0) {
      say("Stress windows");
      for (const { label, metrics: m } of stress) {
        say(
          `  ${label.padEnd(18)} return ${pct(m.totalReturn).padStart(8)}   ` +
            `drawdown ${pct(m.maxDrawdown).padStart(7)}   ${m.roundTrips} trip(s)`,
        );
      }
      say();
    }

    if (result.refusals.size > 0) {
      say("Refused by the risk engine");
      for (const [code, count] of [...result.refusals].sort((a, b) => b[1] - a[1])) {
        say(`  ${String(count).padStart(5)}  ${code}`);
      }
      say();
    }

    say("What this is not");
    say("  A single pass over one universe with one parameter set. No");
    say("  walk-forward, no out-of-sample split, no trial-count penalty — so it");
    say("  cannot tell you whether these rules would have been chosen in");
    say("  advance, only how they would have done once chosen. Those are the");
    say("  next things to build, and until they exist this is not grounds for");
    say("  promotion beyond paper.");
    say();

    const jsonPath = arg("json");
    if (jsonPath) {
      const bench = benchmarkBars.length
        ? buyAndHold(
            benchmarkBars.filter((b) => b.sessionDate >= result.from && b.sessionDate <= result.to),
            startingCash,
          )
        : null;
      await writeFile(
        jsonPath,
        JSON.stringify(
          {
            strategy: { key: strategy.key, version: strategy.version, describe: strategy.describe },
            window: { from: result.from, to: result.to, sessions: result.sessions },
            startingCash,
            metrics,
            benchmark: bench ? { symbol: benchmarkSymbol, metrics: bench.metrics } : null,
            equity: result.equity,
            benchmarkEquity: bench?.equity ?? [],
            perYear,
            stress,
            roundTrips: roundTrips(result),
            refusals: [...result.refusals].map(([code, count]) => ({ code, count })),
          },
          null,
          2,
        ),
      );
      say(`Wrote ${jsonPath}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
