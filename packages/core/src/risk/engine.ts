import type {
  ConvictionTier,
  MarketState,
  OrderIntent,
  PortfolioState,
  RiskEvaluation,
  RiskLimits,
  Violation,
} from "./types.ts";

export const ENGINE_VERSION = "risk@1.0.0";

/**
 * Conviction tiers scale risk within hard bounds. Note the ceiling: even
 * "exceptional" is 1.5x standard, not unbounded, because no single idea —
 * however good it looks — may be allowed to threaten the account. Experimental
 * ideas are deliberately tiny; that is how an unproven setup earns a sample
 * without costing much to be wrong about.
 */
const TIER_MULTIPLIER: Record<ConvictionTier, number> = {
  experimental: 0.25,
  standard: 1.0,
  high: 1.25,
  exceptional: 1.5,
};

/**
 * Risk shrinks as drawdown deepens. This is the single most important rule for
 * surviving a losing streak: it makes the position size a decreasing function
 * of how wrong things have been going, so a bad run decays rather than
 * compounds. Deliberately a step function — a smooth curve invites arguing
 * about the boundary mid-drawdown, which is exactly when judgment is worst.
 */
function drawdownMultiplier(drawdown: number): { factor: number; label: string } {
  if (drawdown >= 0.2) return { factor: 0, label: "drawdown ≥20%: no new risk" };
  if (drawdown >= 0.15) return { factor: 0.25, label: "drawdown ≥15%: quarter risk" };
  if (drawdown >= 0.1) return { factor: 0.5, label: "drawdown ≥10%: half risk" };
  if (drawdown >= 0.05) return { factor: 0.75, label: "drawdown ≥5%: three-quarter risk" };
  return { factor: 1, label: "drawdown normal: full risk" };
}

export const DEFAULT_LIMITS: RiskLimits = {
  baseRiskPerTrade: 0.01,
  maxRiskPerTrade: 0.02,
  maxPositionWeight: 0.15,
  maxSectorWeight: 0.3,
  maxMandateWeight: 0.5,
  maxPortfolioHeat: 0.06,
  maxBinaryEventWeight: 0.15,
  maxOpenPositions: 12,
  maxParticipation: 0.02,
  minDollarVolume: 2_000_000,
  maxSpreadFraction: 0.005,
  dailyLossLimit: 0.03,
  maxDrawdown: 0.2,
  minCashFraction: 0.02,
  minSampleForEdge: 30,
};

/**
 * The only thing permitted to authorise a trade.
 *
 * Structure: hard gates first (conditions under which no size is acceptable),
 * then a sizing pipeline in which every step may only *reduce* the quantity.
 * That monotonicity is what makes the property test meaningful — no ordering of
 * inputs can produce a size above a cap, because no step can ever increase one.
 */
export function evaluate(
  intent: OrderIntent,
  portfolio: PortfolioState,
  market: MarketState,
  limits: RiskLimits = DEFAULT_LIMITS,
): RiskEvaluation {
  const violations: Violation[] = [];
  const reasoning: string[] = [];

  const reject = (code: string, message: string): RiskEvaluation => {
    violations.push({ code, message });
    return {
      decision: "reject",
      approvedQuantity: 0,
      riskAmount: 0,
      violations,
      reasoning,
      engineVersion: ENGINE_VERSION,
    };
  };

  // ── Sells: reducing exposure is always permitted ────────────────────────
  // Blocking an exit because of a risk limit would trap the position that
  // triggered the limit. The database separately guarantees a sell can only
  // touch lots belonging to this mandate.
  if (intent.side === "sell") {
    const held = portfolio.positions
      .filter((p) => p.symbol === intent.symbol && p.mandate === intent.mandate)
      .reduce((sum, p) => sum + p.marketValue, 0);
    const quantity = intent.entryPrice > 0 ? held / intent.entryPrice : 0;
    reasoning.push("sell reduces exposure — permitted up to the position held");
    return {
      decision: "approve",
      approvedQuantity: quantity,
      riskAmount: 0,
      violations,
      reasoning,
      engineVersion: ENGINE_VERSION,
    };
  }

  // ── Hard gates ──────────────────────────────────────────────────────────
  if (portfolio.totalEquity <= 0) {
    return reject("no_equity", "Account has no equity.");
  }
  if (intent.entryPrice <= 0) {
    return reject("bad_price", "Entry price must be positive.");
  }
  if (portfolio.drawdown >= limits.maxDrawdown) {
    return reject(
      "max_drawdown",
      `Drawdown ${pct(portfolio.drawdown)} is at or beyond the ${pct(limits.maxDrawdown)} limit. No new positions until it recovers.`,
    );
  }
  if (portfolio.dayPnl < 0 && Math.abs(portfolio.dayPnl) >= limits.dailyLossLimit * portfolio.totalEquity) {
    return reject(
      "daily_loss_limit",
      `Down ${money(Math.abs(portfolio.dayPnl))} today, at the ${pct(limits.dailyLossLimit)} daily limit. Trading halted until tomorrow.`,
    );
  }
  if (portfolio.openPositionCount >= limits.maxOpenPositions) {
    return reject(
      "max_positions",
      `Already holding ${portfolio.openPositionCount} positions, the maximum. Close something first.`,
    );
  }

  // A trade with no defined invalidation has undefined downside. The Active
  // mandate never gets one; long-term accumulation legitimately does, and is
  // sized by weight instead of by stop distance.
  if (intent.stopPrice === null && intent.mandate === "active") {
    return reject(
      "no_invalidation",
      "An active trade needs a stop. Without one the downside is undefined and the position cannot be sized.",
    );
  }
  if (intent.stopPrice !== null && intent.stopPrice >= intent.entryPrice) {
    return reject(
      "stop_above_entry",
      `Stop ${money(intent.stopPrice)} is at or above entry ${money(intent.entryPrice)} — that is not a stop.`,
    );
  }

  // ── Liquidity ───────────────────────────────────────────────────────────
  // Checked before sizing: an illiquid name is not "size it smaller", it is
  // "the exit will not be there when it is needed".
  if (market.averageDollarVolume < limits.minDollarVolume) {
    return reject(
      "illiquid",
      `Average daily volume ${money(market.averageDollarVolume)} is below the ${money(limits.minDollarVolume)} minimum. Getting out could cost more than the trade is worth.`,
    );
  }
  if (market.spreadFraction > limits.maxSpreadFraction) {
    return reject(
      "wide_spread",
      `Spread ${pct(market.spreadFraction)} exceeds the ${pct(limits.maxSpreadFraction)} maximum.`,
    );
  }

  const mandateEquity = portfolio.mandateEquity[intent.mandate];
  if (mandateEquity <= 0) {
    return reject("no_mandate_capital", `The ${intent.mandate} mandate has no capital allocated.`);
  }

  // ── Sizing pipeline. Each step may only reduce. ─────────────────────────

  // 1. Base risk budget for this trade.
  let riskFraction = limits.baseRiskPerTrade;
  reasoning.push(`base risk ${pct(riskFraction)} of ${intent.mandate} equity`);

  // 2. Conviction tier.
  const tierFactor = TIER_MULTIPLIER[intent.tier];
  riskFraction *= tierFactor;
  reasoning.push(`${intent.tier} tier ×${tierFactor} → ${pct(riskFraction)}`);

  // 3. Measured edge may raise risk only on a real sample. Model confidence
  //    never enters here — only out-of-sample expectancy with enough instances
  //    behind it, and even then capped.
  if (market.expectancyR !== null && market.sampleSize >= limits.minSampleForEdge) {
    if (market.expectancyR > 0.3) {
      riskFraction *= 1.2;
      reasoning.push(
        `measured edge +${market.expectancyR.toFixed(2)}R over ${market.sampleSize} instances ×1.2 → ${pct(riskFraction)}`,
      );
    } else if (market.expectancyR <= 0) {
      riskFraction *= 0.5;
      reasoning.push(
        `measured expectancy is not positive (${market.expectancyR.toFixed(2)}R) ×0.5 → ${pct(riskFraction)}`,
      );
    }
  } else if (market.expectancyR !== null) {
    violations.push({
      code: "thin_sample",
      message: `Only ${market.sampleSize} historical instances — below the ${limits.minSampleForEdge} needed to trust the expectancy. Sized as unproven.`,
    });
    riskFraction *= 0.5;
    reasoning.push(`thin sample ×0.5 → ${pct(riskFraction)}`);
  }

  // 4. Drawdown ladder.
  const dd = drawdownMultiplier(portfolio.drawdown);
  if (dd.factor === 0) {
    return reject("drawdown_halt", `${dd.label} (currently ${pct(portfolio.drawdown)}).`);
  }
  riskFraction *= dd.factor;
  if (dd.factor < 1) reasoning.push(`${dd.label} ×${dd.factor} → ${pct(riskFraction)}`);

  // 5. Hard ceiling on risk per trade, whatever the multipliers produced.
  if (riskFraction > limits.maxRiskPerTrade) {
    violations.push({
      code: "max_risk_per_trade",
      message: `Risk capped at ${pct(limits.maxRiskPerTrade)} per trade.`,
    });
    riskFraction = limits.maxRiskPerTrade;
    reasoning.push(`capped at ${pct(riskFraction)}`);
  }

  const riskDollars = mandateEquity * riskFraction;

  // 6. Convert risk into shares via the stop distance, or via volatility when
  //    there is no stop (long-term accumulation).
  const stopDistance =
    intent.stopPrice !== null
      ? intent.entryPrice - intent.stopPrice
      : intent.entryPrice * Math.max(market.atrFraction, 0.01) * 2;

  if (stopDistance <= 0) {
    return reject("zero_stop_distance", "Stop distance is zero — position size would be unbounded.");
  }

  let quantity = riskDollars / stopDistance;
  reasoning.push(
    `${money(riskDollars)} risk ÷ ${money(stopDistance)} stop distance = ${Math.floor(quantity)} shares`,
  );

  // 7. Concentration caps.
  quantity = capBy(
    quantity,
    (limits.maxPositionWeight * portfolio.totalEquity) / intent.entryPrice,
    "max_position_weight",
    `Position capped at ${pct(limits.maxPositionWeight)} of equity.`,
    violations,
    reasoning,
  );

  if (intent.sector) {
    const sectorValue = portfolio.positions
      .filter((p) => p.sector === intent.sector)
      .reduce((sum, p) => sum + p.marketValue, 0);
    const headroom = limits.maxSectorWeight * portfolio.totalEquity - sectorValue;
    if (headroom <= 0) {
      return reject(
        "sector_cap",
        `${intent.sector} is already at ${pct(sectorValue / portfolio.totalEquity)} of the portfolio, at the ${pct(limits.maxSectorWeight)} cap.`,
      );
    }
    quantity = capBy(
      quantity,
      headroom / intent.entryPrice,
      "sector_cap",
      `Capped by remaining ${intent.sector} headroom.`,
      violations,
      reasoning,
    );
  }

  const mandateValue = portfolio.positions
    .filter((p) => p.mandate === intent.mandate)
    .reduce((sum, p) => sum + p.marketValue, 0);
  const mandateHeadroom = limits.maxMandateWeight * portfolio.totalEquity - mandateValue;
  if (mandateHeadroom <= 0) {
    return reject(
      "mandate_cap",
      `The ${intent.mandate} mandate is at its ${pct(limits.maxMandateWeight)} allocation cap.`,
    );
  }
  quantity = capBy(
    quantity,
    mandateHeadroom / intent.entryPrice,
    "mandate_cap",
    `Capped by remaining ${intent.mandate} allocation.`,
    violations,
    reasoning,
  );

  // 8. Portfolio heat — total open risk, not total exposure. This is the limit
  //    that governs how many things can go wrong at once.
  const currentHeat = portfolio.positions.reduce((sum, p) => sum + p.openRisk, 0);
  const heatHeadroom = limits.maxPortfolioHeat * portfolio.totalEquity - currentHeat;
  if (heatHeadroom <= 0) {
    return reject(
      "portfolio_heat",
      `Open risk across the book is already ${pct(currentHeat / portfolio.totalEquity)}, at the ${pct(limits.maxPortfolioHeat)} ceiling.`,
    );
  }
  quantity = capBy(
    quantity,
    heatHeadroom / stopDistance,
    "portfolio_heat",
    `Capped by remaining risk budget across the book.`,
    violations,
    reasoning,
  );

  // 9. Binary events. A stop does not protect against a gap through it
  //    overnight, so these are capped by exposure rather than by risk.
  if (intent.isBinaryEvent) {
    const binaryValue = portfolio.positions
      .filter((p) => p.isBinaryEvent)
      .reduce((sum, p) => sum + p.marketValue, 0);
    const binaryHeadroom = limits.maxBinaryEventWeight * portfolio.totalEquity - binaryValue;
    if (binaryHeadroom <= 0) {
      return reject(
        "binary_event_cap",
        `Binary-event exposure is at the ${pct(limits.maxBinaryEventWeight)} cap. A stop will not protect against an overnight gap.`,
      );
    }
    quantity = capBy(
      quantity,
      binaryHeadroom / intent.entryPrice,
      "binary_event_cap",
      "Capped by remaining binary-event exposure.",
      violations,
      reasoning,
    );
  }

  // 10. Liquidity participation — can we get out without moving the market?
  quantity = capBy(
    quantity,
    (limits.maxParticipation * market.averageDollarVolume) / intent.entryPrice,
    "participation_cap",
    `Capped at ${pct(limits.maxParticipation)} of average daily volume so the exit stays available.`,
    violations,
    reasoning,
  );

  // 11. Cash floor.
  const investableCash = portfolio.cash - limits.minCashFraction * portfolio.totalEquity;
  if (investableCash <= 0) {
    return reject(
      "cash_floor",
      `Cash ${money(portfolio.cash)} is at the ${pct(limits.minCashFraction)} minimum reserve.`,
    );
  }
  quantity = capBy(
    quantity,
    investableCash / intent.entryPrice,
    "cash_floor",
    "Capped by available cash above the minimum reserve.",
    violations,
    reasoning,
  );

  // Whole shares only. Flooring is the last operation so it can never round a
  // position back above a cap.
  quantity = Math.floor(quantity);

  if (quantity < 1) {
    return reject(
      "size_rounds_to_zero",
      "After every limit, the permitted size is less than one share. The idea may be sound; the position is not available at this account size.",
    );
  }

  const riskAmount = quantity * stopDistance;
  const decision = violations.some((v) => v.cappedQuantityTo !== undefined) ? "reduce" : "approve";

  return {
    decision,
    approvedQuantity: quantity,
    riskAmount,
    violations,
    reasoning,
    engineVersion: ENGINE_VERSION,
  };
}

/** Applies a cap, recording it only when it actually bound. */
function capBy(
  quantity: number,
  cap: number,
  code: string,
  message: string,
  violations: Violation[],
  reasoning: string[],
): number {
  if (cap >= quantity) return quantity;
  const capped = Math.max(0, cap);
  violations.push({ code, message, cappedQuantityTo: capped });
  reasoning.push(`${message} → ${Math.floor(capped)} shares`);
  return capped;
}

const pct = (n: number) => `${(n * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
