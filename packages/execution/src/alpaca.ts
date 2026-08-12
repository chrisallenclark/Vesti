/**
 * Alpaca as a `BrokerAdapter`.
 *
 * Lives here rather than in `packages/core` because core is pure by contract
 * and this makes network calls. The interface it implements is core's, so
 * nothing above it knows whether it is talking to Alpaca or the simulator —
 * which is the only way paper-to-live can be a configuration change rather than
 * a rewrite of the code path that moves money.
 *
 * It is deliberately thin. Every rule about whether an order is *allowed* lives
 * in `guardedBroker`, wrapped around this; adding a broker must not mean
 * re-deriving the safety properties. This file's whole job is translation, and
 * the translation that matters is status.
 *
 * `is_live` is not this class's decision. The base URL points at paper or live
 * and the execution service refuses to construct a live one below the L3 gate;
 * an adapter that could promote itself would be a promotion gate in name only.
 */

import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerOrderRequest,
  BrokerOrderState,
  BrokerOrderStatus,
  BrokerPosition,
  OrderKind,
  Side,
  TimeInForce,
} from "@vesti/core/broker/types.ts";
import { OrderRefusedError } from "@vesti/core/broker/types.ts";

/** One position as the broker marks it, for the dashboard rather than for reconciliation. */
export interface BrokerMarkedPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlFraction: number;
  currentPrice: number | null;
}

export interface BrokerPortfolio {
  cash: number;
  buyingPower: number;
  equity: number;
  /** Equity against the previous close's equity, as the broker computes it. */
  dayPnl: number | null;
  positions: BrokerMarkedPosition[];
}

export const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
export const ALPACA_LIVE_URL = "https://api.alpaca.markets";

export interface AlpacaBrokerOptions {
  keyId: string;
  secretKey: string;
  /** Defaults to paper. Pointing this at live is an explicit act. */
  baseUrl?: string;
  /** Injectable so the whole adapter is testable without a venue. */
  fetchImpl?: typeof fetch;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  order_type: string;
  type?: string;
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  limit_price: string | null;
  stop_price: string | null;
  time_in_force: string;
  status: string;
  submitted_at: string | null;
  created_at: string;
  canceled_at?: string | null;
  expired_at?: string | null;
}

/**
 * Alpaca's sixteen statuses onto our seven.
 *
 * The mapping is written out rather than defaulted because the interesting
 * failure is an order stranded in a state nothing acts on. `done_for_day` in
 * particular is not "still working": it will never fill again, and treating it
 * as open leaves a position the strategy believes it is getting and never gets.
 *
 * The pending_* states map to `working` on purpose. A cancel that has been
 * accepted but not confirmed has NOT yet released the order — reporting it
 * cancelled early would let a caller size a replacement against shares still
 * live in the market.
 */
const STATUS_MAP: Readonly<Record<string, BrokerOrderStatus>> = {
  new: "working",
  accepted: "accepted",
  pending_new: "accepted",
  accepted_for_bidding: "accepted",
  partially_filled: "partially_filled",
  filled: "filled",
  done_for_day: "expired",
  canceled: "cancelled",
  expired: "expired",
  replaced: "cancelled",
  pending_cancel: "working",
  pending_replace: "working",
  // Stop orders awaiting or undergoing trigger calculation. Live, not resolved.
  stopped: "working",
  calculated: "working",
  suspended: "working",
  rejected: "rejected",
};

const KIND_TO_ALPACA: Readonly<Record<OrderKind, string>> = {
  market: "market",
  limit: "limit",
  stop: "stop",
  stop_limit: "stop_limit",
};

const ALPACA_TO_KIND: Readonly<Record<string, OrderKind>> = {
  market: "market",
  limit: "limit",
  stop: "stop",
  stop_limit: "stop_limit",
  trailing_stop: "stop",
};

export class AlpacaBroker implements BrokerAdapter {
  readonly name: string;

  readonly #keyId: string;
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: AlpacaBrokerOptions) {
    this.#keyId = options.keyId;
    this.#secretKey = options.secretKey;
    this.#baseUrl = options.baseUrl ?? ALPACA_PAPER_URL;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.name = this.#baseUrl === ALPACA_LIVE_URL ? "alpaca-live" : "alpaca-paper";
  }

  get isLive(): boolean {
    return this.#baseUrl === ALPACA_LIVE_URL;
  }

  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrderState> {
    const body: Record<string, unknown> = {
      // Our order id, echoed back by every subsequent report. Alpaca enforces
      // uniqueness per account, so a retry after a lost response is refused as
      // a duplicate rather than becoming a second position.
      client_order_id: request.clientOrderId,
      symbol: request.symbol,
      qty: String(request.quantity),
      side: request.side,
      type: KIND_TO_ALPACA[request.kind],
      time_in_force: request.timeInForce,
    };
    if (request.limitPrice !== undefined) body["limit_price"] = String(request.limitPrice);
    if (request.stopPrice !== undefined) body["stop_price"] = String(request.stopPrice);

    const response = await this.#request("POST", "/v2/orders", body);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");

      // The order already exists. Either a retry above reached the venue twice,
      // or a previous run submitted it and lost the response. Both mean the
      // order IS placed, and the only wrong move is to report failure and let a
      // caller try again — so return what is actually live.
      if (isDuplicateClientOrderId(response.status, detail)) {
        const existing = await this.getOrderByClientId(request.clientOrderId);
        if (existing) return existing;
      }

      // A venue refusal is an OrderRefusedError like any other, so a caller
      // handling refusals does not need a separate branch for "the broker said
      // no" versus "the gate said no".
      throw new OrderRefusedError(
        `Alpaca refused the order: ${response.status} ${detail.slice(0, 300)}`,
        response.status === 403 ? "insufficient_buying_power" : "broker_rejected",
      );
    }
    return toOrderState((await response.json()) as AlpacaOrder);
  }

  async cancelOrder(brokerOrderId: string): Promise<BrokerOrderState> {
    const response = await this.#request("DELETE", `/v2/orders/${brokerOrderId}`);
    // 404 means it is already gone and 422 that it is no longer cancellable.
    // Neither is a failure to cancel — in both the order is not working, which
    // is what the caller wanted. Throwing here would make a kill switch noisy
    // at exactly the moment it must not be.
    if (!response.ok && response.status !== 404 && response.status !== 422) {
      throw new Error(`Alpaca cancel failed: ${response.status} ${await response.text()}`);
    }
    const state = await this.getOrder(brokerOrderId);
    if (!state) throw new Error(`Order ${brokerOrderId} vanished after cancel.`);
    return state;
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderState | null> {
    const response = await this.#request("GET", `/v2/orders/${brokerOrderId}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Alpaca getOrder failed: ${response.status} ${await response.text()}`);
    }
    return toOrderState((await response.json()) as AlpacaOrder);
  }

  /** Looks an order up by OUR id, which is what the ledger holds. */
  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrderState | null> {
    const response = await this.#request(
      "GET",
      `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Alpaca getOrderByClientId failed: ${response.status}`);
    }
    return toOrderState((await response.json()) as AlpacaOrder);
  }

  async listOpenOrders(): Promise<BrokerOrderState[]> {
    const response = await this.#request("GET", "/v2/orders?status=open&limit=500");
    if (!response.ok) {
      throw new Error(`Alpaca listOpenOrders failed: ${response.status}`);
    }
    const payload = (await response.json()) as AlpacaOrder[];
    return payload.map(toOrderState);
  }

  async listPositions(): Promise<BrokerPosition[]> {
    const response = await this.#request("GET", "/v2/positions");
    if (!response.ok) {
      throw new Error(`Alpaca listPositions failed: ${response.status}`);
    }
    const payload = (await response.json()) as Array<{
      symbol: string;
      qty: string;
      avg_entry_price: string;
    }>;
    return payload.map((p) => ({
      symbol: p.symbol,
      quantity: Number(p.qty),
      averageCost: Number(p.avg_entry_price),
    }));
  }

  async getAccount(): Promise<BrokerAccount> {
    const response = await this.#request("GET", "/v2/account");
    if (!response.ok) {
      throw new Error(`Alpaca getAccount failed: ${response.status}`);
    }
    const payload = (await response.json()) as {
      cash: string;
      buying_power: string;
      equity: string;
      account_number: string;
      status: string;
      trading_blocked: boolean;
    };
    return {
      cash: Number(payload.cash),
      buyingPower: Number(payload.buying_power),
      equity: Number(payload.equity),
    };
  }

  /**
   * The broker's whole current view in one call pair: balances plus positions
   * with their marks.
   *
   * Exists because the dashboard needs live P&L and must not hold a trading
   * credential to get it — the worker takes this and writes it to
   * `broker_snapshots`, so the number the operator reads is Alpaca's own rather
   * than one this system recomputed and could be wrong about.
   *
   * `listPositions` deliberately stays narrow: it feeds reconciliation, which
   * compares share counts and has no business reading a mark.
   */
  async getPortfolio(): Promise<BrokerPortfolio> {
    const [accountResponse, positionsResponse] = await Promise.all([
      this.#request("GET", "/v2/account"),
      this.#request("GET", "/v2/positions"),
    ]);
    if (!accountResponse.ok) {
      throw new Error(`Alpaca getAccount failed: ${accountResponse.status}`);
    }
    if (!positionsResponse.ok) {
      throw new Error(`Alpaca listPositions failed: ${positionsResponse.status}`);
    }

    const account = (await accountResponse.json()) as {
      cash: string;
      buying_power: string;
      equity: string;
      last_equity: string;
    };
    const positions = (await positionsResponse.json()) as Array<{
      symbol: string;
      qty: string;
      avg_entry_price: string;
      market_value: string;
      unrealized_pl: string;
      unrealized_plpc: string;
      current_price: string | null;
    }>;

    const equity = Number(account.equity);
    const lastEquity = Number(account.last_equity);
    return {
      cash: Number(account.cash),
      buyingPower: Number(account.buying_power),
      equity,
      // Alpaca's own day P&L basis: equity now against the previous close's
      // equity. Recomputing it from fills would disagree with the broker's
      // screen, and the operator will be looking at both.
      dayPnl: Number.isFinite(lastEquity) ? equity - lastEquity : null,
      positions: positions.map((p) => ({
        symbol: p.symbol,
        quantity: Number(p.qty),
        averageCost: Number(p.avg_entry_price),
        marketValue: Number(p.market_value),
        unrealizedPnl: Number(p.unrealized_pl),
        unrealizedPnlFraction: Number(p.unrealized_plpc),
        currentPrice: p.current_price === null ? null : Number(p.current_price),
      })),
    };
  }

  /** Account identity and trading status, for the pre-flight check. */
  async getAccountDetail(): Promise<{
    accountNumber: string;
    status: string;
    tradingBlocked: boolean;
    cash: number;
  }> {
    const response = await this.#request("GET", "/v2/account");
    if (!response.ok) {
      throw new Error(`Alpaca getAccount failed: ${response.status}`);
    }
    const payload = (await response.json()) as {
      account_number: string;
      status: string;
      trading_blocked: boolean;
      cash: string;
    };
    return {
      accountNumber: payload.account_number,
      status: payload.status,
      tradingBlocked: payload.trading_blocked,
      cash: Number(payload.cash),
    };
  }

  /** True when the venue is accepting orders right now. */
  async isMarketOpen(): Promise<boolean> {
    const response = await this.#request("GET", "/v2/clock");
    if (!response.ok) throw new Error(`Alpaca clock failed: ${response.status}`);
    return ((await response.json()) as { is_open: boolean }).is_open;
  }

  /**
   * One request, retried through transient failure.
   *
   * Venues return 5xx and rate-limit, and an adapter that gives up on the first
   * one cannot run unattended — "the overnight job died on a blip" is a bad way
   * to discover that.
   *
   * One failure this CANNOT fix, and says so instead: an egress proxy answering
   * 503 with a DNS resolution failure. Observed in a sandboxed environment,
   * where it latches for the lifetime of the process — every request from that
   * process fails while a neighbouring one succeeds, because the resolver
   * result is cached below this layer. Retrying inside the process is futile,
   * so the error names the cause rather than blaming the venue, and recovery is
   * a fresh process (which a scheduler provides for free).
   *
   * Retries cover 5xx, 429 and transport errors. A 4xx is never retried: the
   * venue understood the request and refused it, and repeating it just refuses
   * again.
   *
   * Retrying a POST is safe here only because `client_order_id` is on every
   * order. If the first attempt did reach the venue, the retry is rejected as a
   * duplicate rather than becoming a second position — and `submitOrder`
   * resolves that case by fetching the order that already exists. Without that
   * id this loop would be a way to buy the same thing twice.
   */
  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = new URL(path, this.#baseUrl);
    const init: RequestInit = {
      method,
      headers: {
        "APCA-API-KEY-ID": this.#keyId,
        "APCA-API-SECRET-KEY": this.#secretKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await this.#fetch(url, init);
        if (isProxyDnsFailure(response.status)) {
          const body = await response.text().catch(() => "");
          if (/dns resolution failure/i.test(body)) {
            throw new Error(
              `Egress proxy could not resolve ${url.hostname} (503, DNS resolution failure). ` +
                `This is the network path, not the venue, and it does not clear within a ` +
                `process — rerun. Alpaca itself is reachable if curl succeeds.`,
            );
          }
          // A genuine 503 from the venue, which retrying may well fix.
          if (attempt === RETRY_DELAYS_MS.length) return response;
        } else if (!isRetryable(response.status) || attempt === RETRY_DELAYS_MS.length) {
          return response;
        }
      } catch (error) {
        lastError = error;
        if (attempt === RETRY_DELAYS_MS.length) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
    throw lastError ?? new Error(`Alpaca ${method} ${path} exhausted retries.`);
  }
}

const RETRY_DELAYS_MS = [250, 1000, 3000];

function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

function isProxyDnsFailure(status: number): boolean {
  return status === 503;
}

/**
 * Matched on the message rather than the status alone, because 422 covers every
 * kind of unprocessable order and only this one means "you already placed it".
 */
function isDuplicateClientOrderId(status: number, body: string): boolean {
  if (status !== 409 && status !== 422) return false;
  const lower = body.toLowerCase();
  return lower.includes("client_order_id") && (lower.includes("exist") || lower.includes("duplicate"));
}

export function toOrderState(order: AlpacaOrder): BrokerOrderState {
  const filled = Number(order.filled_qty);
  const status = STATUS_MAP[order.status];
  if (!status) {
    // An unmapped status is not something to guess at: it decides whether the
    // caller believes an order is still live. Failing loudly here is much
    // cheaper than a position that quietly never arrives.
    throw new Error(`Unmapped Alpaca order status "${order.status}" on order ${order.id}.`);
  }
  const kind = ALPACA_TO_KIND[order.order_type ?? order.type ?? "market"] ?? "market";

  return {
    brokerOrderId: order.id,
    clientOrderId: order.client_order_id,
    symbol: order.symbol,
    side: order.side as Side,
    kind,
    quantity: Number(order.qty ?? 0),
    filledQuantity: filled,
    averageFillPrice: order.filled_avg_price === null ? null : Number(order.filled_avg_price),
    limitPrice: order.limit_price === null ? null : Number(order.limit_price),
    stopPrice: order.stop_price === null ? null : Number(order.stop_price),
    timeInForce: order.time_in_force as TimeInForce,
    status,
    submittedSession: (order.submitted_at ?? order.created_at).slice(0, 10),
  };
}
