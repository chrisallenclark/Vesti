/**
 * Does the integration actually work? Asked of the real venue, and answered.
 *
 *   npm run preflight -w @vesti/execution
 *
 * Written because "the code exists" and "the code works" are different claims,
 * and only one of them can be checked. Every line of output here is a live
 * round trip to Alpaca or to Postgres; nothing is mocked and nothing is
 * inferred from configuration.
 *
 * STRICTLY READ-ONLY. It submits nothing, cancels nothing and writes nothing —
 * not even a heartbeat. That is what makes it safe to run while the worker is
 * running, which is exactly when somebody wants to ask whether the venue is
 * reachable. It also means it cannot be the thing that proves order submission;
 * that is `paper.ts`, which walks a real order through the whole chain, and the
 * DAY worker, which does it continuously.
 *
 * The market-data section is the part worth reading. It fetches today's bars
 * for the real universe, runs the real strategy over them, and prints what the
 * rules concluded about each symbol. During a session that answers "why has it
 * not traded?" in one command, with the reasons in the words of the rules.
 */

import pg from "pg";
import { OpeningRangeBreakout } from "@vesti/core/strategy/opening-range.ts";
import { easternClock } from "@vesti/core/strategy/intraday.ts";
import { AlpacaBroker, ALPACA_PAPER_URL } from "./alpaca.ts";
import { strategyStanding } from "./day-engine.ts";
import { IntradayMarketData, sessionOpenInstant } from "./market-data.ts";

function say(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function head(title: string): void {
  say(`\n${title}`);
  say("─".repeat(title.length));
}

const ok = (label: string, detail = ""): void => say(`  [32m✓[0m ${label}  ${detail}`);
const bad = (label: string, detail = ""): void => say(`  [31m✗[0m ${label}  ${detail}`);

let failures = 0;

/** Runs one check, records a failure, and never lets one stop the rest. */
async function check(label: string, run: () => Promise<string>): Promise<void> {
  try {
    ok(label, await run());
  } catch (error) {
    failures += 1;
    bad(label, error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY unset.");

  const tradingBaseUrl = process.env.ALPACA_TRADING_BASE_URL ?? ALPACA_PAPER_URL;
  if (!tradingBaseUrl.includes("paper-api")) {
    throw new Error(`Refusing to touch ${tradingBaseUrl}. Preflight is paper-only.`);
  }

  const broker = new AlpacaBroker({ keyId, secretKey, baseUrl: tradingBaseUrl });
  const data = new IntradayMarketData({
    keyId,
    secretKey,
    ...(process.env.ALPACA_DATA_BASE_URL ? { baseUrl: process.env.ALPACA_DATA_BASE_URL } : {}),
    feed: (process.env.ALPACA_REALTIME_FEED as "iex" | "sip" | undefined) ?? "iex",
  });

  head("Paper boundary");
  ok("trading host", tradingBaseUrl);
  ok("TRADING_MODE", process.env.TRADING_MODE ?? "PAPER (defaulted)");
  ok("adapter reports", broker.isLive ? "LIVE — REFUSE" : "paper");
  if (broker.isLive) failures += 1;

  head("Alpaca — the account");
  let accountNumber = "";
  await check("authenticate and read the account", async () => {
    const detail = await broker.getAccountDetail();
    accountNumber = detail.accountNumber;
    if (detail.tradingBlocked) throw new Error("trading_blocked is set on this account");
    return `${detail.accountNumber}  status ${detail.status}  cash $${detail.cash.toFixed(2)}`;
  });
  await check("buying power and equity", async () => {
    const account = await broker.getAccount();
    return `equity $${account.equity.toFixed(2)}  buying power $${account.buyingPower.toFixed(2)}`;
  });
  await check("current positions", async () => {
    const positions = await broker.listPositions();
    return positions.length === 0
      ? "flat"
      : positions.map((p) => `${p.quantity} ${p.symbol}`).join(", ");
  });
  await check("open orders", async () => {
    const orders = await broker.listOpenOrders();
    return orders.length === 0
      ? "none working"
      : orders.map((o) => `${o.side} ${o.quantity} ${o.symbol} (${o.status})`).join(", ");
  });
  await check("marks, for the dashboard's live P&L", async () => {
    const portfolio = await broker.getPortfolio();
    return (
      `${portfolio.positions.length} position(s), ` +
      `day P&L ${portfolio.dayPnl === null ? "—" : `$${portfolio.dayPnl.toFixed(2)}`}`
    );
  });

  let marketOpen = false;
  await check("venue clock", async () => {
    const clock = await data.fetchClock(tradingBaseUrl);
    marketOpen = clock.isOpen;
    return clock.isOpen
      ? `OPEN until ${clock.nextClose}`
      : `CLOSED, next open ${clock.nextOpen}`;
  });

  head("Database");
  const executionUrl = process.env.DATABASE_URL_EXECUTION;
  let pool: pg.Pool | undefined;
  let accountId: string | null = null;
  if (!executionUrl) {
    failures += 1;
    bad("DATABASE_URL_EXECUTION", "unset — see .env.example");
  } else {
    pool = new pg.Pool({ connectionString: executionUrl, max: 2 });
    await check("connect as vesti_execution", async () => {
      const { rows } = await pool!.query<{ v: string }>(`SELECT version() AS v`);
      return rows[0]!.v.split(",")[0]!;
    });
    await check("the account row", async () => {
      const { rows } = await pool!.query<{ id: string; is_live: boolean }>(
        `SELECT id, is_live FROM accounts WHERE broker = 'alpaca' AND external_id = $1`,
        [accountNumber],
      );
      if (!rows[0]) throw new Error(`no row for Alpaca ${accountNumber} — bootstrap it first`);
      if (rows[0].is_live) throw new Error("the row says is_live — refuse to trade it");
      accountId = rows[0].id;
      return `${rows[0].id} (is_live false)`;
    });
    await check("the kill switch", async () => {
      const { rows } = await pool!.query<{ is_tripped: boolean; reason: string | null }>(
        `SELECT is_tripped, reason FROM kill_switch_state WHERE account_id = $1`,
        [accountId],
      );
      return rows[0]?.is_tripped ? `TRIPPED — ${rows[0].reason}` : "clear";
    });
    await check("the worker's heartbeat", async () => {
      const { rows } = await pool!.query<{
        engine: string;
        status: string;
        cycles: string;
        age: string;
      }>(
        `SELECT engine, status, cycles, extract(epoch FROM (now() - last_beat_at)) AS age
           FROM worker_state WHERE account_id = $1`,
        [accountId],
      );
      if (rows.length === 0) return "no worker has ever reported";
      return rows
        .map((r) => `${r.engine} ${r.status}, ${r.cycles} cycles, ${Math.round(Number(r.age))}s ago`)
        .join("; ");
    });
  }

  head("Market data — the real feed, right now");
  const strategy = new OpeningRangeBreakout();
  await check(`feed ${data.feed}`, async () => {
    if (!pool || !accountId) throw new Error("skipped: no database");

    const { rows } = await pool.query<{ symbol: string }>(
      `SELECT DISTINCT s.symbol FROM securities s JOIN bars_daily b ON b.security_id = s.id
        WHERE s.delisted_at IS NULL AND s.is_tradable ORDER BY s.symbol`,
    );
    const universe = rows.map((r) => r.symbol);
    const { sessionDate, minuteOfDay } = easternClock(new Date());
    const bars = await data.fetchBars(universe, sessionOpenInstant(sessionDate));

    const withBars = [...bars.values()].filter((list) => list.length > 0).length;
    const newest = [...bars.values()].flat().map((b) => b.ts).sort().at(-1) ?? "none";

    // The evaluation is printed below rather than returned, so the reasons stay
    // readable rather than being crushed onto one line.
    const evaluation = strategy.evaluate({
      sessionDate,
      minuteOfDay,
      bars,
      positions: [],
      tradedToday: new Set(),
    });

    say("");
    say(`    session ${sessionDate}, ${Math.floor(minuteOfDay / 60)}:${String(minuteOfDay % 60).padStart(2, "0")} ET, market ${marketOpen ? "OPEN" : "CLOSED"}`);
    say(`    ${withBars}/${universe.length} symbol(s) with bars, newest ${newest}`);
    say("");
    for (const pass of evaluation.passes.slice(0, 25)) {
      say(`      ${pass.symbol.padEnd(6)} no trade — ${pass.reason}`);
    }
    for (const signal of evaluation.signals) {
      if (signal.kind !== "entry") continue;
      say(`      ${signal.symbol.padEnd(6)} ENTRY at ${signal.referencePrice}`);
      for (const reason of signal.reasons) say(`               ${reason}`);
    }
    if (evaluation.signals.length === 0 && evaluation.passes.length === 0) {
      say("      no symbol had enough of this session to evaluate");
    }
    say("");

    return `${withBars} symbol(s), ${evaluation.signals.length} signal(s)`;
  });

  head("Strategy standing");
  if (pool && accountId) {
    await check(`${strategy.key}@${strategy.version}`, async () => {
      const standing = await strategyStanding(pool!, accountId!, strategy);
      if (!standing) throw new Error("not registered — run --register");
      return standing.status === "paper_approved"
        ? `${standing.status} (may trade)`
        : `${standing.status} (will NOT trade)`;
    });
  }

  await pool?.end();

  say("");
  if (failures === 0) {
    say("[32mEverything the loop needs is reachable and correct.[0m");
  } else {
    say(`[31m${failures} check(s) failed.[0m`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
