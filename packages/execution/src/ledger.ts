/**
 * The order lifecycle, written to the database.
 *
 * Until now the simulator kept its own state and mandate isolation was a schema
 * property: the tables and triggers would have rejected a violation, but nothing
 * wrote to them, so nothing had ever been rejected. This is the code that makes
 * the guarantee executable — intent, ruling, submission, fill, and terminal
 * state all land in `orders`, `fills`, `lots`, `cash_ledger` and
 * `order_lot_allocations`, under the specific-lot rules.
 *
 * Four properties the implementation is built around:
 *
 *   ONE TRANSACTION PER FILL. A fill opens or consumes lots AND moves cash AND
 *   advances the order. A crash between those leaves a position with no cash
 *   entry behind it, which is not a discrepancy anyone finds quickly. Each
 *   method here is a single transaction and either all of it happened or none
 *   of it did.
 *
 *   FILLS ARE IDEMPOTENT. Brokers replay. The unique index from migration 009
 *   turns a redelivered fill into a collision, and the collision aborts the
 *   posting before it touches anything. Reapplying a fill would manufacture a
 *   position that never existed.
 *
 *   EXITS NAME THEIR LOTS, AND ONLY THEIR MANDATE'S. Selection is scoped to the
 *   order's mandate; a shortfall is an error rather than a reach into other
 *   capital. The database trigger checks it again on the way in.
 *
 *   CASH IS A LEDGER, NOT A BALANCE. Every fill writes signed entries and the
 *   balance is a fold over them, so cash is always explicable and drift shows up
 *   as an entry someone can point at rather than a number that is simply wrong.
 *
 * Connects as `vesti_execution`, the only role with a write path to any of
 * this.
 */

import pg from "pg";
import {
  allocateAcrossLots,
  selectOpenLots,
  type LotAllocation,
  type LotMethod,
} from "./lots.ts";

export type Side = "buy" | "sell";
export type OrderKind = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "day" | "gtc" | "ioc" | "fok" | "opg" | "cls";
export type RiskDecision = "approve" | "reduce" | "reject";

export type OrderStatus =
  | "pending_risk"
  | "rejected_risk"
  | "pending_new"
  | "working"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "expired"
  | "rejected_broker";

export interface OrderIntent {
  accountId: string;
  mandateId: string;
  securityId: string;
  side: Side;
  kind: OrderKind;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  strategyVersionId?: string;
}

export interface RiskRuling {
  decision: RiskDecision;
  requestedQuantity: number;
  approvedQuantity: number;
  violations?: unknown[];
  inputs?: Record<string, unknown>;
  engineVersion: string;
  policyId?: string;
}

export interface RiskRulingResult {
  riskEvaluationId: string;
  status: OrderStatus;
  /** What the order is now for, after a REDUCE shrank it. */
  quantity: number;
}

export interface IncomingFill {
  /** The deduplication key. Required — a fill with no identity cannot be replayed safely. */
  brokerFillId: string;
  quantity: number;
  price: number;
  fees?: number;
  filledAt: Date;
  /**
   * The venue's own execution id, when the source has one.
   *
   * Recorded in the audit trail but deliberately NOT the deduplication key: the
   * poller has no access to it, so keying on it would let the stream and the
   * poller post the same shares twice. See `postCumulativeFill`.
   */
  executionId?: string;
}

/** The plan for the lot a buy opens, captured at entry rather than derived later. */
export interface LotPlan {
  stopPrice?: number;
  targetPrice?: number;
  thesisVersionId?: string;
}

export interface PostFillOptions {
  /** Which lots an exit consumes. Ignored on a buy. Defaults to FIFO. */
  method?: LotMethod;
  /** The plan attached to the lot a buy opens. Ignored on a sell. */
  lotPlan?: LotPlan;
}

export interface PostedFill {
  /** False when the broker redelivered a fill already posted. */
  applied: boolean;
  fillId: string | null;
  orderStatus: OrderStatus;
  filledQuantity: number;
  /** The lot a buy opened. Null on a sell. */
  lotOpened: string | null;
  /** The lots a sell closed against. Empty on a buy. */
  allocations: LotAllocation[];
  /** Signed: negative when a buy consumed cash. Includes fees. */
  cashDelta: number;
  /** Zero on a buy — nothing is realised until something is closed. */
  realizedPnl: number;
}

export class OrderLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OrderLifecycleError";
  }
}

export class OrderLedger {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Records an intent, before any ruling exists.
   *
   * Lands in `pending_risk`, which is the only status the risk gate lets
   * through without an evaluation. Writing the intent first means a rejected
   * trade leaves a record of having been considered — "why did we not take
   * that?" is answerable, and a strategy cannot be quietly judged only on the
   * trades that passed.
   */
  async recordIntent(intent: OrderIntent): Promise<string> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO orders
           (account_id, mandate_id, security_id, side, kind, quantity,
            limit_price, stop_price, tif, status, strategy_version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_risk', $10)
         RETURNING id`,
        [
          intent.accountId,
          intent.mandateId,
          intent.securityId,
          intent.side,
          intent.kind,
          intent.quantity,
          intent.limitPrice ?? null,
          intent.stopPrice ?? null,
          intent.timeInForce ?? "day",
          intent.strategyVersionId ?? null,
        ],
      );
      const orderId = rows[0]!.id;
      await audit(client, "order.intent", "order", orderId, {
        side: intent.side,
        quantity: intent.quantity,
        mandate_id: intent.mandateId,
      });
      return orderId;
    });
  }

  /**
   * Attaches the risk engine's ruling and moves the order out of `pending_risk`.
   *
   * A REDUCE shrinks the order to what was approved rather than leaving the
   * original quantity in place and hoping something downstream honours the
   * ruling — the gate would reject that anyway, and the gate rejecting it is a
   * worse way to find out than not doing it.
   *
   * A REJECT is recorded, not discarded. The evaluation stays attached to the
   * dead order so the reasoning survives.
   */
  async recordRiskRuling(orderId: string, ruling: RiskRuling): Promise<RiskRulingResult> {
    return this.transaction(async (client) => {
      const order = await lockOrder(client, orderId);
      if (order.status !== "pending_risk") {
        throw new OrderLifecycleError(
          `Order ${orderId} is ${order.status}; a ruling may only be attached in pending_risk.`,
          "not_pending_risk",
        );
      }
      if (ruling.approvedQuantity > ruling.requestedQuantity) {
        throw new OrderLifecycleError(
          `Risk engine approved ${ruling.approvedQuantity} against a request of ` +
            `${ruling.requestedQuantity}. Sizing steps may only reduce.`,
          "approval_exceeds_request",
        );
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO risk_evaluations
           (account_id, mandate_id, security_id, side, requested_qty, approved_qty,
            decision, violations, inputs, policy_id, engine_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
         RETURNING id`,
        [
          order.accountId,
          order.mandateId,
          order.securityId,
          order.side,
          ruling.requestedQuantity,
          ruling.approvedQuantity,
          ruling.decision,
          JSON.stringify(ruling.violations ?? []),
          JSON.stringify(ruling.inputs ?? {}),
          ruling.policyId ?? null,
          ruling.engineVersion,
        ],
      );
      const riskEvaluationId = rows[0]!.id;

      if (ruling.decision === "reject") {
        await client.query(
          `UPDATE orders SET status = 'rejected_risk', risk_evaluation_id = $2 WHERE id = $1`,
          [orderId, riskEvaluationId],
        );
        await audit(client, "order.risk_rejected", "order", orderId, {
          risk_evaluation_id: riskEvaluationId,
        });
        return { riskEvaluationId, status: "rejected_risk" as const, quantity: order.quantity };
      }

      await client.query(
        `UPDATE orders SET status = 'pending_new', risk_evaluation_id = $2, quantity = $3
          WHERE id = $1`,
        [orderId, riskEvaluationId, ruling.approvedQuantity],
      );
      await audit(client, "order.risk_approved", "order", orderId, {
        risk_evaluation_id: riskEvaluationId,
        decision: ruling.decision,
        approved_quantity: ruling.approvedQuantity,
      });
      return {
        riskEvaluationId,
        status: "pending_new" as const,
        quantity: ruling.approvedQuantity,
      };
    });
  }

  /** Records that the broker acknowledged the order and gave it an id. */
  async recordSubmission(
    orderId: string,
    brokerOrderId: string,
    status: OrderStatus = "working",
  ): Promise<void> {
    await this.transaction(async (client) => {
      const order = await lockOrder(client, orderId);
      if (order.status !== "pending_new") {
        throw new OrderLifecycleError(
          `Order ${orderId} is ${order.status}; only a pending_new order may be submitted.`,
          "not_submittable",
        );
      }
      await client.query(
        `UPDATE orders SET broker_order_id = $2, submitted_at = now(), status = $3 WHERE id = $1`,
        [orderId, brokerOrderId, status],
      );
      await audit(client, "order.submitted", "order", orderId, { broker_order_id: brokerOrderId });
    });
  }

  /**
   * Posts a fill: the whole of its effect, in one transaction.
   *
   * A buy opens a new tax lot — one per fill, not one per order. Two fills at
   * different prices are two lots with two cost bases, and merging them would
   * throw away the distinction that specific-lot accounting exists to keep.
   *
   * A sell consumes lots belonging to the order's mandate, in the configured
   * order, and writes what it consumed to `order_lot_allocations`.
   */
  async postFill(
    orderId: string,
    fill: IncomingFill,
    options: PostFillOptions = {},
  ): Promise<PostedFill> {
    return this.transaction(async (client) => {
      const order = await lockOrder(client, orderId);
      return applyFill(client, order, fill, options);
    });
  }

  /**
   * Posts from a broker's CUMULATIVE view of an order rather than a discrete
   * execution, and works out the increment itself.
   *
   * This is what both real fill sources use, and using one path for both is a
   * correctness requirement rather than tidiness. A `trade_updates` event and a
   * poll of the same order describe the same economic fill; if each posted
   * under its own identifier — the venue's execution id and a synthesized one —
   * they would not collide, and a 40-share partial reported by both would enter
   * the ledger as 80 shares. The overfill check does not save you, because 80
   * is still under a 100-share order.
   *
   * Two properties make this safe. The delta is computed against
   * `filled_quantity` while the order row is LOCKED, so a concurrent post from
   * the other source is serialised behind it and simply sees nothing left to
   * do. And the identifier is the cumulative quantity itself, which is strictly
   * increasing within an order and therefore names the increment uniquely
   * whoever reports it.
   *
   * It also heals gaps. If a fill was missed entirely — the process was down,
   * the socket was gone — the next cumulative report shows a delta covering
   * every share since, priced at the blended average of exactly those shares.
   * That is the correct number, not an approximation of it.
   */
  async postCumulativeFill(
    orderId: string,
    snapshot: {
      cumulativeQuantity: number;
      cumulativeAveragePrice: number;
      filledAt: Date;
      fees?: number;
      /** The venue's own execution id, when there is one. Recorded, not keyed on. */
      executionId?: string;
    },
    options: PostFillOptions = {},
  ): Promise<PostedFill> {
    return this.transaction(async (client) => {
      const order = await lockOrder(client, orderId);
      const delta = snapshot.cumulativeQuantity - order.filledQuantity;
      if (delta <= 1e-9) {
        return notApplied(order);
      }

      const { rows } = await client.query<{ notional: string | null }>(
        `SELECT sum(quantity * price) AS notional FROM fills WHERE order_id = $1`,
        [orderId],
      );
      const priorNotional = Number(rows[0]?.notional ?? 0);
      const price =
        (snapshot.cumulativeQuantity * snapshot.cumulativeAveragePrice - priorNotional) / delta;

      return applyFill(
        client,
        order,
        {
          brokerFillId: `cum:${snapshot.cumulativeQuantity}`,
          quantity: delta,
          price,
          fees: snapshot.fees ?? 0,
          filledAt: snapshot.filledAt,
          ...(snapshot.executionId ? { executionId: snapshot.executionId } : {}),
        },
        options,
      );
    });
  }

  /**
   * Closes an order that will not fill further.
   *
   * A partially-filled order that is cancelled stays `partially_filled`: the
   * shares that traded did trade, and relabelling it `canceled` would lose that.
   */
  async recordTerminal(
    orderId: string,
    status: "canceled" | "expired" | "rejected_broker",
    reason?: string,
  ): Promise<OrderStatus> {
    return this.transaction(async (client) => {
      const order = await lockOrder(client, orderId);
      if (order.status === "filled") return "filled";

      const resolved: OrderStatus = order.filledQuantity > 0 ? "partially_filled" : status;
      await client.query(`UPDATE orders SET status = $2 WHERE id = $1`, [orderId, resolved]);
      await audit(client, `order.${status}`, "order", orderId, {
        reason: reason ?? null,
        filled_quantity: order.filledQuantity,
      });
      return resolved;
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Open quantity and average cost for one mandate's holding of one security. */
  async positionForMandate(
    accountId: string,
    mandateId: string,
    securityId: string,
  ): Promise<{ quantity: number; averageCost: number }> {
    const { rows } = await this.pool.query<{ quantity: string | null; cost: string | null }>(
      `SELECT sum(remaining) AS quantity, sum(remaining * cost_basis) AS cost
         FROM lots
        WHERE account_id = $1 AND mandate_id = $2 AND security_id = $3 AND remaining > 0`,
      [accountId, mandateId, securityId],
    );
    const quantity = Number(rows[0]?.quantity ?? 0);
    const cost = Number(rows[0]?.cost ?? 0);
    return { quantity, averageCost: quantity > 0 ? cost / quantity : 0 };
  }

  /** Cash as a fold over the ledger. Never stored, so it cannot drift from its entries. */
  async cashBalance(accountId: string, mandateId?: string): Promise<number> {
    const { rows } = await this.pool.query<{ balance: string | null }>(
      `SELECT sum(amount) AS balance FROM cash_ledger
        WHERE account_id = $1 AND ($2::uuid IS NULL OR mandate_id = $2::uuid)`,
      [accountId, mandateId ?? null],
    );
    return Number(rows[0]?.balance ?? 0);
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

const TRADEABLE_STATUSES = new Set<OrderStatus>([
  "pending_new",
  "working",
  "partially_filled",
]);

interface LockedOrder {
  id: string;
  accountId: string;
  mandateId: string;
  securityId: string;
  side: Side;
  quantity: number;
  filledQuantity: number;
  status: OrderStatus;
  strategyVersionId: string | null;
}

/** The shape returned when a fill was already posted and nothing changed. */
function notApplied(order: LockedOrder): PostedFill {
  return {
    applied: false,
    fillId: null,
    orderStatus: order.status,
    filledQuantity: order.filledQuantity,
    lotOpened: null,
    allocations: [],
    cashDelta: 0,
    realizedPnl: 0,
  };
}

/**
 * Everything a fill does, with the order already locked by the caller.
 *
 * Shared by the discrete and cumulative entry points so there is exactly one
 * implementation of what a fill means. Two would drift, and the half that
 * drifted would be the one a live broker uses.
 */
async function applyFill(
  client: pg.PoolClient,
  order: LockedOrder,
  fill: IncomingFill,
  options: PostFillOptions,
): Promise<PostedFill> {
    const fees = fill.fees ?? 0;

    if (fill.quantity <= 0) {
      throw new OrderLifecycleError("A fill must have positive quantity.", "non_positive_fill");
    }

    // Deduplication comes BEFORE the state and overfill checks, and the
    // ordering is the whole point rather than an optimisation.
    //
    // The commonest replay is the final fill of an order: the broker sends
    // it, we post it, the order goes to `filled`, and then the same fill
    // arrives again down a reconnecting socket. Checking state first would
    // reject that as "this order is filled and cannot take a fill", and
    // checking quantity first would reject it as an overfill — both of them
    // errors, for an event that is not one and needs no action. Only after
    // establishing that the fill is genuinely new is it meaningful to ask
    // whether the order can accept it.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO fills (order_id, filled_at, quantity, price, fees, broker_fill_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (order_id, broker_fill_id) WHERE broker_fill_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [order.id, fill.filledAt, fill.quantity, fill.price, fees, fill.brokerFillId],
    );
    if (inserted.rowCount === 0) return notApplied(order);
    const fillId = inserted.rows[0]!.id;

    if (!TRADEABLE_STATUSES.has(order.status)) {
      throw new OrderLifecycleError(
        `Order ${order.id} is ${order.status} and cannot take a fill.`,
        "order_not_fillable",
      );
    }
    if (order.filledQuantity + fill.quantity > order.quantity + 1e-9) {
      throw new OrderLifecycleError(
        `Fill of ${fill.quantity} would take order ${order.id} to ` +
          `${order.filledQuantity + fill.quantity} against a quantity of ${order.quantity}.`,
        "overfill",
      );
    }

    const gross = fill.price * fill.quantity;
    let lotOpened: string | null = null;
    let allocations: LotAllocation[] = [];
    let realizedPnl = 0;

    if (order.side === "buy") {
      lotOpened = await openLot(client, order, fill, fees, options.lotPlan);
    } else {
      allocations = await closeLots(client, order, fill, fees, options.method ?? "fifo");
      realizedPnl = allocations.reduce((sum, a) => sum + a.realizedPnl, 0);
    }

    // Signed so the balance is a plain sum. Fees are their own entry rather
    // than folded into the trade amount: "what has trading cost me" should be
    // one query, not an inference from the difference between two numbers.
    const cashDelta = (order.side === "buy" ? -gross : gross) - fees;
    await client.query(
      `INSERT INTO cash_ledger (account_id, mandate_id, occurred_at, kind, amount, reference)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        order.accountId,
        order.mandateId,
        fill.filledAt,
        order.side,
        order.side === "buy" ? -gross : gross,
        `fill:${fillId}`,
      ],
    );
    if (fees !== 0) {
      await client.query(
        `INSERT INTO cash_ledger (account_id, mandate_id, occurred_at, kind, amount, reference)
         VALUES ($1, $2, $3, 'fee', $4, $5)`,
        [order.accountId, order.mandateId, fill.filledAt, -fees, `fill:${fillId}`],
      );
    }

    const filledQuantity = order.filledQuantity + fill.quantity;
    const status: OrderStatus =
      filledQuantity + 1e-9 >= order.quantity ? "filled" : "partially_filled";
    await client.query(
      `UPDATE orders SET filled_quantity = $2, status = $3 WHERE id = $1`,
      [order.id, filledQuantity, status],
    );

    await audit(client, "order.filled", "order", order.id, {
      fill_id: fillId,
      broker_fill_id: fill.brokerFillId,
      execution_id: fill.executionId ?? null,
      quantity: fill.quantity,
      price: fill.price,
      mandate_id: order.mandateId,
      lot_opened: lotOpened,
      lots_closed: allocations.map((a) => a.lotId),
      realized_pnl: realizedPnl,
    });

    return {
      applied: true,
      fillId,
      orderStatus: status,
      filledQuantity,
      lotOpened,
      allocations,
      cashDelta,
      realizedPnl,
    };
}

/**
 * Reads the order and holds it for the rest of the transaction.
 *
 * Without the lock, two fills arriving concurrently on the same order both read
 * the same `filled_quantity`, both decide they are the partial one, and the
 * second write silently discards the first.
 */
async function lockOrder(client: pg.PoolClient, orderId: string): Promise<LockedOrder> {
  const { rows } = await client.query<{
    id: string;
    account_id: string;
    mandate_id: string;
    security_id: string;
    side: Side;
    quantity: string;
    filled_quantity: string;
    status: OrderStatus;
    strategy_version_id: string | null;
  }>(
    `SELECT id, account_id, mandate_id, security_id, side, quantity, filled_quantity,
            status, strategy_version_id
       FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const row = rows[0];
  if (!row) throw new OrderLifecycleError(`No order ${orderId}.`, "unknown_order");
  return {
    id: row.id,
    accountId: row.account_id,
    mandateId: row.mandate_id,
    securityId: row.security_id,
    side: row.side,
    quantity: Number(row.quantity),
    filledQuantity: Number(row.filled_quantity),
    status: row.status,
    strategyVersionId: row.strategy_version_id,
  };
}

/**
 * Opens the lot a buy fill created.
 *
 * Cost basis is per share and includes fees, because that is what the position
 * actually cost and what a realised gain has to be measured against. Keeping
 * fees out of it would report a profit on a trade that lost money after costs.
 */
async function openLot(
  client: pg.PoolClient,
  order: LockedOrder,
  fill: IncomingFill,
  fees: number,
  plan: LotPlan | undefined,
): Promise<string> {
  const costBasis = (fill.price * fill.quantity + fees) / fill.quantity;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO lots
       (account_id, mandate_id, security_id, opened_at, quantity, remaining, cost_basis,
        strategy_version_id, stop_price, target_price, thesis_version_id)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      order.accountId,
      order.mandateId,
      order.securityId,
      fill.filledAt,
      fill.quantity,
      costBasis,
      order.strategyVersionId,
      plan?.stopPrice ?? null,
      plan?.targetPrice ?? null,
      plan?.thesisVersionId ?? null,
    ],
  );
  return rows[0]!.id;
}

/**
 * Consumes lots for a sell fill and records which ones.
 *
 * Allocations accumulate per (order, lot) rather than per fill, matching the
 * table's own key: an order that fills in three parts against the same lot
 * leaves one allocation row carrying the total it closed.
 */
async function closeLots(
  client: pg.PoolClient,
  order: LockedOrder,
  fill: IncomingFill,
  fees: number,
  method: LotMethod,
): Promise<LotAllocation[]> {
  const lots = await selectOpenLots(client, {
    accountId: order.accountId,
    mandateId: order.mandateId,
    securityId: order.securityId,
    method,
  });

  const allocations = allocateAcrossLots(lots, fill.quantity, fill.price, fees, {
    mandateId: order.mandateId,
    securityId: order.securityId,
  });

  for (const allocation of allocations) {
    await client.query(
      `INSERT INTO order_lot_allocations (order_id, lot_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (order_id, lot_id) DO UPDATE
         SET quantity = order_lot_allocations.quantity + EXCLUDED.quantity`,
      [order.id, allocation.lotId, allocation.quantity],
    );
    // closed_at and remaining move together: the check constraint requires a
    // closing timestamp exactly when a lot empties, so a lot cannot be left at
    // zero and nominally open.
    await client.query(
      // $3 is cast explicitly: the ELSE NULL branch gives the planner no type to
      // infer from, and it settles on text.
      `UPDATE lots
          SET remaining = remaining - $2,
              closed_at = CASE WHEN remaining - $2 = 0 THEN $3::timestamptz ELSE NULL END
        WHERE id = $1`,
      [allocation.lotId, allocation.quantity, fill.filledAt],
    );
  }

  return allocations;
}

async function audit(
  client: pg.PoolClient,
  action: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, payload)
     VALUES ('service:execution', $1, $2, $3, $4::jsonb)`,
    [action, entityType, entityId, JSON.stringify(payload)],
  );
}
