/**
 * The command a scheduler runs.
 *
 *   npm run session -w @vesti/execution               # trade the last session
 *   npm run session -w @vesti/execution -- --dry-run  # decide, submit nothing
 *   npm run session -w @vesti/execution -- --status   # what would it do, and why not
 *
 * Also the operator's controls, because a system that can trade unattended has
 * to be stoppable by someone who is not reading its source:
 *
 *   npm run session -w @vesti/execution -- --halt "reason"
 *   npm run session -w @vesti/execution -- --resume "reason"
 *   npm run session -w @vesti/execution -- --register
 *   npm run session -w @vesti/execution -- --promote active.trend_pullback --to paper_approved --why "..."
 *
 * Exit code is 1 when the session halted for a reason somebody should look at,
 * so cron mailing on failure does something useful.
 */

import pg from "pg";
import { OpeningRangeBreakout } from "@vesti/core/strategy/opening-range.ts";
import { TrendPullback } from "@vesti/core/strategy/trend-pullback.ts";
import type { Strategy, StrategyStatus } from "@vesti/core/strategy/types.ts";
import type { RegistrableStrategy } from "./strategy-registry.ts";
import { AlpacaBroker, ALPACA_PAPER_URL } from "./alpaca.ts";
import { allocateByTargetWeight, capitalPosition, recordDeposit } from "./capital.ts";
import { equityCurve } from "./equity.ts";
import { killSwitchState, resetKillSwitch, tripKillSwitch } from "./killswitch.ts";
import { runSession } from "./loop.ts";
import { currentStanding, promoteStrategy, registerStrategy } from "./strategy-registry.ts";

/**
 * Every strategy the DAILY loop may consider.
 *
 * Registered in code so the rules are reviewable; whether any of them is
 * allowed to trade is a database state nobody can change by editing this list.
 */
const REGISTRY: readonly Strategy[] = [new TrendPullback()];

/**
 * Strategies that belong to a worker rather than to this loop.
 *
 * They climb the same promotion ladder and are administered by the same
 * commands — `--register`, `--promote`, `--status` — because a second promotion
 * mechanism per engine is a second place for a strategy to be trading when
 * nobody thinks it is. What they do NOT do is run here: `runSession` evaluates
 * daily bars once after the close, and an intraday rule set fed that context
 * would either do nothing or do something meaningless.
 */
const WORKER_REGISTRY: readonly RegistrableStrategy[] = [new OpeningRangeBreakout()];

/** Everything registerable, whatever runs it. */
const ALL_STRATEGIES: readonly RegistrableStrategy[] = [...REGISTRY, ...WORKER_REGISTRY];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY unset.");

  const connectionString = process.env.DATABASE_URL_EXECUTION;
  if (!connectionString) throw new Error("DATABASE_URL_EXECUTION is unset. See .env.example.");

  const baseUrl = process.env.ALPACA_TRADING_BASE_URL ?? ALPACA_PAPER_URL;
  if (!baseUrl.includes("paper-api")) {
    throw new Error(
      `Refusing to run against ${baseUrl}. The autonomous loop is paper-only until the L3 gate passes.`,
    );
  }

  const pool = new pg.Pool({ connectionString, max: 4 });
  const broker = new AlpacaBroker({ keyId, secretKey, baseUrl });

  /**
   * Registering and promoting connect as vesti_research, not vesti_execution.
   *
   * The role that trades cannot write `strategies` — an execution service able
   * to authorise its own strategies would make the promotion ladder decorative,
   * and a compromised one could promote anything it liked. Opened lazily so a
   * plain session run never needs the research credential at all.
   */
  const registryPool = (): pg.Pool => {
    const url = process.env.DATABASE_URL_RESEARCH;
    if (!url) {
      throw new Error("DATABASE_URL_RESEARCH is unset — the registry is a research-role operation.");
    }
    return new pg.Pool({ connectionString: url, max: 2 });
  };

  try {
    const detail = await broker.getAccountDetail();
    const { rows: accounts } = await pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM accounts WHERE broker = 'alpaca' AND external_id = $1`,
      [detail.accountNumber],
    );
    const account = accounts[0];
    if (!account) {
      throw new Error(
        `No account row for Alpaca ${detail.accountNumber}. ` +
          `Run the paper runner once to bootstrap it: npm run paper -w @vesti/execution -- --dry-run`,
      );
    }

    // ── Operator controls ─────────────────────────────────────────────────
    if (flag("halt")) {
      const reason = arg("halt") ?? "halted by operator";
      const state = await tripKillSwitch(pool, {
        accountId: account.id,
        reason,
        by: process.env.USER ?? "operator",
      });
      say(`kill switch TRIPPED: ${state.reason} (by ${state.trippedBy})`);
      return;
    }

    if (flag("resume")) {
      const acknowledged = arg("resume");
      if (!acknowledged) {
        const state = await killSwitchState(pool, account.id);
        throw new Error(
          `Pass the reason back to confirm it was read: --resume "${state.reason ?? ""}"`,
        );
      }
      await resetKillSwitch(pool, {
        accountId: account.id,
        by: process.env.USER ?? "operator",
        acknowledgedReason: acknowledged,
      });
      say("kill switch reset — trading resumes on the next session");
      return;
    }

    if (flag("deposit")) {
      // Asserted by a human, never inferred from the broker's balance: a
      // deposit and an unrecorded fill both look like "our number is low", and
      // a command that quietly corrects the total erases what tells them apart.
      const amount = Number(arg("deposit"));
      if (!(amount > 0)) throw new Error(`Usage: --deposit <amount> [--ref "<reference>"]`);
      await recordDeposit(pool, {
        accountId: account.id,
        amount,
        reference: arg("ref") ?? `opening balance, Alpaca ${detail.accountNumber}`,
      });
      const moved = await allocateByTargetWeight(pool, { accountId: account.id });
      say(`deposited $${amount.toFixed(2)}`);
      for (const m of moved) say(`  allocated $${m.amount.toFixed(2)} to ${m.name}`);
      const after = await capitalPosition(pool, account.id);
      say(`ledger cash $${after.total.toFixed(2)} vs broker $${detail.cash.toFixed(2)}`);
      if (Math.abs(after.total - detail.cash) > 0.005) {
        say("  these should agree once every external transfer is recorded.");
      }
      return;
    }

    if (flag("allocate")) {
      const moved = await allocateByTargetWeight(pool, { accountId: account.id });
      if (moved.length === 0) say("nothing unallocated");
      for (const m of moved) say(`allocated $${m.amount.toFixed(2)} to ${m.name}`);
      return;
    }

    if (flag("register")) {
      const registry = registryPool();
      try {
        for (const strategy of ALL_STRATEGIES) {
          const registered = await registerStrategy(registry, {
            userId: account.user_id,
            strategy,
          });
          say(
            `${registered.slug}@${registered.codeVersion}  ${registered.status}  ` +
              `(record revision ${registered.version})`,
          );
        }
      } finally {
        await registry.end();
      }
      say("\nRegistered at experimental. Nothing trades until it is promoted.");
      return;
    }

    if (flag("promote")) {
      const slug = arg("promote");
      const to = arg("to") as StrategyStatus | undefined;
      const why = arg("why");
      if (!slug || !to || !why) {
        throw new Error(`Usage: --promote <slug> --to <status> --why "<rationale>"`);
      }
      const strategy = ALL_STRATEGIES.find((s) => s.key === slug);
      if (!strategy) throw new Error(`No strategy "${slug}" in the code registry.`);

      const registry = registryPool();
      let result;
      try {
        result = await promoteStrategy(registry, {
          userId: account.user_id,
          slug,
          codeVersion: strategy.version,
          to,
          rationale: why,
          by: process.env.USER ?? "operator",
        });
      } finally {
        await registry.end();
      }
      say(`${result.slug}@${result.codeVersion} is now ${result.status}`);
      if (result.status === "paper_approved") {
        say(
          "\nThis strategy will now trade on the next session. It has NOT been\n" +
            "backtested or validated — the Strategy Lab is Phase 4. Whatever it\n" +
            "earns or loses over the next few weeks is not evidence either way.",
        );
      }
      return;
    }

    if (flag("status")) {
      const kill = await killSwitchState(pool, account.id);
      const capital = await capitalPosition(pool, account.id);
      say(`account ${detail.accountNumber}  broker cash $${detail.cash.toFixed(2)}`);
      say(`kill switch: ${kill.isTripped ? `TRIPPED — ${kill.reason}` : "clear"}`);
      say(`\ncapital  ledger $${capital.total.toFixed(2)}  unallocated $${capital.unallocated.toFixed(2)}`);
      for (const m of capital.byMandate) {
        say(`  ${m.name}: $${m.cash.toFixed(2)} (target ${(m.targetWeight * 100).toFixed(0)}%)`);
      }
      if (Math.abs(capital.total - detail.cash) > 0.005) {
        say(
          `  ! ledger and broker disagree by $${(detail.cash - capital.total).toFixed(2)} — ` +
            `record external transfers with --deposit`,
        );
      }
      say("\nstrategies");
      for (const strategy of ALL_STRATEGIES) {
        const { rows } = await pool.query<{ id: string }>(
          `SELECT id FROM strategies WHERE user_id = $1 AND slug = $2`,
          [account.user_id, strategy.key],
        );
        const id = rows[0]?.id;
        const standing = id ? await currentStanding(pool, id, strategy.version) : null;
        say(
          `  ${strategy.key}@${strategy.version}  ${standing?.status ?? "UNREGISTERED"}  ` +
            `[${strategy.mandate}]`,
        );
      }

      const { rows: mandates } = await pool.query<{ id: string; name: string }>(
        `SELECT m.id, m.name FROM mandates m
          JOIN accounts a ON a.user_id = m.user_id WHERE a.id = $1 ORDER BY m.name`,
        [account.id],
      );
      say("\nequity curves");
      for (const mandate of mandates) {
        const curve = await equityCurve(pool, { accountId: account.id, mandateId: mandate.id });
        const last = curve.at(-1);
        say(
          `  ${mandate.name}: ${curve.length} session(s) recorded` +
            (last ? `, latest $${last.equity.toFixed(2)} on ${last.asOf}` : ""),
        );
      }
      return;
    }

    // ── The session ───────────────────────────────────────────────────────
    const outcome = await runSession({
      pool,
      broker,
      accountId: account.id,
      strategies: REGISTRY,
      ...(arg("as-of") ? { asOf: arg("as-of") as string } : {}),
      dryRun: flag("dry-run"),
      log: say,
    });

    say(`\nsession ${outcome.asOf}`);
    say(`  reconciled       ${outcome.reconciled}`);
    say(`  signals          ${outcome.signalsConsidered}`);
    say(`  orders submitted ${outcome.ordersSubmitted.length}`);
    for (const order of outcome.ordersSubmitted) {
      say(`    ${order.side} ${order.quantity} ${order.symbol}`);
    }
    for (const refusal of outcome.refusals) {
      say(`    refused ${refusal.side} ${refusal.symbol}: ${refusal.reason}`);
    }
    if (outcome.haltReason) {
      say(`  halted: ${outcome.haltReason}`);
      // A halt for "nothing is promoted" or "not a trading day" is the system
      // working. A halt for drift or a tripped switch wants a human.
      const benign =
        outcome.haltReason.includes("not a trading day") ||
        outcome.haltReason.includes("no strategy is promoted");
      if (!benign) process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
