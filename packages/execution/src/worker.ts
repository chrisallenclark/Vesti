/**
 * The autonomous paper-trading worker.
 *
 *   npm run worker -w @vesti/execution                    # run until the close
 *   npm run worker -w @vesti/execution -- --dry-run       # decide, submit nothing
 *   npm run worker -w @vesti/execution -- --once          # a single cycle
 *   npm run worker -w @vesti/execution -- --interval 15   # seconds between cycles
 *   npm run worker -w @vesti/execution -- --until 15:55   # stop at this ET time
 *
 * A process rather than a cron entry, because the DAY engine's rules are about
 * minutes and a scheduler with a five-minute floor cannot express them. It is
 * still built to be restarted at any moment: nothing is held across cycles that
 * would be wrong if the process died, so a supervisor, a runner timeout or a
 * laptop lid closing costs one cycle rather than a position.
 *
 * PAPER IS ENFORCED HERE, FIRST, BEFORE ANYTHING ELSE HAPPENS.
 *
 * Three independent checks, because one that can be satisfied by editing an
 * environment variable is not a boundary:
 *
 *   1. The trading URL must be Alpaca's paper host. A live URL is refused, not
 *      warned about.
 *   2. The account row must carry `is_live = false`. A paper URL against an
 *      account the database believes is live means one of the two is wrong, and
 *      neither is safe to assume.
 *   3. The broker adapter must report `isLive === false`.
 *
 * Any of the three failing stops the process before a pool is opened.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { OpeningRangeBreakout } from "@vesti/core/strategy/opening-range.ts";
import { easternClock } from "@vesti/core/strategy/intraday.ts";
import { AlpacaBroker, ALPACA_PAPER_URL } from "./alpaca.ts";
import { DayEngine, strategyStanding } from "./day-engine.ts";
import { snapshotEquity } from "./equity.ts";
import { IntradayMarketData } from "./market-data.ts";
import { Observer, describe } from "./observability.ts";

const DEFAULT_INTERVAL_SECONDS = 20;
/** Equity is re-marked this often, so the dashboard's curve does not go stale. */
const SNAPSHOT_EVERY_CYCLES = 15;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function say(message: string): void {
  process.stdout.write(`${new Date().toISOString()}  ${message}\n`);
}

/** "15:55" → minutes since midnight ET. Throws on anything else. */
function parseEasternTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`--until wants HH:MM in US/Eastern, got "${value}".`);
  return Number(match[1]) * 60 + Number(match[2]);
}

async function main(): Promise<void> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY unset.");

  const connectionString = process.env.DATABASE_URL_EXECUTION;
  if (!connectionString) throw new Error("DATABASE_URL_EXECUTION is unset. See .env.example.");

  // ── Paper boundary, check 1 of 3 ──────────────────────────────────────────
  const tradingBaseUrl = process.env.ALPACA_TRADING_BASE_URL ?? ALPACA_PAPER_URL;
  if (!tradingBaseUrl.includes("paper-api")) {
    throw new Error(
      `Refusing to start against ${tradingBaseUrl}. The autonomous worker is paper-only. ` +
        `Enabling live autonomous trading is an explicit decision that has not been made.`,
    );
  }
  const declaredMode = (process.env.TRADING_MODE ?? "PAPER").toUpperCase();
  if (declaredMode !== "PAPER") {
    throw new Error(`TRADING_MODE is "${declaredMode}". This worker runs only as PAPER.`);
  }

  const broker = new AlpacaBroker({ keyId, secretKey, baseUrl: tradingBaseUrl });
  // ── Check 2 of 3 ──────────────────────────────────────────────────────────
  if (broker.isLive) throw new Error("The broker adapter reports a live venue. Refusing to run.");

  const interval = Number(arg("interval") ?? DEFAULT_INTERVAL_SECONDS) * 1000;
  if (!(interval >= 5000)) throw new Error("--interval must be at least 5 seconds.");
  const until = arg("until") ? parseEasternTime(arg("until") as string) : null;
  const once = flag("once");
  const dryRun = flag("dry-run");

  const pool = new pg.Pool({ connectionString, max: 4 });
  const strategy = new OpeningRangeBreakout();

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) process.exit(1); // a second signal means "now"
    stopping = true;
    say(`${signal} — finishing the current cycle, then stopping`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let observer: Observer | undefined;

  try {
    const detail = await broker.getAccountDetail();
    const { rows } = await pool.query<{ id: string; is_live: boolean }>(
      `SELECT id, is_live FROM accounts WHERE broker = 'alpaca' AND external_id = $1`,
      [detail.accountNumber],
    );
    const account = rows[0];
    if (!account) {
      throw new Error(
        `No account row for Alpaca ${detail.accountNumber}. Bootstrap it first: ` +
          `npm run paper -w @vesti/execution -- --dry-run`,
      );
    }
    // ── Check 3 of 3 ────────────────────────────────────────────────────────
    if (account.is_live) {
      throw new Error(
        `Account ${detail.accountNumber} is recorded as LIVE in the database but this is the ` +
          `paper host. Refusing to run until that contradiction is resolved by a human.`,
      );
    }
    if (detail.tradingBlocked) throw new Error("Alpaca reports trading_blocked on this account.");

    observer = new Observer({
      pool,
      accountId: account.id,
      engine: strategy.engine,
      tradingMode: "paper",
      workerId: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
      echo: say,
    });

    const data = new IntradayMarketData({
      keyId,
      secretKey,
      ...(process.env.ALPACA_DATA_BASE_URL ? { baseUrl: process.env.ALPACA_DATA_BASE_URL } : {}),
      // IEX: the free plan withholds SIP for fifteen minutes, and a
      // fifteen-minute-old price is not a price to decide on. See market-data.ts.
      feed: (process.env.ALPACA_REALTIME_FEED as "iex" | "sip" | undefined) ?? "iex",
    });

    const engine = new DayEngine({
      pool,
      broker,
      data,
      observer,
      accountId: account.id,
      strategy,
      tradingBaseUrl,
      dryRun,
    });

    await observer.beat("starting", { alpacaOk: true, databaseOk: true });
    const standing = await strategyStanding(pool, account.id, strategy);
    await observer.say({
      kind: "worker_started",
      message:
        `DAY worker up — PAPER on Alpaca ${detail.accountNumber}, ` +
        `${strategy.key}@${strategy.version} is ${standing?.status ?? "UNREGISTERED"}` +
        (dryRun ? ", DRY RUN (nothing will be submitted)" : ""),
      detail: {
        workerId: observer.workerId,
        feed: data.feed,
        intervalSeconds: interval / 1000,
        until: until === null ? null : (arg("until") ?? null),
      },
    });

    let cycles = 0;
    for (;;) {
      const startedAt = Date.now();
      let status: Parameters<Observer["beat"]>[0] = "running";
      let marketOpen = false;
      let alpacaOk = false;

      try {
        const outcome = await engine.cycle();
        alpacaOk = true;
        marketOpen = outcome.marketOpen;

        if (outcome.haltReason) {
          // "Market closed" and "not promoted" are the system working, not a
          // fault. A drift or a tripped switch is neither, and the status has
          // to tell those apart or the dashboard is decorative.
          const benign =
            outcome.haltReason.startsWith("market closed") ||
            outcome.haltReason.includes("not paper_approved") ||
            outcome.haltReason.includes("not registered");
          status = benign ? "idle" : "halted";
          if (cycles === 0 || !benign) {
            await observer.say({
              level: benign ? "info" : "warn",
              kind: "halt",
              message: outcome.haltReason,
            });
          }
        } else if (outcome.symbolsScanned > 0 && cycles % 10 === 0) {
          await observer.say({
            level: "debug",
            kind: "heartbeat",
            message:
              `scanned ${outcome.symbolsScanned} symbol(s), ` +
              `${outcome.signals} signal(s), ${outcome.submitted.length} order(s)`,
          });
        }
      } catch (error) {
        status = "error";
        observer.markError(error);
        await observer.say({ level: "error", kind: "cycle_error", message: describe(error) });
        // Deliberately NOT rethrown. A venue blip, a dropped connection or a
        // transient database error must cost one cycle, not the session — the
        // whole reason this is a long-running process is that it can survive
        // things a batch job would die on.
      }

      await observer.beat(status, {
        alpacaOk,
        marketDataOk: alpacaOk && marketOpen,
        databaseOk: true,
        marketOpen,
        strategyActive: status === "running",
        killSwitch: status === "halted",
      });

      cycles += 1;
      if (cycles % SNAPSHOT_EVERY_CYCLES === 0) {
        try {
          await snapshotEquity(pool, {
            accountId: account.id,
            asOf: easternClock(new Date()).sessionDate,
          });
        } catch (error) {
          observer.markError(error);
        }
      }

      if (once || stopping) break;
      if (until !== null && easternClock(new Date()).minuteOfDay >= until) {
        await observer.say({ kind: "worker_stopping", message: `reached ${arg("until")} ET` });
        break;
      }

      // Interval measured from the START of the cycle, so a slow cycle does not
      // push every subsequent one later and drift the whole session's cadence.
      const elapsed = Date.now() - startedAt;
      await new Promise((resolve) => setTimeout(resolve, Math.max(1000, interval - elapsed)));
    }

    // A final mark, so the session's last state is on the curve even if the
    // process is stopped between scheduled snapshots.
    await snapshotEquity(pool, {
      accountId: account.id,
      asOf: easternClock(new Date()).sessionDate,
    }).catch(() => undefined);
    await observer.beat("stopped", { databaseOk: true });
    await observer.say({ kind: "worker_stopped", message: `stopped after ${cycles} cycle(s)` });
  } finally {
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error(describe(error));
  process.exit(1);
});
