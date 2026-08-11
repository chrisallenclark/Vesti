import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardedBroker } from "./guard.ts";
import { SimBroker, type SimBar } from "./sim.ts";
import {
  OrderRefusedError,
  type BrokerOrderRequest,
  type ExecutionGuards,
  type RiskApproval,
} from "./types.ts";

function bar(overrides: Partial<SimBar> = {}): SimBar {
  return {
    symbol: "TEST",
    sessionDate: "2024-03-14",
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    volume: 1_000_000,
    spreadFraction: 0,
    atrFraction: 0,
    ...overrides,
  };
}

function request(overrides: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest {
  return {
    clientOrderId: "c1",
    symbol: "TEST",
    side: "buy",
    kind: "market",
    quantity: 100,
    timeInForce: "day",
    riskEvaluationId: "risk-1",
    ...overrides,
  };
}

/** Frictionless by default so each test isolates the one effect it is about. */
function broker(config: Partial<ConstructorParameters<typeof SimBroker>[0]> = {}): SimBroker {
  return new SimBroker({
    startingCash: 1_000_000,
    maxParticipation: 1,
    defaultSpreadFraction: 0,
    defaultAtrFraction: 0,
    impactCoefficient: 0,
    ...config,
  });
}

describe("no same-bar signal and fill", () => {
  it("refuses to fill an order on the session it was submitted", async () => {
    const sim = broker();
    sim.openSession("2024-03-14", [bar()]);
    await sim.submitOrder(request());

    // The strategy decided from this bar. It cannot also have traded inside it.
    const sameSession = sim.allFills();
    assert.equal(sameSession.length, 0);

    const fills = sim.openSession("2024-03-15", [bar({ sessionDate: "2024-03-15", open: 105 })]);
    assert.equal(fills.length, 1);
    assert.equal(fills[0]!.price, 105, "a market order fills at the NEXT session's open");
  });

  it("will not let sessions run backwards", () => {
    const sim = broker();
    sim.openSession("2024-03-15", [bar({ sessionDate: "2024-03-15" })]);
    assert.throws(
      () => sim.openSession("2024-03-14", [bar()]),
      /Sessions must advance/,
    );
  });
});

describe("order types against a bar", () => {
  const submitAndRun = async (
    req: Partial<BrokerOrderRequest>,
    next: Partial<SimBar>,
  ): Promise<ReturnType<SimBroker["openSession"]>> => {
    const sim = broker();
    sim.openSession("2024-03-14", [bar()]);
    await sim.submitOrder(request({ timeInForce: "gtc", ...req }));
    return sim.openSession("2024-03-15", [bar({ sessionDate: "2024-03-15", ...next })]);
  };

  it("fills a buy limit only when price trades through it", async () => {
    const missed = await submitAndRun(
      { kind: "limit", limitPrice: 95 },
      { open: 100, low: 95, high: 102, close: 101 },
    );
    assert.equal(missed.length, 0, "touching your limit does not clear the queue ahead of you");

    const hit = await submitAndRun(
      { kind: "limit", limitPrice: 95 },
      { open: 100, low: 94, high: 102, close: 101 },
    );
    assert.equal(hit[0]!.price, 95);
  });

  it("honours a gap through a limit in the trader's favour", async () => {
    const fills = await submitAndRun(
      { kind: "limit", limitPrice: 95 },
      { open: 90, low: 89, high: 96, close: 92 },
    );
    assert.equal(fills[0]!.price, 90, "a market that opens past your limit fills you there");
  });

  it("fills a sell stop at the stop, or worse on a gap", async () => {
    const touched = await submitAndRun(
      { side: "sell", kind: "stop", stopPrice: 96 },
      { open: 100, low: 95, high: 101, close: 97 },
    );
    assert.equal(touched[0]!.price, 96);

    const gapped = await submitAndRun(
      { side: "sell", kind: "stop", stopPrice: 96 },
      { open: 88, low: 86, high: 92, close: 90 },
    );
    assert.equal(gapped[0]!.price, 88, "a stop is not a guarantee — a gap fills below it");
  });

  it("leaves a triggered stop-limit unfilled when price never comes back", async () => {
    // The failure mode people discover in a fast market: the stop triggers, the
    // limit is never reached, and the position stays open through the move.
    const fills = await submitAndRun(
      { side: "sell", kind: "stop_limit", stopPrice: 96, limitPrice: 95 },
      { open: 90, low: 85, high: 91, close: 86 },
    );
    assert.equal(fills.length, 0);
  });

  it("does not trigger a stop the bar never reached", async () => {
    const fills = await submitAndRun(
      { side: "sell", kind: "stop", stopPrice: 90 },
      { open: 100, low: 97, high: 103, close: 99 },
    );
    assert.equal(fills.length, 0);
  });
});

describe("costs make size expensive", () => {
  it("charges half the spread to a marketable buy", async () => {
    const sim = new SimBroker({
      startingCash: 1_000_000,
      maxParticipation: 1,
      defaultSpreadFraction: 0.01, // 100bp, exaggerated so the arithmetic is legible
      defaultAtrFraction: 0,
      impactCoefficient: 0,
    });
    sim.openSession("2024-03-14", [bar()]);
    await sim.submitOrder(request());
    const [fill] = sim.openSession("2024-03-15", [
      { symbol: "TEST", sessionDate: "2024-03-15", open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ]);
    assert.equal(fill!.price, 100.5, "100 + half of a 100bp spread");
  });

  it("penalises a large order more than a small one, sub-linearly", async () => {
    const priceFor = async (quantity: number): Promise<number> => {
      const sim = new SimBroker({
        startingCash: 100_000_000,
        maxParticipation: 1,
        defaultSpreadFraction: 0,
        defaultAtrFraction: 0.02,
        impactCoefficient: 1,
      });
      sim.openSession("2024-03-14", [bar()]);
      await sim.submitOrder(request({ quantity }));
      const [fill] = sim.openSession("2024-03-15", [
        { symbol: "TEST", sessionDate: "2024-03-15", open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      ]);
      return fill!.price;
    };

    const small = await priceFor(1_000); // 0.1% of volume
    const large = await priceFor(100_000); // 10% of volume
    assert.ok(large > small, "taking more of the tape costs more");

    // Square-root, not linear: 100x the size is ~10x the impact, not 100x.
    const smallImpact = small - 100;
    const largeImpact = large - 100;
    const ratio = largeImpact / smallImpact;
    assert.ok(ratio > 8 && ratio < 12, `expected ~10x impact for 100x size, got ${ratio.toFixed(1)}x`);
  });

  it("rounds against the trader in both directions", async () => {
    const sim = new SimBroker({
      startingCash: 1_000_000,
      maxParticipation: 1,
      defaultSpreadFraction: 0.0001,
      defaultAtrFraction: 0,
      impactCoefficient: 0,
    });
    sim.openSession("2024-03-14", [bar()]);
    await sim.submitOrder(request({ clientOrderId: "b", side: "buy" }));
    await sim.submitOrder(request({ clientOrderId: "s", side: "sell" }));
    const fills = sim.openSession("2024-03-15", [
      { symbol: "TEST", sessionDate: "2024-03-15", open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ]);
    const buy = fills.find((f) => f.side === "buy")!;
    const sell = fills.find((f) => f.side === "sell")!;
    assert.ok(buy.price >= 100, `buy paid ${buy.price}`);
    assert.ok(sell.price <= 100, `sell received ${sell.price}`);
  });
});

describe("liquidity limits", () => {
  it("cannot take more of a session's volume than the participation cap", async () => {
    const sim = new SimBroker({
      startingCash: 100_000_000,
      maxParticipation: 0.02,
      defaultSpreadFraction: 0,
      defaultAtrFraction: 0,
      impactCoefficient: 0,
    });
    sim.openSession("2024-03-14", [bar()]);
    // 50,000 shares against 100,000-share sessions: 2% is 2,000 per bar.
    const ack = await sim.submitOrder(request({ quantity: 50_000, timeInForce: "gtc" }));

    for (const date of ["2024-03-15", "2024-03-18", "2024-03-19"]) {
      const fills = sim.openSession(date, [bar({ sessionDate: date, volume: 100_000 })]);
      assert.equal(fills[0]!.quantity, 2_000, `${date}: capped at 2% of the tape`);
    }

    const state = await sim.getOrder(ack.brokerOrderId);
    assert.equal(state!.filledQuantity, 6_000);
    assert.equal(state!.status, "partially_filled", "the rest is still working");
  });

  it("expires a day order that the tape could not absorb", async () => {
    const sim = new SimBroker({
      startingCash: 100_000_000,
      maxParticipation: 0.02,
      defaultSpreadFraction: 0,
      defaultAtrFraction: 0,
      impactCoefficient: 0,
    });
    sim.openSession("2024-03-14", [bar()]);
    const ack = await sim.submitOrder(request({ quantity: 50_000, timeInForce: "day" }));
    sim.openSession("2024-03-15", [bar({ sessionDate: "2024-03-15", volume: 100_000 })]);

    const state = await sim.getOrder(ack.brokerOrderId);
    assert.equal(state!.filledQuantity, 2_000);
    assert.deepEqual(await sim.listOpenOrders(), [], "a day order does not survive the session");
  });

  it("does not fill an instrument that did not trade", async () => {
    const sim = broker();
    sim.openSession("2024-03-14", [bar()]);
    await sim.submitOrder(request({ symbol: "HALTED", timeInForce: "gtc" }));
    const fills = sim.openSession("2024-03-15", [bar({ sessionDate: "2024-03-15" })]);
    assert.equal(fills.length, 0);
  });
});

describe("account and positions", () => {
  it("keeps cash, position and average cost consistent through a round trip", async () => {
    const sim = broker({ startingCash: 100_000 });
    sim.openSession("2024-03-14", [bar()]);
    await sim.submitOrder(request({ clientOrderId: "buy-1", quantity: 100 }));
    sim.openSession("2024-03-15", [bar({ sessionDate: "2024-03-15", open: 100, close: 100 })]);

    assert.deepEqual(await sim.listPositions(), [{ symbol: "TEST", quantity: 100, averageCost: 100 }]);
    assert.equal((await sim.getAccount()).cash, 90_000);

    // Add at a higher price: broker-side average cost re-averages.
    await sim.submitOrder(request({ clientOrderId: "buy-2", quantity: 100 }));
    sim.openSession("2024-03-18", [bar({ sessionDate: "2024-03-18", open: 120, close: 120 })]);
    assert.deepEqual(await sim.listPositions(), [{ symbol: "TEST", quantity: 200, averageCost: 110 }]);

    // Selling half does NOT move average cost — that is the broker's model, and
    // the reason our own specific-lot ledger exists alongside it.
    await sim.submitOrder(request({ clientOrderId: "sell-1", side: "sell", quantity: 100 }));
    sim.openSession("2024-03-19", [bar({ sessionDate: "2024-03-19", open: 130, close: 130 })]);
    assert.deepEqual(await sim.listPositions(), [{ symbol: "TEST", quantity: 100, averageCost: 110 }]);

    const account = await sim.getAccount();
    assert.equal(account.cash, 100_000 - 10_000 - 12_000 + 13_000);
    assert.equal(account.equity, account.cash + 100 * 130);
  });

  it("closes the position out entirely rather than leaving a zero row", async () => {
    const sim = broker({ startingCash: 100_000 });
    sim.openSession("2024-03-14", [bar()]);
    await sim.submitOrder(request({ clientOrderId: "b", quantity: 50 }));
    sim.openSession("2024-03-15", [bar({ sessionDate: "2024-03-15", open: 100, close: 100 })]);
    await sim.submitOrder(request({ clientOrderId: "s", side: "sell", quantity: 50 }));
    sim.openSession("2024-03-18", [bar({ sessionDate: "2024-03-18", open: 110, close: 110 })]);

    assert.deepEqual(await sim.listPositions(), []);
    assert.equal((await sim.getAccount()).cash, 100_500);
  });

  it("reserves buying power for working buy orders", async () => {
    const sim = broker({ startingCash: 100_000 });
    sim.openSession("2024-03-14", [bar()]);
    await sim.submitOrder(request({ kind: "limit", limitPrice: 90, quantity: 500, timeInForce: "gtc" }));
    const account = await sim.getAccount();
    assert.equal(account.cash, 100_000, "nothing has filled yet");
    assert.equal(account.buyingPower, 55_000, "but 45,000 is spoken for");
  });
});

describe("submission hygiene", () => {
  it("treats a repeated client order id as the same order", async () => {
    const sim = broker();
    sim.openSession("2024-03-14", [bar()]);
    const first = await sim.submitOrder(request());
    const retry = await sim.submitOrder(request({ quantity: 999 }));
    assert.equal(retry.brokerOrderId, first.brokerOrderId);
    assert.equal(retry.quantity, 100, "a retry must not become a second position");
    assert.equal((await sim.listOpenOrders()).length, 1);
  });

  it("rejects orders that are not well formed", async () => {
    const sim = broker();
    sim.openSession("2024-03-14", [bar()]);
    await assert.rejects(() => sim.submitOrder(request({ quantity: 0 })), /positive whole number/);
    await assert.rejects(() => sim.submitOrder(request({ quantity: 10.5 })), /positive whole number/);
    await assert.rejects(
      () => sim.submitOrder(request({ clientOrderId: "x", kind: "limit" })),
      /needs a positive limit price/,
    );
  });

  it("refuses to accept an order before any session is open", async () => {
    const sim = broker();
    await assert.rejects(() => sim.submitOrder(request()), /No session is open/);
  });

  it("cancels a working order and stops filling it", async () => {
    const sim = broker();
    sim.openSession("2024-03-14", [bar()]);
    const ack = await sim.submitOrder(request({ timeInForce: "gtc" }));
    await sim.cancelOrder(ack.brokerOrderId);
    const fills = sim.openSession("2024-03-15", [bar({ sessionDate: "2024-03-15" })]);
    assert.equal(fills.length, 0);
    assert.deepEqual(await sim.listOpenOrders(), []);
  });
});

describe("determinism", () => {
  it("produces identical fills from identical input", async () => {
    const run = async (): Promise<string> => {
      const sim = new SimBroker({ startingCash: 500_000, maxParticipation: 0.05 });
      sim.openSession("2024-03-14", [bar()]);
      await sim.submitOrder(request({ clientOrderId: "a", quantity: 40_000, timeInForce: "gtc" }));
      await sim.submitOrder(request({ clientOrderId: "b", quantity: 5_000, side: "sell", timeInForce: "gtc" }));
      for (const [i, date] of ["2024-03-15", "2024-03-18", "2024-03-19"].entries()) {
        sim.openSession(date, [bar({ sessionDate: date, open: 100 + i, volume: 200_000 })]);
      }
      return JSON.stringify(sim.allFills());
    };
    assert.equal(await run(), await run());
  });
});

describe("the execution gate", () => {
  const approval = (overrides: Partial<RiskApproval> = {}): RiskApproval => ({
    id: "risk-1",
    symbol: "TEST",
    side: "buy",
    approvedQuantity: 100,
    decision: "approve",
    ...overrides,
  });

  const guards = (overrides: Partial<ExecutionGuards> = {}): ExecutionGuards => ({
    isKillSwitchTripped: () => false,
    lookupRiskApproval: (id) => (id === "risk-1" ? approval() : null),
    ...overrides,
  });

  const gated = (g: ExecutionGuards) => {
    const sim = broker();
    sim.openSession("2024-03-14", [bar()]);
    return { sim, api: guardedBroker(sim, g) };
  };

  const refusal = async (fn: () => Promise<unknown>): Promise<OrderRefusedError> => {
    try {
      await fn();
    } catch (error) {
      assert.ok(error instanceof OrderRefusedError, `expected a refusal, got ${String(error)}`);
      return error;
    }
    assert.fail("expected the order to be refused");
  };

  it("lets a properly authorised order through", async () => {
    const { api } = gated(guards());
    const ack = await api.submitOrder(request());
    assert.equal(ack.status, "accepted");
  });

  it("blocks everything new while the kill switch is tripped", async () => {
    const { api } = gated(guards({ isKillSwitchTripped: () => true }));
    assert.equal((await refusal(() => api.submitOrder(request()))).code, "kill_switch_tripped");
  });

  it("still allows a cancel while the kill switch is tripped", async () => {
    // Blocking cancels during a kill-switch event would trap working orders in
    // the market at the exact moment someone decided to stop trading.
    const { sim, api } = gated(guards());
    const ack = await api.submitOrder(request({ timeInForce: "gtc" }));
    const stopped = guardedBroker(sim, guards({ isKillSwitchTripped: () => true }));
    const cancelled = await stopped.cancelOrder(ack.brokerOrderId);
    assert.equal(cancelled.status, "cancelled");
  });

  it("refuses an order with no risk evaluation", async () => {
    const { api } = gated(guards());
    assert.equal(
      (await refusal(() => api.submitOrder(request({ riskEvaluationId: "" })))).code,
      "missing_risk_evaluation",
    );
    assert.equal(
      (await refusal(() => api.submitOrder(request({ riskEvaluationId: "invented" })))).code,
      "unknown_risk_evaluation",
    );
  });

  it("refuses an order larger than the risk engine approved", async () => {
    const { api } = gated(guards());
    const error = await refusal(() => api.submitOrder(request({ quantity: 101 })));
    assert.equal(error.code, "exceeds_approved_quantity");
    // One share under is fine — the cap is a ceiling, not a target.
    assert.equal((await api.submitOrder(request({ quantity: 99 }))).quantity, 99);
  });

  it("refuses an approval issued for a different symbol or direction", async () => {
    const { api } = gated(guards());
    assert.equal(
      (await refusal(() => api.submitOrder(request({ symbol: "OTHER" })))).code,
      "approval_mismatch",
    );
    assert.equal(
      (await refusal(() => api.submitOrder(request({ side: "sell" })))).code,
      "approval_mismatch",
    );
  });

  it("refuses an approval the risk engine rejected", async () => {
    const { api } = gated(
      guards({ lookupRiskApproval: () => approval({ decision: "reject", approvedQuantity: 0 }) }),
    );
    assert.equal((await refusal(() => api.submitOrder(request()))).code, "risk_rejected");
  });

  it("refuses a stale approval", async () => {
    // Sizing computed against last week's equity is not sizing for today.
    const { api } = gated(
      guards({
        lookupRiskApproval: () => approval({ expiresAt: new Date("2024-03-14T15:00:00Z") }),
        now: () => new Date("2024-03-14T16:00:00Z"),
      }),
    );
    assert.equal((await refusal(() => api.submitOrder(request()))).code, "approval_expired");
  });

  it("does not let the guarded order reach the simulator at all", async () => {
    const { sim, api } = gated(guards({ isKillSwitchTripped: () => true }));
    await refusal(() => api.submitOrder(request()));
    assert.deepEqual(await sim.listOpenOrders(), [], "a refused order leaves no trace downstream");
  });
});
