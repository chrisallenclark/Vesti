/**
 * Making the autonomous loop watchable.
 *
 * A trading process that runs unattended has one failure mode worse than
 * crashing, which is continuing to look fine. A crash is obvious. A worker
 * whose market-data feed died forty minutes ago is still running, still
 * logging, still reporting healthy, and is simply not trading — and the only
 * thing that distinguishes it from a quiet market is whether anybody wrote down
 * when data last arrived.
 *
 * So two writes, with different shapes for different questions:
 *
 *   THE HEARTBEAT is current state, upserted every cycle. Per component, with
 *   the instant each was last known good, because "ERROR" on its own tells an
 *   operator nothing about whether to restart the process or go and look at the
 *   venue. It is not a log and does not accumulate: a dashboard polling for
 *   liveness must not get slower as the session it is watching gets longer.
 *
 *   THE ACTIVITY LOG is history, append-only. Mostly REFUSALS, which is the
 *   point — the entries nobody thinks to record are the ones that answer "why
 *   didn't it buy that?", and they stop being recoverable the moment the market
 *   moves.
 *
 * Both are best-effort. A failure to write an observation must never stop the
 * loop: the worker's job is to trade correctly and to report what it did, in
 * that order, and a dashboard that has gone dark is a worse reason to stop
 * trading than almost anything.
 */

import type pg from "pg";

export type WorkerStatus = "starting" | "running" | "idle" | "halted" | "error" | "stopped";
export type ActivityLevel = "debug" | "info" | "signal" | "warn" | "error";

export interface HealthFlags {
  alpacaOk?: boolean;
  marketDataOk?: boolean;
  databaseOk?: boolean;
  marketOpen?: boolean;
  strategyActive?: boolean;
  killSwitch?: boolean;
}

export interface Activity {
  level?: ActivityLevel;
  /** Stable machine key. The dashboard groups on this; `message` is for people. */
  kind: string;
  message: string;
  symbol?: string | undefined;
  orderId?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface ObserverOptions {
  pool: pg.Pool;
  accountId: string;
  engine: string;
  tradingMode: "paper" | "live";
  /** Distinct per process start, so a restart is visible rather than inferred. */
  workerId: string;
  /** Mirrors every activity to stdout. The worker passes its own logger. */
  echo?: (line: string) => void;
}

export class Observer {
  #cycles = 0;
  #lastDataAt: Date | null = null;
  #lastEvalAt: Date | null = null;
  #lastOrderAt: Date | null = null;
  #lastError: { message: string; at: Date } | null = null;

  /**
   * The last CAUSE each symbol was passed over for.
   *
   * Held in memory purely to suppress repetition. Seventeen symbols evaluated
   * every thirty seconds for six and a half hours is thirteen thousand rows
   * saying the same thing, and a feed at that density is not observability, it
   * is noise a human stops reading by 10am. Only a CHANGE of reason is written,
   * which turns the feed into a record of when the market's story about each
   * name changed — which is the thing worth watching.
   */
  readonly #lastPassReason = new Map<string, string>();

  constructor(private readonly options: ObserverOptions) {}

  get workerId(): string {
    return this.options.workerId;
  }

  markData(at: Date = new Date()): void {
    this.#lastDataAt = at;
  }

  markEvaluation(at: Date = new Date()): void {
    this.#lastEvalAt = at;
  }

  markOrder(at: Date = new Date()): void {
    this.#lastOrderAt = at;
  }

  markError(error: unknown, at: Date = new Date()): void {
    this.#lastError = { message: describe(error), at };
  }

  /** Writes one activity row. Never throws. */
  async say(activity: Activity): Promise<void> {
    const line =
      `${activity.symbol ? `${activity.symbol} ` : ""}${activity.message}`.trim();
    this.options.echo?.(`[${activity.kind}] ${line}`);

    try {
      await this.options.pool.query(
        `INSERT INTO activity_log
           (account_id, engine, level, kind, symbol, message, order_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          this.options.accountId,
          this.options.engine,
          activity.level ?? "info",
          activity.kind,
          activity.symbol ?? null,
          activity.message,
          activity.orderId ?? null,
          JSON.stringify(activity.detail ?? {}),
        ],
      );
    } catch (error) {
      // Deliberately swallowed, and deliberately not silent: losing the feed is
      // survivable, losing it without knowing is not.
      this.options.echo?.(`  ! activity write failed: ${describe(error)}`);
    }
  }

  /**
   * Records a symbol being passed over, once per change of CAUSE.
   *
   * Keyed on `code` rather than on the message, because the message carries live
   * prices and ratios that change on every bar: "0.91x average volume" and
   * "0.93x average volume" are the same fact told twice, and de-duplicating on
   * the text would write a row per symbol per minute — six thousand a session,
   * which is not observability. Keyed on the cause, the feed becomes a record of
   * when the market's story about a name changed, and the row that is written
   * still carries the live numbers.
   *
   * Returns whether anything was written, so a caller can count how much of a
   * scan was genuinely new.
   */
  async pass(symbol: string, code: string, reason: string): Promise<boolean> {
    if (this.#lastPassReason.get(symbol) === code) return false;
    this.#lastPassReason.set(symbol, code);
    await this.say({
      level: "debug",
      kind: "scan",
      symbol,
      message: `no trade — ${reason}`,
      detail: { code },
    });
    return true;
  }

  /** Forgets a symbol's last pass reason, so the next one is written again. */
  resetPass(symbol: string): void {
    this.#lastPassReason.delete(symbol);
  }

  /** Upserts the heartbeat. Never throws. */
  async beat(status: WorkerStatus, health: HealthFlags = {}): Promise<void> {
    this.#cycles += 1;
    try {
      await this.options.pool.query(
        `INSERT INTO worker_state
           (account_id, engine, status, trading_mode, worker_id,
            alpaca_ok, market_data_ok, database_ok, market_open, strategy_active, kill_switch,
            last_beat_at, last_data_at, last_eval_at, last_order_at,
            last_error, last_error_at, cycles)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 now(), $12, $13, $14, $15, $16, $17)
         ON CONFLICT (account_id, engine) DO UPDATE SET
           status          = EXCLUDED.status,
           trading_mode    = EXCLUDED.trading_mode,
           worker_id       = EXCLUDED.worker_id,
           alpaca_ok       = EXCLUDED.alpaca_ok,
           market_data_ok  = EXCLUDED.market_data_ok,
           database_ok     = EXCLUDED.database_ok,
           market_open     = EXCLUDED.market_open,
           strategy_active = EXCLUDED.strategy_active,
           kill_switch     = EXCLUDED.kill_switch,
           last_beat_at    = EXCLUDED.last_beat_at,
           -- COALESCE keeps the last known-good instant when this cycle had
           -- none. Overwriting with NULL would erase the only evidence that
           -- data was ever flowing, which is exactly what a stalled feed needs
           -- somebody to be able to see.
           last_data_at    = COALESCE(EXCLUDED.last_data_at,  worker_state.last_data_at),
           last_eval_at    = COALESCE(EXCLUDED.last_eval_at,  worker_state.last_eval_at),
           last_order_at   = COALESCE(EXCLUDED.last_order_at, worker_state.last_order_at),
           last_error      = COALESCE(EXCLUDED.last_error,    worker_state.last_error),
           last_error_at   = COALESCE(EXCLUDED.last_error_at, worker_state.last_error_at),
           cycles          = EXCLUDED.cycles,
           -- Restarting resets the clock; a heartbeat from the same incarnation
           -- does not.
           started_at      = CASE WHEN worker_state.worker_id = EXCLUDED.worker_id
                                  THEN worker_state.started_at ELSE now() END`,
        [
          this.options.accountId,
          this.options.engine,
          status,
          this.options.tradingMode,
          this.options.workerId,
          health.alpacaOk ?? false,
          health.marketDataOk ?? false,
          health.databaseOk ?? true,
          health.marketOpen ?? false,
          health.strategyActive ?? false,
          health.killSwitch ?? false,
          this.#lastDataAt,
          this.#lastEvalAt,
          this.#lastOrderAt,
          this.#lastError?.message ?? null,
          this.#lastError?.at ?? null,
          this.#cycles,
        ],
      );
    } catch (error) {
      this.options.echo?.(`  ! heartbeat failed: ${describe(error)}`);
    }
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
