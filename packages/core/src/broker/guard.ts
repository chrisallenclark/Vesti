/**
 * The execution gate.
 *
 * Every rule about whether an order is *allowed* lives here, once, wrapped
 * around whatever adapter is in use. The alternative — each broker
 * implementation checking the kill switch and the risk approval for itself — is
 * a design where adding a broker means re-deriving the safety properties, and
 * where forgetting a check is a silent hole rather than a compile error.
 *
 * There is deliberately no way to obtain the inner adapter from the outside. If
 * a caller can reach past the guard, the guard is a suggestion.
 *
 * Four refusals, in the order they are cheapest to establish:
 *
 *   1. Kill switch tripped — a human or an automatic limit has said stop.
 *   2. No approval, or an approval that does not exist.
 *   3. An approval for a different instrument or direction than the order.
 *   4. A quantity larger than the risk engine permitted, or an approval old
 *      enough that the portfolio it was computed against has moved on.
 *
 * Cancellation is never gated. Blocking a cancel during a kill-switch event
 * would trap working orders in the market at exactly the moment someone has
 * decided to stop trading.
 */

import {
  OrderRefusedError,
  type BrokerAdapter,
  type BrokerAccount,
  type BrokerOrderRequest,
  type BrokerOrderState,
  type BrokerPosition,
  type ExecutionGuards,
} from "./types.ts";

export function guardedBroker(inner: BrokerAdapter, guards: ExecutionGuards): BrokerAdapter {
  const now = (): Date => guards.now?.() ?? new Date();

  return {
    name: `guarded(${inner.name})`,

    async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrderState> {
      if (await guards.isKillSwitchTripped()) {
        throw new OrderRefusedError(
          "Kill switch is tripped. No new orders may be submitted until it is reset.",
          "kill_switch_tripped",
        );
      }

      if (!request.riskEvaluationId) {
        throw new OrderRefusedError(
          "Order carries no risk evaluation. Every order must be authorised by the risk engine.",
          "missing_risk_evaluation",
        );
      }

      const approval = await guards.lookupRiskApproval(request.riskEvaluationId);
      if (!approval) {
        throw new OrderRefusedError(
          `Risk evaluation ${request.riskEvaluationId} does not exist.`,
          "unknown_risk_evaluation",
        );
      }

      if (approval.decision === "reject") {
        throw new OrderRefusedError(
          `Risk evaluation ${approval.id} rejected this trade.`,
          "risk_rejected",
        );
      }

      // An approval is for one instrument in one direction. Reusing yesterday's
      // approval id on a different symbol is the exact shape of bug that turns
      // a small authorised trade into a large unauthorised one.
      if (approval.symbol !== request.symbol || approval.side !== request.side) {
        throw new OrderRefusedError(
          `Risk evaluation ${approval.id} authorises ${approval.side} ${approval.symbol}, ` +
            `not ${request.side} ${request.symbol}.`,
          "approval_mismatch",
        );
      }

      if (request.quantity > approval.approvedQuantity) {
        throw new OrderRefusedError(
          `Order of ${request.quantity} exceeds the approved ${approval.approvedQuantity}.`,
          "exceeds_approved_quantity",
        );
      }

      if (approval.expiresAt && approval.expiresAt <= now()) {
        throw new OrderRefusedError(
          `Risk evaluation ${approval.id} expired at ${approval.expiresAt.toISOString()}. ` +
            `Re-evaluate against current portfolio state.`,
          "approval_expired",
        );
      }

      return inner.submitOrder(request);
    },

    // Getting out is never blocked.
    cancelOrder: (id: string): Promise<BrokerOrderState> => inner.cancelOrder(id),
    getOrder: (id: string): Promise<BrokerOrderState | null> => inner.getOrder(id),
    listOpenOrders: (): Promise<BrokerOrderState[]> => inner.listOpenOrders(),
    listPositions: (): Promise<BrokerPosition[]> => inner.listPositions(),
    getAccount: (): Promise<BrokerAccount> => inner.getAccount(),
  };
}
