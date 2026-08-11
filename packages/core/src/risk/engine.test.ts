/**
 * Risk engine tests.
 *
 * This is the component where a bug costs money rather than time, so it gets
 * both hand-written cases for the rules and property-based fuzzing for the
 * invariants. Hand-written tests only cover the situations I thought of; the
 * property tests cover the ones I did not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, evaluate } from "./engine.ts";
import type {
  ExistingPosition,
  MarketState,
  OrderIntent,
  PortfolioState,
  RiskLimits,
} from "./types.ts";

const intent = (overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  mandate: "active",
  side: "buy",
  symbol: "NVDA",
  sector: "Information Technology",
  entryPrice: 100,
  stopPrice: 95,
  targetPrice: 120,
  tier: "standard",
  isBinaryEvent: false,
  ...overrides,
});

const portfolio = (overrides: Partial<PortfolioState> = {}): PortfolioState => ({
  totalEquity: 100_000,
  cash: 50_000,
  mandateEquity: { active: 30_000, catalyst: 35_000, long_term: 35_000 },
  positions: [],
  drawdown: 0,
  dayPnl: 0,
  openPositionCount: 0,
  ...overrides,
});

const market = (overrides: Partial<MarketState> = {}): MarketState => ({
  averageDollarVolume: 500_000_000,
  spreadFraction: 0.0005,
  atrFraction: 0.02,
  expectancyR: null,
  sampleSize: 0,
  ...overrides,
});

const position = (overrides: Partial<ExistingPosition> = {}): ExistingPosition => ({
  symbol: "XXX",
  sector: "Information Technology",
  mandate: "active",
  marketValue: 10_000,
  openRisk: 500,
  isBinaryEvent: false,
  ...overrides,
});

describe("hard gates", () => {
  it("refuses an active trade with no stop", () => {
    const result = evaluate(intent({ stopPrice: null }), portfolio(), market());
    assert.equal(result.decision, "reject");
    assert.equal(result.violations[0]!.code, "no_invalidation");
  });

  it("refuses a stop that is not below entry", () => {
    const result = evaluate(intent({ stopPrice: 100 }), portfolio(), market());
    assert.equal(result.violations[0]!.code, "stop_above_entry");
  });

  it("halts new risk once the daily loss limit is hit", () => {
    const result = evaluate(intent(), portfolio({ dayPnl: -3_000 }), market());
    assert.equal(result.decision, "reject");
    assert.equal(result.violations[0]!.code, "daily_loss_limit");
  });

  it("halts entirely at the maximum drawdown", () => {
    const result = evaluate(intent(), portfolio({ drawdown: 0.2 }), market());
    assert.equal(result.decision, "reject");
    assert.equal(result.violations[0]!.code, "max_drawdown");
  });

  it("refuses illiquid names outright rather than sizing them down", () => {
    // Not "size it smaller" — the exit will not be there when it is needed.
    const result = evaluate(intent(), portfolio(), market({ averageDollarVolume: 500_000 }));
    assert.equal(result.decision, "reject");
    assert.equal(result.violations[0]!.code, "illiquid");
  });

  it("refuses a spread wide enough to eat the edge", () => {
    const result = evaluate(intent(), portfolio(), market({ spreadFraction: 0.02 }));
    assert.equal(result.violations[0]!.code, "wide_spread");
  });
});

describe("exits are never blocked", () => {
  it("permits a sell even at the daily loss limit and max drawdown", () => {
    // Blocking an exit would trap the very position that caused the limit.
    const held = [position({ symbol: "NVDA", mandate: "active", marketValue: 10_000 })];
    const result = evaluate(
      intent({ side: "sell" }),
      portfolio({ dayPnl: -9_000, drawdown: 0.35, positions: held }),
      market(),
    );
    assert.equal(result.decision, "approve");
    assert.equal(result.approvedQuantity, 100);
  });
});

describe("sizing", () => {
  it("sizes from the stop distance, not from the price", () => {
    // 30,000 mandate equity x 1% = 300 risk; 5 wide stop => 60 shares.
    const result = evaluate(intent(), portfolio(), market());
    assert.equal(result.approvedQuantity, 60);
    assert.equal(result.riskAmount, 300);
  });

  it("gives an experimental idea a quarter of standard size", () => {
    const result = evaluate(intent({ tier: "experimental" }), portfolio(), market());
    assert.equal(result.approvedQuantity, 15);
  });

  it("caps even exceptional conviction below the per-trade ceiling", () => {
    const result = evaluate(intent({ tier: "exceptional" }), portfolio(), market());
    // 1.5x standard = 1.5% of 30,000 = 450 risk, still under the 2% ceiling.
    assert.equal(result.riskAmount, 450);
    assert.ok(result.riskAmount <= DEFAULT_LIMITS.maxRiskPerTrade * 30_000);
  });

  it("halves size when the sample behind an edge is too thin to trust", () => {
    const result = evaluate(
      intent(),
      portfolio(),
      market({ expectancyR: 0.9, sampleSize: 5 }),
    );
    assert.equal(result.approvedQuantity, 30, "an impressive edge over 5 trades is not an edge");
    assert.ok(result.violations.some((v) => v.code === "thin_sample"));
  });

  it("allows a measured edge to raise size only on a real sample", () => {
    const result = evaluate(
      intent(),
      portfolio(),
      market({ expectancyR: 0.5, sampleSize: 120 }),
    );
    assert.equal(result.approvedQuantity, 72, "1.2x on a 120-instance sample");
  });

  it("cuts size when measured expectancy is not positive", () => {
    const result = evaluate(
      intent(),
      portfolio(),
      market({ expectancyR: -0.1, sampleSize: 200 }),
    );
    assert.equal(result.approvedQuantity, 30);
  });
});

describe("drawdown ladder", () => {
  const cases: Array<[number, number]> = [
    [0, 60],
    [0.06, 45],
    [0.12, 30],
    [0.17, 15],
  ];

  for (const [drawdown, expected] of cases) {
    it(`sizes ${expected} shares at ${(drawdown * 100).toFixed(0)}% drawdown`, () => {
      const result = evaluate(intent(), portfolio({ drawdown }), market());
      assert.equal(result.approvedQuantity, expected);
    });
  }

  it("never increases size as drawdown deepens", () => {
    // The property that makes a losing streak decay instead of compound.
    let previous = Number.POSITIVE_INFINITY;
    for (let dd = 0; dd < 0.2; dd += 0.01) {
      const result = evaluate(intent(), portfolio({ drawdown: dd }), market());
      assert.ok(
        result.approvedQuantity <= previous,
        `size rose from ${previous} to ${result.approvedQuantity} at drawdown ${dd.toFixed(2)}`,
      );
      previous = result.approvedQuantity;
    }
  });
});

describe("concentration caps", () => {
  it("caps a position at the maximum weight", () => {
    // A 1-cent stop would otherwise imply an enormous position.
    const result = evaluate(intent({ stopPrice: 99.99 }), portfolio(), market());
    assert.equal(result.decision, "reduce");
    assert.ok(result.violations.some((v) => v.code === "max_position_weight"));
    assert.ok(result.approvedQuantity * 100 <= DEFAULT_LIMITS.maxPositionWeight * 100_000 + 100);
  });

  it("rejects when the sector is already at its cap", () => {
    const positions = [position({ marketValue: 30_000, sector: "Information Technology" })];
    const result = evaluate(intent(), portfolio({ positions }), market());
    assert.equal(result.decision, "reject");
    assert.equal(result.violations[0]!.code, "sector_cap");
  });

  it("rejects when open risk across the book is already at the ceiling", () => {
    const positions = [position({ openRisk: 6_000, sector: "Health Care" })];
    const result = evaluate(intent(), portfolio({ positions }), market());
    assert.equal(result.decision, "reject");
    assert.equal(result.violations[0]!.code, "portfolio_heat");
  });

  it("caps binary-event exposure separately, because a stop cannot span a gap", () => {
    const positions = [
      position({ marketValue: 14_000, isBinaryEvent: true, sector: "Health Care" }),
    ];
    const result = evaluate(
      intent({ isBinaryEvent: true, sector: "Health Care", mandate: "catalyst" }),
      portfolio({ positions }),
      market(),
    );
    assert.ok(result.violations.some((v) => v.code === "binary_event_cap"));
    assert.ok(result.approvedQuantity * 100 <= 1_000 + 100);
  });

  it("caps by participation so the exit stays available", () => {
    const result = evaluate(intent(), portfolio(), market({ averageDollarVolume: 100_000 }));
    // Below the liquidity floor entirely, so this rejects rather than caps.
    assert.equal(result.decision, "reject");

    const thin = evaluate(intent(), portfolio(), market({ averageDollarVolume: 10_000_000 }));
    assert.ok(thin.approvedQuantity * 100 <= 0.02 * 10_000_000);
  });
});

describe("explainability", () => {
  it("records every step that touched the size", () => {
    // "Why is my position this small?" must be answerable months later.
    const result = evaluate(
      intent({ tier: "high" }),
      portfolio({ drawdown: 0.12 }),
      market({ expectancyR: 0.4, sampleSize: 60 }),
    );
    assert.ok(result.reasoning.length >= 4);
    assert.ok(result.reasoning.some((r) => r.includes("base risk")));
    assert.ok(result.reasoning.some((r) => r.includes("high tier")));
    assert.ok(result.reasoning.some((r) => r.includes("drawdown")));
  });

  it("explains a rejection in words a person can act on", () => {
    const result = evaluate(intent(), portfolio({ openPositionCount: 12 }), market());
    assert.match(result.violations[0]!.message, /maximum/i);
    assert.match(result.violations[0]!.message, /Close something/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("property: hard caps hold for arbitrary inputs", () => {
  /** Deterministic PRNG so a failure is reproducible from its seed. */
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  it("never exceeds any hard limit across 4000 random scenarios", () => {
    const random = rng(20260811);
    const limits: RiskLimits = DEFAULT_LIMITS;
    let approvals = 0;

    for (let i = 0; i < 4000; i++) {
      const equity = 5_000 + random() * 2_000_000;
      const price = 1 + random() * 900;
      // Stop distance from a hair to a third of the price — including values
      // that would imply absurd size if any cap failed to bind.
      const stopDistance = Math.max(0.01, price * (0.0001 + random() * 0.33));

      const existing: ExistingPosition[] = Array.from(
        { length: Math.floor(random() * 5) },
        () =>
          position({
            marketValue: random() * equity * 0.1,
            openRisk: random() * equity * 0.01,
            sector: random() > 0.5 ? "Information Technology" : "Health Care",
            isBinaryEvent: random() > 0.7,
          }),
      );

      const p = portfolio({
        totalEquity: equity,
        cash: random() * equity,
        mandateEquity: {
          active: equity * 0.3,
          catalyst: equity * 0.35,
          long_term: equity * 0.35,
        },
        positions: existing,
        drawdown: random() * 0.19,
        dayPnl: (random() - 0.7) * equity * 0.02,
        openPositionCount: existing.length,
      });

      const m = market({
        averageDollarVolume: 1_000_000 + random() * 900_000_000,
        spreadFraction: random() * 0.004,
        atrFraction: 0.005 + random() * 0.08,
        expectancyR: random() > 0.5 ? (random() - 0.4) * 2 : null,
        sampleSize: Math.floor(random() * 300),
      });

      const tiers = ["experimental", "standard", "high", "exceptional"] as const;
      const result = evaluate(
        intent({
          entryPrice: price,
          stopPrice: price - stopDistance,
          tier: tiers[Math.floor(random() * 4)]!,
          isBinaryEvent: random() > 0.7,
          sector: random() > 0.5 ? "Information Technology" : "Health Care",
        }),
        p,
        m,
        limits,
      );

      const context = `scenario ${i}: equity=${equity.toFixed(0)} price=${price.toFixed(2)} stop=${stopDistance.toFixed(4)}`;

      assert.ok(result.approvedQuantity >= 0, `${context} — negative quantity`);
      assert.ok(Number.isInteger(result.approvedQuantity), `${context} — fractional shares`);
      assert.ok(Number.isFinite(result.riskAmount), `${context} — non-finite risk`);

      if (result.decision === "reject") {
        assert.equal(result.approvedQuantity, 0, `${context} — rejected but sized`);
        continue;
      }
      approvals++;

      // The invariants that matter. A tiny epsilon absorbs float noise only.
      const eps = 1e-6;
      assert.ok(
        result.riskAmount <= limits.maxRiskPerTrade * p.mandateEquity[intent().mandate] + price + eps,
        `${context} — risk ${result.riskAmount} exceeded the per-trade ceiling`,
      );
      assert.ok(
        result.approvedQuantity * price <= limits.maxPositionWeight * equity + price + eps,
        `${context} — position exceeded the max weight`,
      );
      assert.ok(
        result.approvedQuantity * price <=
          limits.maxParticipation * m.averageDollarVolume + price + eps,
        `${context} — position exceeded the participation cap`,
      );
      assert.ok(
        result.approvedQuantity * price <= p.cash + price + eps,
        `${context} — position exceeded available cash`,
      );
    }

    // A property test that approves nothing proves nothing.
    assert.ok(approvals > 400, `only ${approvals} approvals — the generator is too restrictive`);
  });
});
