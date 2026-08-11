/**
 * Risk engine types.
 *
 * The engine is a pure function with no model calls and no I/O. An LLM produces
 * an *intent*; only this produces a ruling; and the database refuses any order
 * whose approved quantity does not match the ruling. That chain is what makes
 * "the AI cannot overrule risk limits" a structural property rather than a
 * promise.
 */

export type MandateKind = "active" | "catalyst" | "long_term";
export type Side = "buy" | "sell";

/** What the strategy (or a human, or a model) wants to do. */
export interface OrderIntent {
  mandate: MandateKind;
  side: Side;
  symbol: string;
  sector: string | null;
  /** Intended entry. For a market order, the last trade. */
  entryPrice: number;
  /** Where the thesis is wrong. Required for a buy — a position with no
   *  defined invalidation has undefined downside and cannot be sized. */
  stopPrice: number | null;
  targetPrice: number | null;
  /** Conviction tier. Bounded multipliers, never unbounded. */
  tier: ConvictionTier;
  /** Set when the position closes on a scheduled binary event (readout, PDUFA,
   *  earnings) — a stop does not protect against an overnight gap through it. */
  isBinaryEvent: boolean;
}

export type ConvictionTier = "experimental" | "standard" | "high" | "exceptional";

export interface ExistingPosition {
  symbol: string;
  sector: string | null;
  mandate: MandateKind;
  marketValue: number;
  /** Dollars at risk: (price − stop) × shares. Zero when no stop is set — a
   *  long-term holding with no stop contributes exposure but not open risk. */
  openRisk: number;
  isBinaryEvent: boolean;
}

export interface PortfolioState {
  totalEquity: number;
  cash: number;
  /** Per-mandate equity, so each mandate's risk budget is its own. */
  mandateEquity: Record<MandateKind, number>;
  positions: readonly ExistingPosition[];
  /** Distance below the high-water mark, as a positive fraction. 0.12 = 12% down. */
  drawdown: number;
  /** Realised + unrealised for the current session, signed. */
  dayPnl: number;
  openPositionCount: number;
}

export interface MarketState {
  /** 20-day average dollar volume, for the liquidity cap. */
  averageDollarVolume: number;
  /** Quoted spread as a fraction of price. 0.001 = 10bp. */
  spreadFraction: number;
  /** Average true range as a fraction of price, for volatility sizing. */
  atrFraction: number;
  /** Measured expectancy in R for this setup in this regime, when a
   *  statistically meaningful sample exists. */
  expectancyR: number | null;
  /** How many historical instances back that expectancy. */
  sampleSize: number;
}

export interface RiskLimits {
  /** Fraction of MANDATE equity risked on one trade at standard conviction. */
  baseRiskPerTrade: number;
  /** Ceiling on risk per trade after every multiplier. */
  maxRiskPerTrade: number;
  maxPositionWeight: number;
  maxSectorWeight: number;
  maxMandateWeight: number;
  /** Ceiling on total open risk across the portfolio. */
  maxPortfolioHeat: number;
  /** Ceiling on combined exposure to scheduled binary events. */
  maxBinaryEventWeight: number;
  maxOpenPositions: number;
  /** Position may not exceed this fraction of 20-day average dollar volume. */
  maxParticipation: number;
  minDollarVolume: number;
  maxSpreadFraction: number;
  /** Session loss (as a fraction of equity) that halts new risk. */
  dailyLossLimit: number;
  /** Drawdown beyond which no new positions are opened at all. */
  maxDrawdown: number;
  /** Minimum cash fraction to preserve. */
  minCashFraction: number;
  /** Minimum out-of-sample instances before measured expectancy may raise size. */
  minSampleForEdge: number;
}

export type RiskDecision = "approve" | "reduce" | "reject";

export interface Violation {
  /** Machine-readable so the UI can group and the tests can assert. */
  code: string;
  /** Written for a person reading it months later, not for a log parser. */
  message: string;
  /** Set when the rule shrank the position rather than blocking it. */
  cappedQuantityTo?: number;
}

export interface RiskEvaluation {
  decision: RiskDecision;
  /** Shares the engine will permit. Zero on reject. */
  approvedQuantity: number;
  /** Dollars genuinely at risk at that size. */
  riskAmount: number;
  violations: Violation[];
  /** Every step that touched the size, in order — this is what makes
   *  "why is my position this small?" answerable. */
  reasoning: string[];
  engineVersion: string;
}
