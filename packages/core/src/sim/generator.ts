/**
 * Synthetic market data with known ground truth.
 *
 * The point of this file is not to fake data because real data is unavailable.
 * It is that a backtester tested only against real prices can only ever be
 * checked for *plausibility* — you have no independent answer to compare
 * against, so a subtly wrong fill model or an off-by-one bar alignment looks
 * exactly like a mediocre strategy. Here the true drift, the true volatility,
 * the true regime label, and the true split-continuous price of every session
 * are known by construction, so correctness becomes a test rather than a
 * judgement call.
 *
 * Three properties are deliberate and load-bearing:
 *
 *   1. Prices are emitted RAW, exactly as a vendor sends them. A 4:1 split
 *      quarters the printed price and quadruples the printed volume. The
 *      continuous series is retained separately as truth, so the point-in-time
 *      adjustment layer can be checked for actually reconstructing it.
 *   2. Corporate actions carry an `announcedAt` strictly before their `exDate`.
 *      An adjustment applied using an action the market had not yet been told
 *      about is look-ahead bias, and this is what makes that testable.
 *   3. Bars are built from a simulated intrabar path, not from four independent
 *      draws. High and low therefore genuinely bound open and close, and VWAP
 *      genuinely falls inside the range — the same invariants `validateBar`
 *      enforces at ingestion. Data that could not exist teaches nothing.
 */

import { type IsoDate, tradingDaysFrom } from "../market/calendar.ts";
import { rng, type Rng } from "./random.ts";

export type RegimeKind =
  | "trend_up"
  | "trend_down"
  | "choppy"
  | "high_vol"
  | "crash"
  | "recovery";

export interface RegimeParams {
  /** Expected log return per session. 0.0009 ≈ +25% annualised. */
  drift: number;
  /** Standard deviation of the session's log return. */
  vol: number;
  /** Standard deviation of the overnight gap, as a log return. */
  gapVol: number;
  /** Pull back toward the price at the start of the regime. 0 = none. */
  meanReversion: number;
  /** Multiplier on baseline volume — panic and euphoria both trade heavy. */
  volumeFactor: number;
}

/**
 * Calibrated to look like US large-cap equities rather than to be dramatic:
 * ~14% annualised vol in a quiet uptrend, ~55% in a crash. Overstating
 * volatility makes stop-based strategies look worse than they are and
 * flatters mean-reversion, so these are kept honest.
 */
export const REGIME_PARAMS: Record<RegimeKind, RegimeParams> = {
  trend_up: { drift: 0.0009, vol: 0.0090, gapVol: 0.0035, meanReversion: 0, volumeFactor: 1.0 },
  trend_down: { drift: -0.0011, vol: 0.0140, gapVol: 0.0060, meanReversion: 0, volumeFactor: 1.2 },
  choppy: { drift: 0, vol: 0.0105, gapVol: 0.0030, meanReversion: 0.035, volumeFactor: 0.85 },
  high_vol: { drift: 0, vol: 0.0280, gapVol: 0.0130, meanReversion: 0.010, volumeFactor: 1.6 },
  crash: { drift: -0.0060, vol: 0.0350, gapVol: 0.0220, meanReversion: 0, volumeFactor: 2.4 },
  recovery: { drift: 0.0040, vol: 0.0210, gapVol: 0.0090, meanReversion: 0, volumeFactor: 1.5 },
};

export interface RegimeSegment {
  kind: RegimeKind;
  /** Length in trading sessions, not calendar days. */
  sessions: number;
}

export interface SplitSpec {
  /** Index of the session on which the split goes ex. */
  atSession: number;
  /** 4 means a 4-for-1: the printed price is divided by 4. */
  ratio: number;
  /** Sessions of warning the market gets. Must be at least 1. */
  announceLeadSessions: number;
}

export interface DividendSpec {
  atSession: number;
  /** Cash per share, in raw (post-split-at-that-time) terms. */
  amount: number;
  announceLeadSessions: number;
}

export interface SyntheticSpec {
  symbol: string;
  /** Same seed, same series — always, on any machine. */
  seed: number | string;
  /** First session. Rolled forward if it is not a trading day. */
  startDate: IsoDate;
  startPrice: number;
  regimes: readonly RegimeSegment[];
  /** Baseline shares per session before regime and shock multipliers. */
  baseVolume?: number;
  splits?: readonly SplitSpec[];
  dividends?: readonly DividendSpec[];
}

export interface SyntheticBar {
  symbol: string;
  sessionDate: IsoDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  vwap: number;
}

export interface SyntheticCorporateAction {
  symbol: string;
  kind: "split" | "cash_dividend";
  exDate: IsoDate;
  /** Timestamped after the close of the announcement session. */
  announcedAt: string;
  splitRatio?: number;
  cashAmount?: number;
}

/** What the generator knows and the strategy must not. */
export interface SessionTruth {
  sessionDate: IsoDate;
  sessionIndex: number;
  regime: RegimeKind;
  /**
   * The split-continuous close: what the raw close means once every split is
   * undone. Adjusting raw bars with full knowledge of corporate actions must
   * reproduce this series up to a single constant factor.
   */
  continuousClose: number;
  /** Cumulative split divisor in force on this session. */
  splitDivisor: number;
  expectedDrift: number;
  expectedVol: number;
}

export interface SyntheticSeries {
  symbol: string;
  bars: SyntheticBar[];
  corporateActions: SyntheticCorporateAction[];
  truth: SessionTruth[];
}

/** Sub-steps per session. Enough for a believable intrabar path, cheap to run. */
const INTRABAR_STEPS = 8;
/** No simulated instrument is allowed to become a sub-penny stock. */
const PRICE_FLOOR = 1;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function generateSeries(spec: SyntheticSpec): SyntheticSeries {
  const totalSessions = spec.regimes.reduce((sum, r) => sum + r.sessions, 0);
  if (totalSessions === 0) {
    return { symbol: spec.symbol, bars: [], corporateActions: [], truth: [] };
  }

  // Forked by symbol so a universe's members are independent of each other and
  // of the order they were requested in.
  const random: Rng = rng(spec.seed).fork(spec.symbol);
  const dates = tradingDaysFrom(spec.startDate, totalSessions);
  const baseVolume = spec.baseVolume ?? 3_000_000;

  const regimeAt: RegimeKind[] = [];
  for (const segment of spec.regimes) {
    for (let i = 0; i < segment.sessions; i += 1) regimeAt.push(segment.kind);
  }

  const splitsBySession = new Map<number, SplitSpec>();
  for (const split of spec.splits ?? []) splitsBySession.set(split.atSession, split);
  const dividendsBySession = new Map<number, DividendSpec>();
  for (const dividend of spec.dividends ?? []) dividendsBySession.set(dividend.atSession, dividend);

  const bars: SyntheticBar[] = [];
  const truth: SessionTruth[] = [];
  const corporateActions: SyntheticCorporateAction[] = [];

  // The continuous price is the real economic series; the divisor is the
  // bookkeeping the market applies on top of it.
  let continuousClose = spec.startPrice;
  let divisor = 1;
  let regimeAnchor = spec.startPrice;
  let previousRegime: RegimeKind | null = null;

  for (let index = 0; index < totalSessions; index += 1) {
    const sessionDate = dates[index] as IsoDate;
    const regime = regimeAt[index] as RegimeKind;
    const params = REGIME_PARAMS[regime];

    if (regime !== previousRegime) {
      // Mean reversion pulls toward wherever the regime found the price, not
      // toward a level chosen in advance.
      regimeAnchor = continuousClose;
      previousRegime = regime;
    }

    const split = splitsBySession.get(index);
    if (split) {
      divisor *= split.ratio;
      corporateActions.push({
        symbol: spec.symbol,
        kind: "split",
        exDate: sessionDate,
        announcedAt: announcementStamp(dates, index, split.announceLeadSessions),
        splitRatio: split.ratio,
      });
    }

    const dividend = dividendsBySession.get(index);
    if (dividend) {
      corporateActions.push({
        symbol: spec.symbol,
        kind: "cash_dividend",
        exDate: sessionDate,
        announcedAt: announcementStamp(dates, index, dividend.announceLeadSessions),
        cashAmount: dividend.amount,
      });
      // A cash dividend genuinely removes value from the share on the ex-date.
      continuousClose = Math.max(PRICE_FLOOR, continuousClose - dividend.amount * divisor);
    }

    const previousClose = continuousClose;

    const gap = random.normal() * params.gapVol;
    const openContinuous = Math.max(PRICE_FLOOR, previousClose * Math.exp(gap));

    const pull = params.meanReversion * Math.log(regimeAnchor / openContinuous);
    const driftStep = (params.drift + pull) / INTRABAR_STEPS;
    const volStep = params.vol / Math.sqrt(INTRABAR_STEPS);

    let price = openContinuous;
    let highContinuous = openContinuous;
    let lowContinuous = openContinuous;
    let vwapNumerator = 0;
    let vwapWeight = 0;

    for (let step = 0; step < INTRABAR_STEPS; step += 1) {
      price = Math.max(PRICE_FLOOR, price * Math.exp(driftStep + volStep * random.normal()));
      if (price > highContinuous) highContinuous = price;
      if (price < lowContinuous) lowContinuous = price;
      // Volume is not uniform across the session; weighting VWAP by a random
      // share of it keeps VWAP from collapsing onto the arithmetic midpoint.
      const weight = 0.5 + random.next();
      vwapNumerator += price * weight;
      vwapWeight += weight;
    }
    const closeContinuous = price;
    const vwapContinuous = vwapNumerator / vwapWeight;

    // Raw prints: what a vendor would actually send on this date.
    const open = round2(openContinuous / divisor);
    const close = round2(closeContinuous / divisor);
    // Rounding can push a 2dp close a cent outside a 2dp extreme, so the
    // extremes are reconciled after rounding rather than before.
    const high = Math.max(round2(highContinuous / divisor), open, close);
    const low = Math.min(round2(lowContinuous / divisor), open, close);
    const vwap = Math.min(high, Math.max(low, round2(vwapContinuous / divisor)));

    const sessionReturn = Math.log(closeContinuous / previousClose);
    // Heavy sessions are the ones that moved. |return| in units of the regime's
    // own volatility, so a 2% day is unremarkable in a crash and a shock in a
    // quiet uptrend.
    const shock = Math.min(4, Math.abs(sessionReturn) / params.vol);
    const volumeNoise = Math.exp(random.normal() * 0.28);
    const continuousVolume = baseVolume * params.volumeFactor * (0.7 + 0.45 * shock) * volumeNoise;
    const volume = Math.max(1, Math.round(continuousVolume * divisor));

    bars.push({
      symbol: spec.symbol,
      sessionDate,
      open,
      high,
      low,
      close,
      volume,
      // Average trade size drifts with price; roughly right is enough here.
      tradeCount: Math.max(1, Math.round(volume / (120 + random.range(-30, 30)))),
      vwap,
    });

    truth.push({
      sessionDate,
      sessionIndex: index,
      regime,
      continuousClose: closeContinuous,
      splitDivisor: divisor,
      expectedDrift: params.drift,
      expectedVol: params.vol,
    });

    continuousClose = closeContinuous;
  }

  return { symbol: spec.symbol, bars, corporateActions, truth };
}

/**
 * Announcements land after the close of an earlier session, which is what makes
 * `announced_at <= as_of` a meaningful filter: a backtest standing on the
 * announcement date sees the action, one standing the day before does not.
 */
function announcementStamp(dates: readonly IsoDate[], exIndex: number, lead: number): string {
  const leadSessions = Math.max(1, Math.floor(lead));
  const index = Math.max(0, exIndex - leadSessions);
  return `${dates[index] as IsoDate}T21:00:00.000Z`;
}

/**
 * A universe of correlated names.
 *
 * Independent random walks are the wrong test bed for a risk engine whose whole
 * job includes concentration and correlation limits — with zero correlation,
 * diversification always works and heat caps never bind. Each symbol here shares
 * a market factor with the others, so a crash is a crash for the portfolio.
 */
export interface UniverseSpec {
  seed: number | string;
  startDate: IsoDate;
  regimes: readonly RegimeSegment[];
  members: readonly {
    symbol: string;
    startPrice: number;
    /** Sensitivity to the shared market factor. 1.0 = moves with the market. */
    beta?: number;
    /** Name-specific volatility multiplier. */
    idiosyncratic?: number;
    baseVolume?: number;
    splits?: readonly SplitSpec[];
    dividends?: readonly DividendSpec[];
  }[];
}

export function generateUniverse(spec: UniverseSpec): SyntheticSeries[] {
  // The market factor is one generated series; members blend it with their own.
  const market = generateSeries({
    symbol: "__MARKET__",
    seed: spec.seed,
    startDate: spec.startDate,
    startPrice: 100,
    regimes: spec.regimes,
  });

  const marketReturns = logReturns(market.truth.map((t) => t.continuousClose));

  return spec.members.map((member) => {
    const beta = member.beta ?? 1;
    const idiosyncratic = member.idiosyncratic ?? 1;

    const own = generateSeries({
      symbol: member.symbol,
      seed: spec.seed,
      startDate: spec.startDate,
      startPrice: member.startPrice,
      regimes: spec.regimes,
      ...(member.baseVolume !== undefined ? { baseVolume: member.baseVolume } : {}),
      ...(member.splits !== undefined ? { splits: member.splits } : {}),
      ...(member.dividends !== undefined ? { dividends: member.dividends } : {}),
    });

    return blendWithMarket(own, marketReturns, beta, idiosyncratic);
  });
}

function logReturns(series: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i += 1) {
    out.push(Math.log((series[i] as number) / (series[i - 1] as number)));
  }
  return out;
}

/**
 * Rebuilds a series as `beta × market + idiosyncratic × own`, preserving the
 * bar's internal shape (where open, high and low sat relative to the close) so
 * the result is still a coherent OHLC path rather than a resampled close line.
 */
function blendWithMarket(
  series: SyntheticSeries,
  marketReturns: readonly number[],
  beta: number,
  idiosyncratic: number,
): SyntheticSeries {
  const ownReturns = logReturns(series.truth.map((t) => t.continuousClose));
  const bars: SyntheticBar[] = [];
  const truth: SessionTruth[] = [];

  // Session zero passes through unchanged; the blend applies to returns, and
  // there is no return into the first bar.
  let continuous = (series.truth[0] as SessionTruth | undefined)?.continuousClose ?? 1;

  for (let i = 0; i < series.bars.length; i += 1) {
    const sourceBar = series.bars[i] as SyntheticBar;
    const sourceTruth = series.truth[i] as SessionTruth;

    if (i > 0) {
      const marketReturn = marketReturns[i - 1] ?? 0;
      const ownReturn = ownReturns[i - 1] ?? 0;
      continuous = Math.max(PRICE_FLOOR, continuous * Math.exp(beta * marketReturn + idiosyncratic * ownReturn));
    }

    // Both raw prices carry the same split divisor, so it cancels: scaling the
    // whole bar by the ratio of continuous closes leaves every intrabar
    // relationship — and the split bookkeeping — untouched.
    const scale = continuous / sourceTruth.continuousClose;
    const open = round2(sourceBar.open * scale);
    const close = round2(sourceBar.close * scale);
    const high = Math.max(round2(sourceBar.high * scale), open, close);
    const low = Math.min(round2(sourceBar.low * scale), open, close);
    const vwap = Math.min(high, Math.max(low, round2(sourceBar.vwap * scale)));

    bars.push({ ...sourceBar, open, high, low, close, vwap });
    truth.push({ ...sourceTruth, continuousClose: continuous });
  }

  return { symbol: series.symbol, bars, corporateActions: series.corporateActions, truth };
}
