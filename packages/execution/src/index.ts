export {
  OrderLedger,
  OrderLifecycleError,
  type IncomingFill,
  type LotPlan,
  type OrderIntent,
  type OrderStatus,
  type PostFillOptions,
  type PostedFill,
  type RiskDecision,
  type RiskRuling,
  type RiskRulingResult,
  type Side,
} from "./ledger.ts";

export {
  InsufficientLotsError,
  allocateAcrossLots,
  selectOpenLots,
  type LotAllocation,
  type LotMethod,
  type OpenLot,
} from "./lots.ts";

export {
  reconcile,
  type Discrepancy,
  type DiscrepancyKind,
  type ExternalPosition,
  type ReconciliationReport,
} from "./reconcile.ts";

export {
  AlpacaBroker,
  ALPACA_LIVE_URL,
  ALPACA_PAPER_URL,
  toOrderState,
  type AlpacaBrokerOptions,
  type AlpacaOrder,
} from "./alpaca.ts";

export { pollFills, streamFills, type FillSourceOptions } from "./fills.ts";

export {
  SelfCrossError,
  assertNoSelfCross,
  findSelfCrosses,
  type SelfCross,
} from "./selfcross.ts";

export { runSession, type LoopOptions, type LoopOutcome } from "./loop.ts";
export {
  killSwitchState,
  isKillSwitchTripped,
  resetKillSwitch,
  tripKillSwitch,
  type KillSwitchState,
} from "./killswitch.ts";
export { equityCurve, snapshotEquity, type MandateSnapshot } from "./equity.ts";
export {
  currentStanding,
  promoteStrategy,
  registerStrategy,
  type RegisteredStrategy,
} from "./strategy-registry.ts";
export {
  allocateByTargetWeight,
  capitalPosition,
  recordDeposit,
  type CapitalPosition,
} from "./capital.ts";
