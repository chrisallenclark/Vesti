/**
 * Getting fills from a real broker into the ledger.
 *
 * This is the gap between `SimBroker` and a venue, and it is an interface gap
 * rather than a coding one. The simulator hands fills back from `openSession()`
 * because it decides when they happen. A real broker fills asynchronously —
 * minutes later, out of order, possibly while this process is restarting — so
 * `BrokerAdapter` has no method that could return them and there is no useful
 * one to add.
 *
 * Two sources, and both run:
 *
 *   THE STREAM (`trade_updates`) is primary. Each event is a discrete execution
 *   with its own id, which is exactly the shape `broker_fill_id` wants.
 *
 *   THE POLLER is the safety net. Websockets drop, and a missed fill is a
 *   position nobody is accounting for — no stop watching it, no exit that will
 *   name it. It re-reads open orders and derives the delta between the broker's
 *   cumulative `filled_qty` and ours.
 *
 * Running both at once is free, and that is the entire reason `postFill` was
 * made idempotent before either existed. Whichever arrives second collides on
 * the unique index and returns `applied: false` having touched nothing. Without
 * that property this design would be a double-counting machine; with it, the
 * redundancy costs one wasted transaction.
 *
 * The poller is also the recovery path on startup. Anything that filled while
 * the process was down is not on the stream — it already happened — and only a
 * comparison against the broker's cumulative state will find it.
 */

import type { BrokerOrderState } from "@vesti/core/broker/types.ts";
import type { OrderLedger, PostedFill } from "./ledger.ts";
import type { LotMethod } from "./lots.ts";

/**
 * The one thing polling needs from a broker: an order looked up by OUR id.
 *
 * Structural rather than the concrete adapter, so the loop can be driven by a
 * stub in tests. A refusal path that can only be exercised against a live venue
 * is a refusal path nobody exercises.
 */
export interface FillPollingBroker {
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrderState | null>;
}

export interface FillSourceOptions {
  /** Which lots exits consume. */
  method?: LotMethod;
  /** Called for every fill actually applied, and for duplicates that were not. */
  onFill?: (event: { orderId: string; posted: PostedFill }) => void;
  onError?: (error: unknown) => void;
}

/**
 * Reads each order's cumulative fill state from the broker and hands it to the
 * ledger, which works out what we are behind by.
 *
 * Note what this function does NOT do: compute the delta itself. Reading our
 * filled quantity here and posting the difference would be a check-then-act
 * across two connections, and the stream posting in the gap between them would
 * double-count. `postCumulativeFill` does the subtraction while holding the
 * order lock, which is the only place it is safe to do.
 *
 * Alpaca charges no commission. A venue that does reports it per execution on
 * the stream rather than on the order, so the poller cannot recover a fee and
 * deliberately does not invent one.
 */
export async function pollFills(
  broker: FillPollingBroker,
  ledger: OrderLedger,
  orderIds: readonly string[],
  options: FillSourceOptions = {},
): Promise<PostedFill[]> {
  const posted: PostedFill[] = [];

  for (const orderId of orderIds) {
    try {
      const state = await broker.getOrderByClientId(orderId);
      if (!state || state.filledQuantity <= 0) continue;

      const result = await ledger.postCumulativeFill(
        orderId,
        {
          cumulativeQuantity: state.filledQuantity,
          cumulativeAveragePrice: state.averageFillPrice ?? 0,
          filledAt: new Date(),
        },
        options.method ? { method: options.method } : {},
      );
      if (result.applied) posted.push(result);
      options.onFill?.({ orderId, posted: result });
    } catch (error) {
      // One order's failure must not stop the sweep. The whole point of the
      // poller is to be the thing that still works when something else did not.
      options.onError?.(error);
    }
  }

  return posted;
}

/** Frames arrive as ArrayBuffer; strings are accepted too so a test can send either. */
export function decodeFrame(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
    );
  }
  throw new Error(`Cannot decode a stream frame of type ${Object.prototype.toString.call(data)}.`);
}

interface TradeUpdate {
  event: string;
  execution_id?: string;
  price?: string;
  qty?: string;
  timestamp?: string;
  order: {
    id: string;
    client_order_id: string;
    filled_qty: string;
    filled_avg_price: string | null;
    status: string;
  };
}

/**
 * Subscribes to `trade_updates` and posts each execution as it arrives.
 *
 * Only `fill` and `partial_fill` carry an execution — the other events
 * (`new`, `canceled`, `expired`, `rejected`) are order state, which the ledger
 * learns about through its own terminal transitions rather than by trusting a
 * stream that may have missed something.
 *
 * Returns a stop function. The caller owns the lifetime, because a stream that
 * closes itself on a quiet market is indistinguishable from one that died.
 */
export function streamFills(
  options: {
    keyId: string;
    secretKey: string;
    /** `wss://paper-api.alpaca.markets/stream` unless pointed at live. */
    streamUrl: string;
    ledger: OrderLedger;
  } & FillSourceOptions,
): { stop: () => void; ready: Promise<void> } {
  const socket = new WebSocket(options.streamUrl);
  // Alpaca sends JSON inside BINARY frames, not text ones. Left at the default
  // `blob`, every message decodes to the string "[object Blob]" and the stream
  // silently delivers nothing — which is exactly what it did on the first live
  // run, where only the poller caught the fill.
  socket.binaryType = "arraybuffer";
  let resolveReady: () => void;
  let rejectReady: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        action: "auth",
        key: options.keyId,
        secret: options.secretKey,
      }),
    );
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    void (async () => {
      let message: { stream?: string; data?: unknown };
      try {
        message = JSON.parse(decodeFrame(event.data)) as { stream?: string; data?: unknown };
      } catch (error) {
        options.onError?.(error);
        return;
      }

      if (message.stream === "authorization") {
        const status = (message.data as { status?: string } | undefined)?.status;
        if (status === "authorized") {
          socket.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
        } else {
          rejectReady(new Error(`Alpaca stream refused authorization: ${status}`));
        }
        return;
      }
      if (message.stream === "listening") {
        resolveReady();
        return;
      }
      if (message.stream !== "trade_updates") return;

      const update = message.data as TradeUpdate;
      if (update.event !== "fill" && update.event !== "partial_fill") return;
      if (!update.qty || !update.price) return;

      try {
        // Posted cumulatively, from `order.filled_qty` — the same key space the
        // poller uses — rather than as a discrete execution. The event does
        // carry its own execution id and the ledger records it, but keying on
        // it would mean the stream and the poller describing the same 40-share
        // partial under two different identifiers and the ledger booking 80.
        const posted = await options.ledger.postCumulativeFill(
          update.order.client_order_id,
          {
            cumulativeQuantity: Number(update.order.filled_qty),
            cumulativeAveragePrice: Number(update.order.filled_avg_price ?? update.price),
            filledAt: update.timestamp ? new Date(update.timestamp) : new Date(),
            ...(update.execution_id ? { executionId: update.execution_id } : {}),
          },
          options.method ? { method: options.method } : {},
        );
        options.onFill?.({ orderId: update.order.client_order_id, posted });
      } catch (error) {
        options.onError?.(error);
      }
    })();
  });

  socket.addEventListener("error", (event) => {
    options.onError?.(event);
    rejectReady(new Error("Alpaca stream socket error"));
  });

  return {
    stop: () => socket.close(),
    ready,
  };
}
