/**
 * A paper trade, end to end, through every layer that will carry a live one.
 *
 *   npm run paper -w @vesti/execution -- --symbol AAPL --quantity 1 --mandate active
 *
 * The point is not to buy a share. It is that the share cannot be bought except
 * by traversing the whole chain: an intent recorded before anything is decided,
 * the deterministic risk engine producing a ruling, the execution gate refusing
 * anything that ruling did not authorise, the venue, and then the fill landing
 * in lots and cash under specific-lot rules — followed by reconciling our
 * ledger against the broker's own count.
 *
 * Every step is the real one. There is no test double anywhere in this file,
 * which is the only reason running it proves anything.
 *
 * `--dry-run` stops after the ruling, before anything is submitted.
 */

import pg from "pg";
import { guardedBroker } from "@vesti/core/broker/guard.ts";
import { DEFAULT_LIMITS, evaluate } from "@vesti/core/risk/engine.ts";
import type {
  MandateKind,
  MarketState,
  PortfolioState,
  RiskLimits,
} from "@vesti/core/risk/types.ts";
import { AlpacaBroker, ALPACA_PAPER_URL } from "./alpaca.ts";
import { OrderLedger } from "./ledger.ts";
import { pollFills, streamFills } from "./fills.ts";
import { reconcile } from "./reconcile.ts";
import { assertNoSelfCross } from "./selfcross.ts";

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

/** Waits for a condition, polling. Returns false on timeout rather than throwing. */
async function waitFor(
  check: () => Promise<boolean>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
}

async function main(): Promise<void> {
  const symbol = (arg("symbol") ?? "AAPL").toUpperCase();
  const quantity = Number(arg("quantity") ?? "1");
  const mandateKind = (arg("mandate") ?? "active") as MandateKind;
  const side = (arg("side") ?? "buy") as "buy" | "sell";
  const dryRun = flag("dry-run");
  // Which strategy this order is attributed to. Not cosmetic: the order records
  // it, the lot inherits it from the order, and every engine finds its
  // positions by it. This tool placed two shares of AVGO in August with no
  // strategy attached, and they sat in the account for nine days owned by
  // nobody — held at the broker, exited by no flatten, absent from every
  // strategy's P&L, and indistinguishable from a position under management.
  const strategyKey = arg("strategy") ?? "day.opening_range_breakout";

  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY unset.");

  const connectionString = process.env.DATABASE_URL_EXECUTION;
  if (!connectionString) throw new Error("DATABASE_URL_EXECUTION is unset. See .env.example.");

  const baseUrl = process.env.ALPACA_TRADING_BASE_URL ?? ALPACA_PAPER_URL;
  // A live URL here is a decision nobody should make by leaving an environment
  // variable set. Phase 9 opens this deliberately; until then it is shut.
  if (!baseUrl.includes("paper-api")) {
    throw new Error(
      `Refusing to trade against ${baseUrl}. This runner is paper-only until the L3 gate passes.`,
    );
  }

  const pool = new pg.Pool({ connectionString, max: 4 });
  const ledger = new OrderLedger(pool);
  const alpaca = new AlpacaBroker({ keyId, secretKey, baseUrl });

  try {
    // ── Pre-flight ────────────────────────────────────────────────────────
    const detail = await alpaca.getAccountDetail();
    if (detail.tradingBlocked) throw new Error("Alpaca reports trading_blocked on this account.");
    const marketOpen = await alpaca.isMarketOpen();
    say(
      `account ${detail.accountNumber}  status ${detail.status}  cash $${detail.cash.toFixed(2)}  ` +
        `market ${marketOpen ? "OPEN" : "CLOSED"}`,
    );

    const { accountId, mandateId, securityId } = await resolveEntities(pool, {
      broker: "alpaca",
      externalId: detail.accountNumber,
      mandateKind,
      symbol,
    });

    // Resolved before anything is submitted, and fatal if missing. A proof
    // order that cannot say who placed it creates precisely the orphan this
    // whole tool exists to prove cannot happen.
    const { rows: strategyRows } = await pool.query<{ id: string; slug: string }>(
      `SELECT sv.id, st.slug
         FROM strategy_versions sv
         JOIN strategies st ON st.id = sv.strategy_id
         JOIN accounts a    ON a.user_id = st.user_id
        WHERE a.id = $1 AND st.slug = $2
        ORDER BY sv.version DESC
        LIMIT 1`,
      [accountId, strategyKey],
    );
    const strategyVersionId = strategyRows[0]?.id;
    if (!strategyVersionId) {
      throw new Error(
        `No strategy "${strategyKey}" is registered for this account, so an order placed now ` +
          `would belong to nobody and nothing would ever exit the position it opens. ` +
          `Register it first (npm run session -w @vesti/execution -- --register), or pass ` +
          `--strategy <key> naming one that exists.`,
      );
    }
    say(`attributing to  ${strategyRows[0]!.slug}`);

    // Detection, not netting — see selfcross.ts. Better a clear refusal here
    // than a wash-trade rejection after submission.
    await assertNoSelfCross(pool, { accountId, securityId, side, symbol });

    // ── The risk ruling ───────────────────────────────────────────────────
    // The real engine, on real portfolio state. Fabricating an approval would
    // make everything downstream of it theatre.
    const lastPrice = await lastCloseFor(pool, securityId);
    const atrFraction = await atrFractionFor(pool, securityId);
    const stopPrice = Number((lastPrice * (1 - 2 * atrFraction)).toFixed(2));

    const portfolio = await portfolioState(pool, accountId, detail.cash);
    const market: MarketState = {
      averageDollarVolume: await averageDollarVolumeFor(pool, securityId),
      spreadFraction: 0.0005,
      atrFraction,
      // No measured expectancy exists yet — there is no strategy and no
      // backtest. Null is the honest value, and the engine treats it as "no
      // evidence to size up on" rather than as neutral.
      expectancyR: null,
      sampleSize: 0,
    };
    const limits: RiskLimits = DEFAULT_LIMITS;

    const ruling = evaluate(
      {
        mandate: mandateKind,
        side,
        symbol,
        sector: null,
        entryPrice: lastPrice,
        stopPrice,
        targetPrice: null,
        tier: "experimental",
        isBinaryEvent: false,
      },
      portfolio,
      market,
      limits,
    );

    say(`\nrisk engine (${ruling.engineVersion})`);
    say(`  requested  ${quantity}`);
    say(`  decision   ${ruling.decision}`);
    say(`  approved   ${ruling.approvedQuantity}`);
    say(`  risk       $${ruling.riskAmount.toFixed(2)} with a $${stopPrice} stop`);
    for (const line of ruling.reasoning) say(`    ${line}`);
    for (const violation of ruling.violations) say(`  ! ${violation.code}: ${violation.message}`);

    // The engine sizes from risk budget and will usually permit far more than
    // one share. We want the smaller of what it allowed and what was asked,
    // floored: these are whole-share instruments, and rounding up would put the
    // order above what the ruling authorised, which the gate would then refuse.
    const finalQuantity = Math.floor(Math.min(quantity, ruling.approvedQuantity) + 1e-9);
    if (ruling.decision === "reject" || finalQuantity < 1) {
      say("\nrisk engine refused the trade. Nothing submitted.");
      return;
    }

    // ── Intent and ruling, recorded ───────────────────────────────────────
    const orderId = await ledger.recordIntent({
      accountId,
      mandateId,
      securityId,
      side,
      kind: "market",
      quantity: finalQuantity,
      timeInForce: "day",
      strategyVersionId,
    });
    const attached = await ledger.recordRiskRuling(orderId, {
      decision: ruling.decision,
      requestedQuantity: finalQuantity,
      approvedQuantity: Math.min(finalQuantity, ruling.approvedQuantity),
      violations: ruling.violations,
      inputs: { entryPrice: lastPrice, stopPrice, atrFraction, limits },
      engineVersion: ruling.engineVersion,
    });
    say(`\norder ${orderId}`);
    say(`  risk evaluation ${attached.riskEvaluationId}`);

    if (dryRun) {
      say("\n--dry-run: stopping before submission.");
      await ledger.recordTerminal(orderId, "canceled", "dry run");
      return;
    }

    // ── The gate, then the venue ──────────────────────────────────────────
    // guardedBroker wraps the adapter so the kill switch and the approval are
    // checked once, here, for every broker there will ever be.
    const broker = guardedBroker(alpaca, {
      isKillSwitchTripped: () => isKillSwitchTripped(pool, accountId),
      lookupRiskApproval: async (id) => {
        const approval = await lookupApproval(pool, id);
        return approval;
      },
    });

    const submitted = await broker.submitOrder({
      clientOrderId: orderId,
      symbol,
      side,
      kind: "market",
      quantity: finalQuantity,
      timeInForce: "day",
      riskEvaluationId: attached.riskEvaluationId,
    });
    await ledger.recordSubmission(orderId, submitted.brokerOrderId);
    say(`  submitted to ${alpaca.name} as ${submitted.brokerOrderId} (${submitted.status})`);

    // ── Fills ─────────────────────────────────────────────────────────────
    // Stream and poller both run. They post through the same cumulative path,
    // so whichever is second finds nothing left to do.
    const stream = streamFills({
      keyId,
      secretKey,
      streamUrl: `${baseUrl.replace("https://", "wss://")}/stream`,
      ledger,
      onFill: ({ posted }) => {
        if (!posted.applied) return;
        const detail =
          posted.lotOpened !== null
            ? `lot ${posted.lotOpened} opened`
            : `closed ${posted.allocations.length} lot(s), realised $${posted.realizedPnl.toFixed(2)}`;
        say(`  stream: cumulative ${posted.filledQuantity} filled, ${detail}`);
      },
      onError: (error) => say(`  stream error: ${String(error)}`),
    });

    try {
      await Promise.race([
        stream.ready,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);

      const filled = await waitFor(
        async () => {
          await pollFills(alpaca, ledger, [orderId], {
            onError: (error) => say(`  poll error: ${String(error)}`),
          });
          const { rows } = await pool.query<{ status: string; filled_quantity: string }>(
            `SELECT status, filled_quantity FROM orders WHERE id = $1`,
            [orderId],
          );
          return rows[0]?.status === "filled";
        },
        { timeoutMs: 60_000, intervalMs: 2000 },
      );

      if (!filled) {
        say("\norder did not fill within 60s. It remains working; the poller will catch it.");
        return;
      }
    } finally {
      stream.stop();
    }

    // ── What actually landed ──────────────────────────────────────────────
    const { rows: fills } = await pool.query<{
      quantity: string;
      price: string;
      broker_fill_id: string;
    }>(`SELECT quantity, price, broker_fill_id FROM fills WHERE order_id = $1`, [orderId]);
    say(`\nfills`);
    for (const fill of fills) {
      say(`  ${fill.quantity} @ $${fill.price}  [${fill.broker_fill_id}]`);
    }

    const position = await ledger.positionForMandate(accountId, mandateId, securityId);
    say(`\n${mandateKind} mandate holds ${position.quantity} ${symbol} at $${position.averageCost.toFixed(4)}`);
    say(`cash (ledger, this mandate)  $${(await ledger.cashBalance(accountId, mandateId)).toFixed(2)}`);

    // ── Reconciliation ────────────────────────────────────────────────────
    const positions = await alpaca.listPositions();
    const report = await reconcile(pool, { accountId, positions });
    say(`\nreconciliation against ${alpaca.name}`);
    say(`  positions checked ${report.positionsChecked}`);
    if (report.balanced) {
      say(`  balanced — our lots agree with the broker's own count`);
    } else {
      for (const d of report.discrepancies) {
        say(`  ${d.kind} ${d.symbol ?? ""}: ledger ${d.ledger} vs broker ${d.broker}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// ── Supporting reads ────────────────────────────────────────────────────────

/**
 * Finds or creates the user, mandates, account and security this run needs.
 *
 * Written as upserts so the runner is repeatable. The account is matched on the
 * broker's own account number, so pointing at a different Alpaca account
 * produces a different row rather than silently merging two portfolios.
 */
async function resolveEntities(
  pool: pg.Pool,
  params: { broker: string; externalId: string; mandateKind: MandateKind; symbol: string },
): Promise<{ accountId: string; mandateId: string; securityId: string }> {
  const { rows: existing } = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM accounts WHERE broker = $1 AND external_id = $2`,
    [params.broker, params.externalId],
  );

  let userId: string;
  let accountId: string;

  if (existing[0]) {
    accountId = existing[0].id;
    userId = existing[0].user_id;
  } else {
    // vesti_execution cannot write users or mandates — it is the role that
    // trades, not the one that administers. Bootstrapping needs the owner
    // connection, and failing loudly here is better than granting it more.
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) {
      throw new Error(
        "No account for this Alpaca account number yet, and DATABASE_URL is unset. " +
          "Bootstrapping a user, mandates and an account needs the owner connection.",
      );
    }
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows: users } = await admin.query<{ id: string }>(
        // The predicate is required: users_email_key is a PARTIAL unique index
        // (email is nullable), and ON CONFLICT cannot infer a partial index
        // without repeating its WHERE clause.
        `INSERT INTO users (email, display_name) VALUES ($1, 'Vesti operator')
         ON CONFLICT (email) WHERE email IS NOT NULL
         DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [process.env.VESTI_OPERATOR_EMAIL ?? "operator@vesti.local"],
      );
      userId = users[0]!.id;

      await admin.query(
        `INSERT INTO mandates (user_id, kind, name, target_weight)
         VALUES ($1, 'active', 'Active', 0.30),
                ($1, 'catalyst', 'Catalyst', 0.20),
                ($1, 'long_term', 'Long-Term', 0.50)
         ON CONFLICT (user_id, kind) DO NOTHING`,
        [userId],
      );

      const { rows: accounts } = await admin.query<{ id: string }>(
        `INSERT INTO accounts (user_id, broker, external_id, is_live)
         VALUES ($1, $2, $3, false)
         RETURNING id`,
        [userId, params.broker, params.externalId],
      );
      accountId = accounts[0]!.id;
    } finally {
      await admin.end();
    }
  }

  const { rows: mandates } = await pool.query<{ id: string }>(
    `SELECT id FROM mandates WHERE user_id = $1 AND kind = $2`,
    [userId, params.mandateKind],
  );
  if (!mandates[0]) throw new Error(`No ${params.mandateKind} mandate for this user.`);

  const { rows: securities } = await pool.query<{ id: string }>(
    `SELECT id FROM securities WHERE symbol = $1 AND delisted_at IS NULL`,
    [params.symbol],
  );
  if (!securities[0]) {
    throw new Error(
      `${params.symbol} is not in securities. Ingest it first: ` +
        `npm run ingest -w @vesti/ingest -- sync --symbols ${params.symbol}`,
    );
  }

  return { accountId, mandateId: mandates[0].id, securityId: securities[0].id };
}

async function lastCloseFor(pool: pg.Pool, securityId: string): Promise<number> {
  const { rows } = await pool.query<{ close: string }>(
    `SELECT close FROM bars_daily WHERE security_id = $1 ORDER BY session_date DESC LIMIT 1`,
    [securityId],
  );
  if (!rows[0]) throw new Error("No bars for this security. Ingest before trading it.");
  return Number(rows[0].close);
}

/** ATR as a fraction of price, from the last 20 sessions. Drives the stop distance. */
async function atrFractionFor(pool: pg.Pool, securityId: string): Promise<number> {
  const { rows } = await pool.query<{ atr: string | null }>(
    `SELECT avg((high - low) / close) AS atr
       FROM (SELECT high, low, close FROM bars_daily
              WHERE security_id = $1 ORDER BY session_date DESC LIMIT 20) recent`,
    [securityId],
  );
  return Number(rows[0]?.atr ?? 0.02);
}

async function averageDollarVolumeFor(pool: pg.Pool, securityId: string): Promise<number> {
  const { rows } = await pool.query<{ adv: string | null }>(
    `SELECT avg(close * volume) AS adv
       FROM (SELECT close, volume FROM bars_daily
              WHERE security_id = $1 ORDER BY session_date DESC LIMIT 20) recent`,
    [securityId],
  );
  // IEX volume is a fraction of consolidated, so this understates liquidity and
  // the liquidity cap therefore binds earlier than it should. Erring small is
  // the right direction for a cap; noted so it is not mistaken for the truth.
  return Number(rows[0]?.adv ?? 0);
}

/**
 * Portfolio state for the risk engine, from the ledger.
 *
 * Equity is the broker's cash plus the market value of what our lots say we
 * hold. Open risk uses each lot's own stop, which is why the stop is stored on
 * the lot at entry rather than recomputed later.
 */
async function portfolioState(
  pool: pg.Pool,
  accountId: string,
  brokerCash: number,
): Promise<PortfolioState> {
  // Valued at the last close, NOT at cost. The engine derives sellable size
  // from market value over the reference price, so feeding it cost basis makes
  // an exit of a profitable position come back as 0.99 shares — the trade is
  // then refused for being smaller than one share, and the position cannot be
  // closed at all. Both sides read the same `bars_daily` close, so a full exit
  // divides out to exactly the shares held.
  const { rows } = await pool.query<{
    mandate_kind: MandateKind;
    symbol: string;
    quantity: string;
    cost: string;
    stop: string | null;
    last_close: string | null;
  }>(
    `SELECT m.kind AS mandate_kind, s.symbol,
            sum(l.remaining) AS quantity,
            sum(l.remaining * l.cost_basis) AS cost,
            min(l.stop_price) AS stop,
            max(p.close) AS last_close
       FROM lots l
       JOIN mandates m   ON m.id = l.mandate_id
       JOIN securities s ON s.id = l.security_id
       LEFT JOIN LATERAL (
         SELECT b.close FROM bars_daily b
          WHERE b.security_id = l.security_id
          ORDER BY b.session_date DESC LIMIT 1
       ) p ON true
      WHERE l.account_id = $1 AND l.remaining > 0
      GROUP BY m.kind, s.symbol`,
    [accountId],
  );

  const mandateEquity: Record<MandateKind, number> = {
    active: 0,
    catalyst: 0,
    long_term: 0,
  };
  const positions = rows.map((row) => {
    const quantity = Number(row.quantity);
    const cost = Number(row.cost);
    // Falls back to cost only when a holding has no bars at all, which means it
    // was never ingested — worth valuing at something rather than zero, and
    // worth noticing.
    const marketValue = row.last_close === null ? cost : quantity * Number(row.last_close);
    mandateEquity[row.mandate_kind] += marketValue;
    const stop = row.stop === null ? null : Number(row.stop);
    return {
      symbol: row.symbol,
      sector: null,
      mandate: row.mandate_kind,
      marketValue,
      openRisk: stop === null ? 0 : Math.max(0, marketValue - stop * quantity),
      isBinaryEvent: false,
    };
  });

  const invested = positions.reduce((sum, p) => sum + p.marketValue, 0);
  const totalEquity = brokerCash + invested;

  // Unallocated cash is split by target weight so each mandate has a budget
  // even before it holds anything. Without this the first trade in a mandate
  // sizes against zero equity and the engine correctly refuses it.
  const { rows: weights } = await pool.query<{ kind: MandateKind; target_weight: string }>(
    `SELECT m.kind, m.target_weight FROM mandates m
      JOIN accounts a ON a.user_id = m.user_id WHERE a.id = $1`,
    [accountId],
  );
  for (const weight of weights) {
    mandateEquity[weight.kind] += brokerCash * Number(weight.target_weight);
  }

  return {
    totalEquity,
    cash: brokerCash,
    mandateEquity,
    positions,
    drawdown: 0,
    dayPnl: 0,
    openPositionCount: positions.length,
  };
}

async function isKillSwitchTripped(pool: pg.Pool, accountId: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_tripped: boolean }>(
    `SELECT is_tripped FROM kill_switch_state WHERE account_id = $1`,
    [accountId],
  );
  // No row means never tripped. Deliberately permissive: the switch is armed by
  // being set, and an account that has never had one is not halted.
  return rows[0]?.is_tripped ?? false;
}

async function lookupApproval(
  pool: pg.Pool,
  id: string,
): Promise<{
  id: string;
  symbol: string;
  side: "buy" | "sell";
  approvedQuantity: number;
  decision: "approve" | "reduce" | "reject";
} | null> {
  const { rows } = await pool.query<{
    id: string;
    symbol: string;
    side: "buy" | "sell";
    approved_qty: string;
    decision: "approve" | "reduce" | "reject";
  }>(
    `SELECT r.id, s.symbol, r.side, r.approved_qty, r.decision
       FROM risk_evaluations r JOIN securities s ON s.id = r.security_id
      WHERE r.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    approvedQuantity: Number(row.approved_qty),
    decision: row.decision,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
