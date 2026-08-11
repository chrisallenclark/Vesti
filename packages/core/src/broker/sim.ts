/**
 * Deterministic simulated broker.
 *
 * Every assumption in this file makes results *worse* than a naive simulation,
 * and that is the point. A backtest is an argument that a strategy works, and
 * the easiest way to win that argument dishonestly is to fill optimistically.
 * The four that matter most:
 *
 *   1. NO SAME-BAR SIGNAL AND FILL. An order submitted on session T is not
 *      eligible until session T+1. A strategy that decides from the close of a
 *      bar cannot also transact inside it. This single rule is the difference
 *      between most impressive backtests and most honest ones.
 *
 *   2. You pay the spread. Marketable orders cross at the touch, which costs
 *      half the quoted spread before any price movement at all.
 *
 *   3. Size moves the price. Impact follows the square-root law — roughly
 *      volatility times the square root of the fraction of volume you take —
 *      so a position that is large relative to the tape is penalised for it
 *      rather than filling at the same price a single share would.
 *
 *   4. You cannot have more of the volume than you take. Fills are capped at a
 *      participation limit per bar; the remainder stays working, and a `day`
 *      order that cannot complete expires unfilled. Strategies that only work
 *      at sizes the tape cannot absorb reveal themselves here instead of in
 *      production.
 *
 * Everything is deterministic: same orders, same bars, same fills, always.
 * Introducing randomness into fills would make a failing backtest impossible to
 * reproduce, and reproducibility is worth more than realism-by-jitter.
 */

import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerFill,
  BrokerOrderRequest,
  BrokerOrderState,
  BrokerPosition,
} from "./types.ts";
import { OrderRefusedError } from "./types.ts";

/** A session's price action, as the simulator needs it. */
export interface SimBar {
  symbol: string;
  sessionDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Quoted spread as a fraction of price. Defaults to the config value. */
  spreadFraction?: number;
  /** ATR as a fraction of price, driving the impact term. */
  atrFraction?: number;
}

export interface SimBrokerConfig {
  startingCash: number;
  /** Fraction of a bar's volume this account may take. 0.02 = 2%. */
  maxParticipation?: number;
  /** Used when a bar does not carry its own spread. 0.0005 = 5bp. */
  defaultSpreadFraction?: number;
  /** Used when a bar does not carry its own ATR. */
  defaultAtrFraction?: number;
  /**
   * Scales the square-root impact term. 1.0 means a trade taking 100% of a
   * session's volume moves the price by roughly one ATR.
   */
  impactCoefficient?: number;
  /** Per-share commission. Zero at Alpaca and IBKR-lite. */
  feePerShare?: number;
}

const DEFAULTS = {
  maxParticipation: 0.02,
  defaultSpreadFraction: 0.0005,
  defaultAtrFraction: 0.02,
  impactCoefficient: 1.0,
  feePerShare: 0,
};

interface WorkingOrder extends BrokerOrderState {
  fills: BrokerFill[];
}

export class SimBroker implements BrokerAdapter {
  readonly name = "sim";

  private readonly config: Required<SimBrokerConfig>;
  private readonly orders = new Map<string, WorkingOrder>();
  private readonly byClientId = new Map<string, string>();
  private readonly positions = new Map<string, BrokerPosition>();
  private readonly fills: BrokerFill[] = [];
  private readonly lastPrice = new Map<string, number>();

  private cash: number;
  private currentSession: string | null = null;
  private sequence = 0;
  private orderCounter = 0;

  constructor(config: SimBrokerConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.cash = config.startingCash;
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  /**
   * Advances to a session and matches every eligible working order against it.
   *
   * Call once per session, in order, with that session's bars. Returns the
   * fills that occurred, so a caller can post them to the ledger.
   */
  openSession(sessionDate: string, bars: readonly SimBar[]): BrokerFill[] {
    if (this.currentSession !== null && sessionDate <= this.currentSession) {
      throw new Error(
        `Sessions must advance: cannot open ${sessionDate} after ${this.currentSession}.`,
      );
    }
    this.currentSession = sessionDate;
    this.sequence = 0;

    const barsBySymbol = new Map(bars.map((bar) => [bar.symbol, bar]));
    for (const bar of bars) this.lastPrice.set(bar.symbol, bar.close);

    const produced: BrokerFill[] = [];

    // Deterministic order: by submission, then by client id. Without a total
    // order, two orders competing for the same limited volume would fill
    // differently depending on Map iteration, and the run would stop being
    // reproducible.
    const working = [...this.orders.values()]
      .filter((order) => order.status === "accepted" || order.status === "working" || order.status === "partially_filled")
      .sort((a, b) =>
        a.submittedSession === b.submittedSession
          ? a.clientOrderId.localeCompare(b.clientOrderId)
          : a.submittedSession.localeCompare(b.submittedSession),
      );

    for (const order of working) {
      // Rule 1: nothing fills on the session it was submitted.
      if (order.submittedSession >= sessionDate) continue;

      const bar = barsBySymbol.get(order.symbol);
      if (!bar) {
        // No bar means the instrument did not trade. A day order still expires;
        // leaving it working would let a halted name fill on stale intent.
        if (order.timeInForce === "day") this.expire(order);
        continue;
      }

      produced.push(...this.matchAgainstBar(order, bar));

      if (order.status !== "filled" && order.timeInForce === "day") this.expire(order);
      else if (order.status === "accepted") order.status = "working";
    }

    return produced;
  }

  /** The current session, or null before the first one is opened. */
  get session(): string | null {
    return this.currentSession;
  }

  allFills(): readonly BrokerFill[] {
    return this.fills;
  }

  // ── Matching ──────────────────────────────────────────────────────────────

  private matchAgainstBar(order: WorkingOrder, bar: SimBar): BrokerFill[] {
    const trigger = this.triggerPrice(order, bar);
    if (trigger === null) return [];

    const remaining = order.quantity - order.filledQuantity;
    const capacity = Math.floor(bar.volume * this.config.maxParticipation);
    const quantity = Math.min(remaining, capacity);
    if (quantity <= 0) return [];

    const price = this.executionPrice(order, bar, trigger, quantity);
    const fees = quantity * this.config.feePerShare;

    const fill: BrokerFill = {
      brokerOrderId: order.brokerOrderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      quantity,
      price,
      fees,
      sessionDate: bar.sessionDate,
      sequence: this.sequence++,
    };

    this.applyFill(order, fill);
    return [fill];
  }

  /**
   * The price at which the order becomes executable in this bar, or null if it
   * never does.
   *
   * The conservative choices are here. A resting limit requires the bar to
   * trade THROUGH it, not merely touch it: touching your price does not mean
   * the queue in front of you cleared. A gap in your favour is honoured,
   * because a market that opens past your limit genuinely fills you there.
   */
  private triggerPrice(order: WorkingOrder, bar: SimBar): number | null {
    switch (order.kind) {
      case "market":
        return bar.open;

      case "limit": {
        const limit = order.limitPrice as number;
        if (order.side === "buy") {
          if (bar.open <= limit) return bar.open; // gapped through in your favour
          return bar.low < limit ? limit : null;
        }
        if (bar.open >= limit) return bar.open;
        return bar.high > limit ? limit : null;
      }

      case "stop": {
        const stop = order.stopPrice as number;
        if (order.side === "buy") {
          if (bar.open >= stop) return bar.open; // gapped past the stop
          return bar.high >= stop ? stop : null;
        }
        if (bar.open <= stop) return bar.open;
        return bar.low <= stop ? stop : null;
      }

      case "stop_limit": {
        const stop = order.stopPrice as number;
        const limit = order.limitPrice as number;
        if (order.side === "buy") {
          if (bar.high < stop) return null; // never triggered
          const triggered = Math.max(stop, bar.open);
          // Triggered, but the limit caps what you will pay. If the market
          // never came back to your limit after triggering, you do not fill —
          // which is exactly how stop-limits fail people in fast markets, and
          // is worth reproducing rather than papering over.
          if (triggered <= limit) return triggered;
          return bar.low < limit ? limit : null;
        }
        if (bar.low > stop) return null;
        const triggered = Math.min(stop, bar.open);
        if (triggered >= limit) return triggered;
        return bar.high > limit ? limit : null;
      }
    }
  }

  /**
   * Trigger price plus the costs of actually being the one who traded.
   *
   * A resting limit does not pay the spread — it was the passive side — but a
   * marketable order crosses it. Impact applies either way: taking a
   * meaningful share of a session's volume moves the price regardless of order
   * type.
   */
  private executionPrice(
    order: WorkingOrder,
    bar: SimBar,
    trigger: number,
    quantity: number,
  ): number {
    const spread = bar.spreadFraction ?? this.config.defaultSpreadFraction;
    const atr = bar.atrFraction ?? this.config.defaultAtrFraction;
    const participation = bar.volume > 0 ? quantity / bar.volume : 1;

    const crossesTheSpread = order.kind === "market" || order.kind === "stop";
    const spreadCost = crossesTheSpread ? trigger * (spread / 2) : 0;
    // Square-root law: impact grows with the square root of participation, not
    // linearly. Linear over-penalises small orders and under-penalises large.
    const impact = trigger * atr * this.config.impactCoefficient * Math.sqrt(participation);

    const adverse = order.side === "buy" ? 1 : -1;
    const price = trigger + adverse * (spreadCost + impact);
    // Round to the cent, away from the trader's favour.
    const cents = order.side === "buy" ? Math.ceil(price * 100) : Math.floor(price * 100);
    return Math.max(0.01, cents / 100);
  }

  private applyFill(order: WorkingOrder, fill: BrokerFill): void {
    order.fills.push(fill);
    this.fills.push(fill);

    const filled = order.filledQuantity + fill.quantity;
    const notional = order.fills.reduce((sum, f) => sum + f.price * f.quantity, 0);
    order.filledQuantity = filled;
    order.averageFillPrice = notional / filled;
    order.status = filled >= order.quantity ? "filled" : "partially_filled";

    const signed = fill.side === "buy" ? fill.quantity : -fill.quantity;
    this.cash -= signed * fill.price;
    this.cash -= fill.fees;

    this.updatePosition(fill.symbol, signed, fill.price);
  }

  /**
   * Broker-side average cost, which is all a real broker reports.
   *
   * Deliberately NOT lot-level: this is the number our own specific-lot ledger
   * gets reconciled against, and modelling it accurately is what makes that
   * reconciliation a real check rather than a comparison of our data to itself.
   */
  private updatePosition(symbol: string, signedQuantity: number, price: number): void {
    const existing = this.positions.get(symbol);
    if (!existing) {
      this.positions.set(symbol, { symbol, quantity: signedQuantity, averageCost: price });
      return;
    }

    const combined = existing.quantity + signedQuantity;
    if (combined === 0) {
      this.positions.delete(symbol);
      return;
    }

    // Adding in the same direction re-averages; reducing leaves cost basis alone.
    const sameDirection = Math.sign(signedQuantity) === Math.sign(existing.quantity);
    existing.averageCost = sameDirection
      ? (existing.averageCost * existing.quantity + price * signedQuantity) / combined
      : existing.averageCost;
    existing.quantity = combined;
  }

  private expire(order: WorkingOrder): void {
    order.status = order.filledQuantity > 0 ? "filled" : "expired";
    if (order.filledQuantity > 0 && order.filledQuantity < order.quantity) {
      // A partially-filled day order ends the session done, not still working.
      order.quantity = order.filledQuantity;
    }
  }

  // ── BrokerAdapter ─────────────────────────────────────────────────────────

  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrderState> {
    if (this.currentSession === null) {
      throw new OrderRefusedError(
        "No session is open. Call openSession before submitting orders.",
        "no_session",
      );
    }
    if (this.byClientId.has(request.clientOrderId)) {
      // Idempotency: a retried submission returns the original order rather
      // than doubling the position.
      return this.snapshot(this.orders.get(this.byClientId.get(request.clientOrderId)!)!);
    }
    for (const problem of validateRequest(request)) {
      throw new OrderRefusedError(problem, "malformed_order");
    }

    const brokerOrderId = `sim-${(++this.orderCounter).toString().padStart(6, "0")}`;
    const order: WorkingOrder = {
      brokerOrderId,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      kind: request.kind,
      quantity: request.quantity,
      filledQuantity: 0,
      averageFillPrice: null,
      limitPrice: request.limitPrice ?? null,
      stopPrice: request.stopPrice ?? null,
      timeInForce: request.timeInForce,
      status: "accepted",
      submittedSession: this.currentSession,
      fills: [],
    };

    this.orders.set(brokerOrderId, order);
    this.byClientId.set(request.clientOrderId, brokerOrderId);
    return this.snapshot(order);
  }

  async cancelOrder(brokerOrderId: string): Promise<BrokerOrderState> {
    const order = this.orders.get(brokerOrderId);
    if (!order) throw new Error(`No such order ${brokerOrderId}.`);
    if (order.status === "filled" || order.status === "cancelled" || order.status === "expired") {
      return this.snapshot(order);
    }
    order.status = "cancelled";
    return this.snapshot(order);
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderState | null> {
    const order = this.orders.get(brokerOrderId);
    return order ? this.snapshot(order) : null;
  }

  async listOpenOrders(): Promise<BrokerOrderState[]> {
    return [...this.orders.values()]
      .filter((o) => o.status === "accepted" || o.status === "working" || o.status === "partially_filled")
      .map((o) => this.snapshot(o));
  }

  async listPositions(): Promise<BrokerPosition[]> {
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  async getAccount(): Promise<BrokerAccount> {
    let marketValue = 0;
    let committed = 0;
    for (const position of this.positions.values()) {
      marketValue += position.quantity * (this.lastPrice.get(position.symbol) ?? position.averageCost);
    }
    for (const order of this.orders.values()) {
      if (order.side !== "buy") continue;
      if (order.status !== "accepted" && order.status !== "working" && order.status !== "partially_filled") continue;
      const remaining = order.quantity - order.filledQuantity;
      const reference =
        order.limitPrice ?? order.stopPrice ?? this.lastPrice.get(order.symbol) ?? 0;
      committed += remaining * reference;
    }
    return {
      cash: round2(this.cash),
      buyingPower: round2(this.cash - committed),
      equity: round2(this.cash + marketValue),
    };
  }

  private snapshot(order: WorkingOrder): BrokerOrderState {
    const { fills: _fills, ...state } = order;
    return { ...state };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function validateRequest(request: BrokerOrderRequest): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    problems.push(`Quantity must be a positive whole number, got ${request.quantity}.`);
  }
  if ((request.kind === "limit" || request.kind === "stop_limit") && !(request.limitPrice! > 0)) {
    problems.push(`A ${request.kind} order needs a positive limit price.`);
  }
  if ((request.kind === "stop" || request.kind === "stop_limit") && !(request.stopPrice! > 0)) {
    problems.push(`A ${request.kind} order needs a positive stop price.`);
  }
  return problems;
}

/** Convenience for tests and callers that have a bar but not a `SimBar`. */
export function toSimBar(
  bar: { symbol: string; sessionDate: string; open: number; high: number; low: number; close: number; volume: number },
  extras: { spreadFraction?: number; atrFraction?: number } = {},
): SimBar {
  return {
    symbol: bar.symbol,
    sessionDate: bar.sessionDate,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    ...(extras.spreadFraction !== undefined ? { spreadFraction: extras.spreadFraction } : {}),
    ...(extras.atrFraction !== undefined ? { atrFraction: extras.atrFraction } : {}),
  };
}
