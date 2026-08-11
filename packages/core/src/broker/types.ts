/**
 * Broker abstraction.
 *
 * One interface, three implementations over the life of the project: a
 * deterministic simulator, Alpaca paper, Alpaca live. Nothing above this line
 * knows which one it is talking to, which is the only way the paper-to-live
 * transition can be a configuration change rather than a rewrite of the code
 * path that moves money.
 *
 * The interface is async even though the simulator is synchronous, because a
 * real broker is a network call and pretending otherwise would force the
 * signature to change at exactly the wrong moment.
 *
 * Note what a broker deliberately does NOT know: mandates. A real broker holds
 * one omnibus position per symbol and reports one average cost. Mandate
 * isolation and specific-lot accounting are ours to maintain, and reconciling
 * our lots against the broker's single number is a scheduled job, not an
 * assumption.
 */

// Re-exported rather than redeclared: a broker's idea of a side and the risk
// engine's must be the same type, or the two can drift apart silently.
export type { Side } from "../risk/types.ts";
import type { Side } from "../risk/types.ts";

export type OrderKind = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "day" | "gtc";

export type BrokerOrderStatus =
  | "accepted"
  | "working"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "expired"
  | "rejected";

export interface BrokerOrderRequest {
  /** Our id, echoed back, so a lost response cannot become a duplicate order. */
  clientOrderId: string;
  symbol: string;
  side: Side;
  kind: OrderKind;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: TimeInForce;
  /**
   * The `risk_evaluations` row authorising this order. Not optional, and not
   * advisory: the guard below refuses any order that cannot present one, which
   * is what makes "the AI cannot overrule the risk engine" structural rather
   * than a matter of every caller remembering to check.
   */
  riskEvaluationId: string;
}

export interface BrokerFill {
  brokerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
  /** Commission plus regulatory fees. Zero at Alpaca; not zero everywhere. */
  fees: number;
  /** Session on which the fill occurred. */
  sessionDate: string;
  /** Sequence within the session, so fills have a total order. */
  sequence: number;
}

export interface BrokerOrderState {
  brokerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  kind: OrderKind;
  quantity: number;
  filledQuantity: number;
  /** Volume-weighted across every fill on this order. */
  averageFillPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: TimeInForce;
  status: BrokerOrderStatus;
  /** Session the order was submitted on. Nothing may fill on this session. */
  submittedSession: string;
  rejectReason?: string;
}

/** The broker's own view: one line per symbol, average cost, no mandates. */
export interface BrokerPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
}

export interface BrokerAccount {
  cash: number;
  /** Cash minus the value of unfilled buy orders. */
  buyingPower: number;
  equity: number;
}

export interface BrokerAdapter {
  readonly name: string;
  submitOrder(request: BrokerOrderRequest): Promise<BrokerOrderState>;
  cancelOrder(brokerOrderId: string): Promise<BrokerOrderState>;
  getOrder(brokerOrderId: string): Promise<BrokerOrderState | null>;
  listOpenOrders(): Promise<BrokerOrderState[]>;
  listPositions(): Promise<BrokerPosition[]>;
  getAccount(): Promise<BrokerAccount>;
}

/** Raised when an order is refused before it reaches the venue. */
export class OrderRefusedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OrderRefusedError";
  }
}

export interface RiskApproval {
  id: string;
  symbol: string;
  side: Side;
  /** The quantity the risk engine permitted. An order may not exceed it. */
  approvedQuantity: number;
  decision: "approve" | "reduce" | "reject";
  /** Approvals go stale; a size computed against last week's equity is wrong. */
  expiresAt?: Date;
}

export interface ExecutionGuards {
  /** True when the kill switch is tripped. Checked on every single order. */
  isKillSwitchTripped(): Promise<boolean> | boolean;
  /** The approved evaluation for this id, or null if there is none. */
  lookupRiskApproval(id: string): Promise<RiskApproval | null> | RiskApproval | null;
  /** Injected so staleness checks are testable without waiting. */
  now?(): Date;
}
