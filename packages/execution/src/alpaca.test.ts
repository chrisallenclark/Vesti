/**
 * The Alpaca adapter, without Alpaca.
 *
 * `fetch` is injected, so every branch that matters — including the ones a live
 * run would only reach on a bad day — is reachable offline and deterministically.
 * The status mapping gets the most attention because it is the part with real
 * consequences: an order stranded in a state nothing acts on is a position the
 * strategy believes it is getting and never gets, and no amount of correct HTTP
 * plumbing saves you from it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderRefusedError } from "@vesti/core/broker/types.ts";
import { AlpacaBroker, ALPACA_LIVE_URL, ALPACA_PAPER_URL, toOrderState } from "./alpaca.ts";
import { decodeFrame } from "./fills.ts";

function alpacaOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1b2",
    client_order_id: "our-order-id",
    symbol: "AAPL",
    side: "buy",
    order_type: "market",
    qty: "10",
    filled_qty: "0",
    filled_avg_price: null,
    limit_price: null,
    stop_price: null,
    time_in_force: "day",
    status: "new",
    submitted_at: "2026-08-11T17:55:00Z",
    created_at: "2026-08-11T17:55:00Z",
    ...overrides,
  };
}

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => { status: number; body?: unknown },
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("Alpaca status mapping", () => {
  it("maps every status Alpaca documents", () => {
    // Written as a table so adding a venue status is a deliberate act. The
    // adapter throws on an unmapped one rather than guessing, and this is the
    // list that keeps that from being a nuisance in production.
    const expected: Array<[string, string]> = [
      ["new", "working"],
      ["accepted", "accepted"],
      ["pending_new", "accepted"],
      ["accepted_for_bidding", "accepted"],
      ["partially_filled", "partially_filled"],
      ["filled", "filled"],
      ["done_for_day", "expired"],
      ["canceled", "cancelled"],
      ["expired", "expired"],
      ["replaced", "cancelled"],
      ["pending_cancel", "working"],
      ["pending_replace", "working"],
      ["stopped", "working"],
      ["calculated", "working"],
      ["suspended", "working"],
      ["rejected", "rejected"],
    ];
    for (const [alpaca, ours] of expected) {
      assert.equal(
        toOrderState(alpacaOrder({ status: alpaca }) as never).status,
        ours,
        `status ${alpaca}`,
      );
    }
  });

  it("treats done_for_day as finished rather than still working", () => {
    // The one that costs money if it is wrong. A day order that closed unfilled
    // will never fill; leaving it "working" means nothing ever replaces it and
    // the intended position silently never exists.
    assert.equal(toOrderState(alpacaOrder({ status: "done_for_day" }) as never).status, "expired");
  });

  it("keeps a pending cancel live until the venue confirms it", () => {
    // The shares are still in the market. Reporting the order cancelled early
    // would let a caller size a replacement against them and end up with both.
    assert.equal(toOrderState(alpacaOrder({ status: "pending_cancel" }) as never).status, "working");
  });

  it("refuses to guess at a status it does not know", () => {
    assert.throws(
      () => toOrderState(alpacaOrder({ status: "invented_by_the_venue" }) as never),
      /Unmapped Alpaca order status/,
    );
  });

  it("parses quantities and prices out of the strings Alpaca sends", () => {
    const state = toOrderState(
      alpacaOrder({
        status: "partially_filled",
        qty: "100",
        filled_qty: "40",
        filled_avg_price: "306.515",
        limit_price: "310.00",
      }) as never,
    );
    assert.equal(state.quantity, 100);
    assert.equal(state.filledQuantity, 40);
    assert.equal(state.averageFillPrice, 306.515);
    assert.equal(state.limitPrice, 310);
    assert.equal(state.stopPrice, null);
    assert.equal(state.submittedSession, "2026-08-11");
  });
});

describe("AlpacaBroker", () => {
  const credentials = { keyId: "k", secretKey: "s" };

  it("defaults to paper and names itself accordingly", () => {
    assert.equal(new AlpacaBroker(credentials).name, "alpaca-paper");
    assert.equal(new AlpacaBroker(credentials).isLive, false);
    assert.equal(new AlpacaBroker({ ...credentials, baseUrl: ALPACA_LIVE_URL }).isLive, true);
  });

  it("sends our order id as client_order_id so a retry cannot double the position", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: alpacaOrder() }));
    const broker = new AlpacaBroker({ ...credentials, baseUrl: ALPACA_PAPER_URL, fetchImpl });

    await broker.submitOrder({
      clientOrderId: "our-order-id",
      symbol: "AAPL",
      side: "buy",
      kind: "limit",
      quantity: 10,
      limitPrice: 300.5,
      timeInForce: "day",
      riskEvaluationId: "risk-1",
    });

    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    assert.equal(body["client_order_id"], "our-order-id");
    assert.equal(body["symbol"], "AAPL");
    assert.equal(body["qty"], "10");
    assert.equal(body["type"], "limit");
    assert.equal(body["limit_price"], "300.5");
    assert.equal(body["time_in_force"], "day");
    // The risk evaluation is the gate's business, not the venue's. Sending it
    // would leak our internal ids to a third party for no purpose.
    assert.equal(body["riskEvaluationId"], undefined);
  });

  it("turns a venue rejection into an OrderRefusedError like any other refusal", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 403,
      body: { message: "insufficient buying power" },
    }));
    const broker = new AlpacaBroker({ ...credentials, fetchImpl });

    await assert.rejects(
      () =>
        broker.submitOrder({
          clientOrderId: "o1",
          symbol: "AAPL",
          side: "buy",
          kind: "market",
          quantity: 100000,
          timeInForce: "day",
          riskEvaluationId: "risk-1",
        }),
      (error: unknown) =>
        error instanceof OrderRefusedError && error.code === "insufficient_buying_power",
    );
  });

  it("treats an uncancellable order as successfully not working", async () => {
    // 404 means already gone, 422 means no longer cancellable. Neither is a
    // failure to achieve what the caller wanted, and throwing would make the
    // kill switch noisy at the exact moment it must not be.
    for (const status of [404, 422]) {
      const { fetchImpl } = stubFetch((url, init) =>
        init?.method === "DELETE"
          ? { status }
          : { status: 200, body: alpacaOrder({ status: "filled", filled_qty: "10" }) },
      );
      const broker = new AlpacaBroker({ ...credentials, fetchImpl });
      const state = await broker.cancelOrder("a1b2");
      assert.equal(state.status, "filled");
    }
  });

  it("retries a transient 503 instead of dying on a blip", async () => {
    // Observed against the live paper endpoint: a plain account read returned
    // 503 and succeeded moments later. An adapter that gives up there cannot
    // run unattended.
    let attempts = 0;
    const { fetchImpl } = stubFetch(() => {
      attempts += 1;
      return attempts < 3 ? { status: 503 } : { status: 200, body: alpacaOrder() };
    });
    const broker = new AlpacaBroker({ ...credentials, fetchImpl });
    const state = await broker.getOrder("a1b2");
    assert.equal(attempts, 3);
    assert.equal(state?.brokerOrderId, "a1b2");
  });

  it("does not retry a refusal the venue meant", async () => {
    // A 4xx is understood and declined. Repeating it just declines again, and
    // on an order endpoint every extra attempt is another chance to place one.
    let attempts = 0;
    const { fetchImpl } = stubFetch(() => {
      attempts += 1;
      return { status: 403, body: { message: "insufficient buying power" } };
    });
    const broker = new AlpacaBroker({ ...credentials, fetchImpl });
    await assert.rejects(() =>
      broker.submitOrder({
        clientOrderId: "o1",
        symbol: "AAPL",
        side: "buy",
        kind: "market",
        quantity: 1,
        timeInForce: "day",
        riskEvaluationId: "r1",
      }),
    );
    assert.equal(attempts, 1);
  });

  it("resolves a duplicate client_order_id to the order that already exists", async () => {
    // The dangerous case a retry creates: the first attempt reached the venue
    // and the response was lost. Reporting failure here would invite a caller
    // to try again for shares it already owns.
    const { fetchImpl } = stubFetch((url, init) => {
      if (init?.method === "POST") {
        return { status: 422, body: { message: "client_order_id must be unique; already exists" } };
      }
      return { status: 200, body: alpacaOrder({ status: "filled", filled_qty: "10" }) };
    });
    const broker = new AlpacaBroker({ ...credentials, fetchImpl });

    const state = await broker.submitOrder({
      clientOrderId: "our-order-id",
      symbol: "AAPL",
      side: "buy",
      kind: "market",
      quantity: 10,
      timeInForce: "day",
      riskEvaluationId: "r1",
    });
    assert.equal(state.status, "filled");
    assert.equal(state.clientOrderId, "our-order-id");
  });

  it("reports the broker's omnibus positions with no notion of mandates", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: [{ symbol: "AAPL", qty: "540", avg_entry_price: "83.9629" }],
    }));
    const broker = new AlpacaBroker({ ...credentials, fetchImpl });
    assert.deepEqual(await broker.listPositions(), [
      { symbol: "AAPL", quantity: 540, averageCost: 83.9629 },
    ]);
  });

  it("returns null rather than throwing for an order the venue has never seen", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404 }));
    const broker = new AlpacaBroker({ ...credentials, fetchImpl });
    assert.equal(await broker.getOrder("nope"), null);
    assert.equal(await broker.getOrderByClientId("nope"), null);
  });
});

describe("stream frame decoding", () => {
  /**
   * A regression with a live cost. Alpaca sends JSON inside BINARY websocket
   * frames, so `String(event.data)` yields the literal "[object Blob]" and every
   * message fails to parse. On the first real paper order the stream delivered
   * nothing and only the poller caught the fill — which is exactly the failure
   * a fallback is supposed to hide, and exactly why it must not be the only
   * thing that works.
   */
  const payload = '{"stream":"trade_updates","data":{"event":"fill"}}';

  it("decodes the binary frames Alpaca actually sends", () => {
    const bytes = new TextEncoder().encode(payload);
    assert.equal(decodeFrame(bytes.buffer), payload);
    assert.equal(decodeFrame(bytes), payload);
  });

  it("still accepts a text frame", () => {
    assert.equal(decodeFrame(payload), payload);
  });

  it("refuses a frame it cannot decode rather than parsing nonsense", () => {
    // The original bug in one line: an object stringifies to "[object Object]",
    // which is not JSON, and the resulting parse error names the wrong problem.
    assert.throws(() => decodeFrame({ not: "a frame" }), /Cannot decode a stream frame/);
  });
});
