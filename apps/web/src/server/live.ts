import "server-only";
import { num } from "./db";
import { Pool } from "pg";

/**
 * Everything the trading dashboard shows, in one read.
 *
 * One query set rather than a route per panel, because the panels have to agree
 * with each other. A page that fetches status, positions and the feed
 * separately will eventually render "no positions" beside "position opened" —
 * two true answers taken half a second apart — and the operator has no way to
 * tell that from a bug in the ledger.
 *
 * Connects as `vesti_app`, which has SELECT on everything and cannot write
 * orders, fills or lots. If anything in the request path ever tries to trade,
 * Postgres answers `permission denied for table orders`. The one exception is
 * the kill switch, which the app may TRIP through a SECURITY DEFINER function
 * and cannot reset — see migration 013.
 */

let pool: Pool | undefined;

function livePool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL_APP;
  if (!connectionString) {
    throw new Error("DATABASE_URL_APP is unset. The web app connects as vesti_app — see .env.example.");
  }
  pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000 });
  return pool;
}

/** How long since a heartbeat before the worker is presumed gone. */
const HEARTBEAT_STALE_MS = 90_000;

export type TraderStatus =
  | "RUNNING"
  | "IDLE"
  | "HALTED"
  | "ERROR"
  | "STOPPED"
  | "STARTING"
  | "OFFLINE";

export interface WorkerView {
  engine: string;
  /** What the worker last said, corrected to OFFLINE when it stopped saying it. */
  status: TraderStatus;
  tradingMode: string;
  workerId: string;
  alpacaOk: boolean;
  marketDataOk: boolean;
  databaseOk: boolean;
  marketOpen: boolean;
  strategyActive: boolean;
  killSwitch: boolean;
  startedAt: string | null;
  lastBeatAt: string | null;
  lastDataAt: string | null;
  lastEvalAt: string | null;
  lastOrderAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  cycles: number;
  /** Seconds since the last heartbeat. The number that decides OFFLINE. */
  beatAgeSeconds: number | null;
}

export interface LivePosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlFraction: number;
  currentPrice: number | null;
  /** From our own lots, when this engine opened it. */
  stopPrice: number | null;
  targetPrice: number | null;
  engine: string | null;
  strategy: string | null;
  openedAt: string | null;
  entryReasons: string[];
}

export interface OpenOrder {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  filledQuantity: number;
  status: string;
  brokerOrderId: string | null;
  submittedAt: string | null;
  engine: string | null;
}

export interface ActivityEntry {
  id: string;
  occurredAt: string;
  engine: string;
  level: string;
  kind: string;
  symbol: string | null;
  message: string;
  orderId: string | null;
}

export interface JournalEntry {
  orderId: string;
  symbol: string;
  engine: string | null;
  strategy: string | null;
  intent: string | null;
  side: string;
  quantity: number;
  filledQuantity: number;
  status: string;
  fillPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  riskAmount: number | null;
  reasons: string[];
  exitReason: string | null;
  realizedPnl: number | null;
  holdingSeconds: number | null;
  decidedAt: string;
}

export interface LiveView {
  accountId: string | null;
  accountNumber: string | null;
  isLive: boolean;
  asOf: string;
  broker: {
    takenAt: string | null;
    ageSeconds: number | null;
    cash: number;
    buyingPower: number;
    equity: number;
    dayPnl: number | null;
    marketOpen: boolean;
  } | null;
  killSwitch: { tripped: boolean; reason: string | null; by: string | null; at: string | null };
  workers: WorkerView[];
  strategies: Array<{ slug: string; status: string; mandate: string; codeVersion: string | null }>;
  positions: LivePosition[];
  openOrders: OpenOrder[];
  activity: ActivityEntry[];
  journal: JournalEntry[];
  realizedToday: number;
}

/**
 * Maps a stored status to what the operator should actually be told.
 *
 * The correction that matters: a worker that dies does not write "stopped", it
 * simply stops writing. Its last row still says `running`, and a dashboard that
 * renders it verbatim shows RUNNING for a process that has not existed since
 * 10:40. Age of the heartbeat is the only thing that can tell them apart, so it
 * is checked here rather than trusted from the row.
 */
function correctedStatus(stored: string, beatAgeSeconds: number | null): TraderStatus {
  if (stored === "stopped") return "STOPPED";
  if (beatAgeSeconds === null || beatAgeSeconds * 1000 > HEARTBEAT_STALE_MS) return "OFFLINE";
  switch (stored) {
    case "running":
      return "RUNNING";
    case "idle":
      return "IDLE";
    case "halted":
      return "HALTED";
    case "error":
      return "ERROR";
    case "starting":
      return "STARTING";
    default:
      return "OFFLINE";
  }
}

const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();

export async function readLiveView(): Promise<LiveView> {
  const client = await livePool().connect();
  try {
    const { rows: accounts } = await client.query<{
      id: string;
      external_id: string | null;
      is_live: boolean;
    }>(
      `SELECT id, external_id, is_live FROM accounts
        WHERE broker = 'alpaca' ORDER BY created_at LIMIT 1`,
    );
    const account = accounts[0];
    const asOf = new Date().toISOString();

    if (!account) {
      return {
        accountId: null,
        accountNumber: null,
        isLive: false,
        asOf,
        broker: null,
        killSwitch: { tripped: false, reason: null, by: null, at: null },
        workers: [],
        strategies: [],
        positions: [],
        openOrders: [],
        activity: [],
        journal: [],
        realizedToday: 0,
      };
    }

    const [
      snapshot,
      kill,
      workers,
      strategies,
      lots,
      openOrders,
      activity,
      journal,
      realized,
    ] = await Promise.all([
      client.query<{
        taken_at: Date;
        cash: string;
        buying_power: string;
        equity: string;
        positions: unknown;
        day_pnl: string | null;
        market_open: boolean;
      }>(`SELECT * FROM broker_snapshots WHERE account_id = $1`, [account.id]),

      client.query<{
        is_tripped: boolean;
        reason: string | null;
        tripped_by: string | null;
        tripped_at: Date | null;
      }>(
        `SELECT is_tripped, reason, tripped_by, tripped_at
           FROM kill_switch_state WHERE account_id = $1`,
        [account.id],
      ),

      client.query<{
        engine: string;
        status: string;
        trading_mode: string;
        worker_id: string;
        alpaca_ok: boolean;
        market_data_ok: boolean;
        database_ok: boolean;
        market_open: boolean;
        strategy_active: boolean;
        kill_switch: boolean;
        started_at: Date;
        last_beat_at: Date;
        last_data_at: Date | null;
        last_eval_at: Date | null;
        last_order_at: Date | null;
        last_error: string | null;
        last_error_at: Date | null;
        cycles: string;
        beat_age: string;
      }>(
        `SELECT *, extract(epoch FROM (now() - last_beat_at)) AS beat_age
           FROM worker_state WHERE account_id = $1 ORDER BY engine`,
        [account.id],
      ),

      // Highest revision per rule set, which is its current standing — the table
      // is append-only, so a promotion is a new row rather than an update.
      client.query<{
        slug: string;
        status: string;
        mandate_kind: string;
        code_version: string | null;
      }>(
        `SELECT DISTINCT ON (st.slug, sv.spec->>'code_version')
                st.slug, sv.status, st.mandate_kind, sv.spec->>'code_version' AS code_version
           FROM strategy_versions sv
           JOIN strategies st ON st.id = sv.strategy_id
           JOIN accounts a    ON a.user_id = st.user_id
          WHERE a.id = $1
          ORDER BY st.slug, sv.spec->>'code_version', sv.version DESC`,
        [account.id],
      ),

      // Our own view of what is held, with the plan recorded at entry. Joined to
      // the decision that opened it so the page can say WHY a position is on.
      client.query<{
        symbol: string;
        quantity: string;
        cost: string;
        stop_price: string | null;
        target_price: string | null;
        opened_at: Date;
        engine: string | null;
        strategy_key: string | null;
        reasons: string[] | null;
      }>(
        `SELECT s.symbol,
                sum(l.remaining)                AS quantity,
                sum(l.remaining * l.cost_basis) AS cost,
                min(l.stop_price)               AS stop_price,
                min(l.target_price)             AS target_price,
                min(l.opened_at)                AS opened_at,
                min(d.engine)                   AS engine,
                min(d.strategy_key)             AS strategy_key,
                (array_agg(d.reasons ORDER BY d.decided_at DESC)
                   FILTER (WHERE d.reasons IS NOT NULL))[1] AS reasons
           FROM lots l
           JOIN securities s ON s.id = l.security_id
           LEFT JOIN LATERAL (
             SELECT td.engine, td.strategy_key, td.reasons, td.decided_at
               FROM trade_decisions td
               JOIN orders o ON o.id = td.order_id
              WHERE o.security_id = l.security_id
                AND o.account_id = l.account_id
                AND td.intent = 'entry'
              ORDER BY td.decided_at DESC LIMIT 1
           ) d ON true
          WHERE l.account_id = $1 AND l.remaining > 0
          GROUP BY s.symbol`,
        [account.id],
      ),

      client.query<{
        id: string;
        symbol: string;
        side: string;
        quantity: string;
        filled_quantity: string;
        status: string;
        broker_order_id: string | null;
        submitted_at: Date | null;
        engine: string | null;
      }>(
        `SELECT o.id, s.symbol, o.side, o.quantity, o.filled_quantity, o.status,
                o.broker_order_id, o.submitted_at, d.engine
           FROM orders o
           JOIN securities s ON s.id = o.security_id
           LEFT JOIN trade_decisions d ON d.order_id = o.id
          WHERE o.account_id = $1
            AND o.status IN ('pending_risk','pending_new','working','partially_filled')
          ORDER BY o.created_at DESC`,
        [account.id],
      ),

      client.query<{
        id: string;
        occurred_at: Date;
        engine: string;
        level: string;
        kind: string;
        symbol: string | null;
        message: string;
        order_id: string | null;
      }>(
        `SELECT id, occurred_at, engine, level, kind, symbol, message, order_id
           FROM activity_log WHERE account_id = $1
          ORDER BY occurred_at DESC, id DESC LIMIT 120`,
        [account.id],
      ),

      client.query<{
        order_id: string;
        symbol: string;
        engine: string | null;
        strategy_key: string | null;
        intent: string | null;
        side: string;
        quantity: string;
        filled_quantity: string;
        status: string;
        fill_price: string | null;
        stop_price: string | null;
        target_price: string | null;
        risk_amount: string | null;
        reasons: string[] | null;
        exit_reason: string | null;
        realized_pnl: string | null;
        holding_seconds: string | null;
        decided_at: Date | null;
        submitted_at: Date | null;
      }>(
        `SELECT order_id, symbol, engine, strategy_key, intent, side, quantity,
                filled_quantity, status, fill_price, stop_price, target_price,
                risk_amount, reasons, exit_reason, realized_pnl, holding_seconds,
                decided_at, submitted_at
           FROM trade_journal
          WHERE account_id = $1
          ORDER BY coalesce(decided_at, submitted_at) DESC NULLS LAST
          LIMIT 40`,
        [account.id],
      ),

      // Banked P&L from exits that filled today, in US/Eastern — the session
      // boundary the market uses, not the server's.
      client.query<{ pnl: string | null }>(
        `SELECT sum(ola.quantity * (f.price - l.cost_basis)) AS pnl
           FROM order_lot_allocations ola
           JOIN orders o ON o.id = ola.order_id
           JOIN lots l   ON l.id = ola.lot_id
           JOIN LATERAL (
             SELECT sum(quantity * price) / nullif(sum(quantity), 0) AS price,
                    max(filled_at) AS filled_at
               FROM fills WHERE order_id = o.id
           ) f ON true
          WHERE o.account_id = $1
            AND (f.filled_at AT TIME ZONE 'America/New_York')::date
                = (now() AT TIME ZONE 'America/New_York')::date`,
        [account.id],
      ),
    ]);

    const snap = snapshot.rows[0];
    const marked = new Map(
      ((snap?.positions as LivePosition[] | undefined) ?? []).map((p) => [p.symbol, p]),
    );

    return {
      accountId: account.id,
      accountNumber: account.external_id,
      isLive: account.is_live,
      asOf,
      broker: snap
        ? {
            takenAt: iso(snap.taken_at),
            ageSeconds: Math.round((Date.now() - snap.taken_at.getTime()) / 1000),
            cash: num(snap.cash),
            buyingPower: num(snap.buying_power),
            equity: num(snap.equity),
            dayPnl: snap.day_pnl === null ? null : num(snap.day_pnl),
            marketOpen: snap.market_open,
          }
        : null,
      killSwitch: {
        tripped: kill.rows[0]?.is_tripped ?? false,
        reason: kill.rows[0]?.reason ?? null,
        by: kill.rows[0]?.tripped_by ?? null,
        at: iso(kill.rows[0]?.tripped_at ?? null),
      },
      workers: workers.rows.map((w) => {
        const beatAgeSeconds = w.beat_age === null ? null : Math.round(num(w.beat_age));
        return {
          engine: w.engine,
          status: correctedStatus(w.status, beatAgeSeconds),
          tradingMode: w.trading_mode,
          workerId: w.worker_id,
          alpacaOk: w.alpaca_ok,
          marketDataOk: w.market_data_ok,
          databaseOk: w.database_ok,
          marketOpen: w.market_open,
          strategyActive: w.strategy_active,
          killSwitch: w.kill_switch,
          startedAt: iso(w.started_at),
          lastBeatAt: iso(w.last_beat_at),
          lastDataAt: iso(w.last_data_at),
          lastEvalAt: iso(w.last_eval_at),
          lastOrderAt: iso(w.last_order_at),
          lastError: w.last_error,
          lastErrorAt: iso(w.last_error_at),
          cycles: Number(w.cycles),
          beatAgeSeconds,
        };
      }),
      strategies: strategies.rows.map((s) => ({
        slug: s.slug,
        status: s.status,
        mandate: s.mandate_kind,
        codeVersion: s.code_version,
      })),
      positions: lots.rows.map((row) => {
        const quantity = num(row.quantity);
        const averageCost = num(row.cost) / (quantity || 1);
        const mark = marked.get(row.symbol);
        // The broker's mark when there is one, cost when there is not. A
        // position valued at cost is not wrong so much as not yet marked, and
        // showing zero P&L is a smaller lie than showing a made-up price.
        const marketValue = mark?.marketValue ?? quantity * averageCost;
        return {
          symbol: row.symbol,
          quantity,
          averageCost,
          marketValue,
          unrealizedPnl: mark?.unrealizedPnl ?? 0,
          unrealizedPnlFraction: mark?.unrealizedPnlFraction ?? 0,
          currentPrice: mark?.currentPrice ?? null,
          stopPrice: row.stop_price === null ? null : num(row.stop_price),
          targetPrice: row.target_price === null ? null : num(row.target_price),
          engine: row.engine,
          strategy: row.strategy_key,
          openedAt: iso(row.opened_at),
          entryReasons: row.reasons ?? [],
        };
      }),
      openOrders: openOrders.rows.map((o) => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        quantity: num(o.quantity),
        filledQuantity: num(o.filled_quantity),
        status: o.status,
        brokerOrderId: o.broker_order_id,
        submittedAt: iso(o.submitted_at),
        engine: o.engine,
      })),
      activity: activity.rows.map((a) => ({
        id: String(a.id),
        occurredAt: a.occurred_at.toISOString(),
        engine: a.engine,
        level: a.level,
        kind: a.kind,
        symbol: a.symbol,
        message: a.message,
        orderId: a.order_id,
      })),
      journal: journal.rows.map((j) => ({
        orderId: j.order_id,
        symbol: j.symbol,
        engine: j.engine,
        strategy: j.strategy_key,
        intent: j.intent,
        side: j.side,
        quantity: num(j.quantity),
        filledQuantity: num(j.filled_quantity),
        status: j.status,
        fillPrice: j.fill_price === null ? null : num(j.fill_price),
        stopPrice: j.stop_price === null ? null : num(j.stop_price),
        targetPrice: j.target_price === null ? null : num(j.target_price),
        riskAmount: j.risk_amount === null ? null : num(j.risk_amount),
        reasons: j.reasons ?? [],
        exitReason: j.exit_reason,
        realizedPnl: j.realized_pnl === null ? null : num(j.realized_pnl),
        holdingSeconds: j.holding_seconds === null ? null : num(j.holding_seconds),
        decidedAt: (iso(j.decided_at) ?? iso(j.submitted_at)) as string,
      })),
      realizedToday: num(realized.rows[0]?.pnl ?? 0),
    };
  } finally {
    client.release();
  }
}

/**
 * Halts new orders. One direction only.
 *
 * Goes through the SECURITY DEFINER function rather than an UPDATE, because
 * `vesti_app` has no write access to `kill_switch_state` and should not: the
 * point is that the page can stop trading, not that the page can change
 * trading state. Resuming requires quoting the reason back and stays with the
 * execution role's CLI.
 */
export async function tripKillSwitchFromApp(
  accountId: string,
  reason: string,
  by: string,
): Promise<void> {
  await livePool().query(`SELECT vesti_trip_kill_switch($1, $2, $3)`, [accountId, reason, by]);
}
