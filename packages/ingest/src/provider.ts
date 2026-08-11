/**
 * Market data provider abstraction.
 *
 * Vendors get replaced — the free Alpaca tier is IEX-only (~2–3% of consolidated
 * volume), so any strategy whose edge depends on volume confirmation will
 * eventually force a move to a full-tape provider. Nothing above this interface
 * may know which vendor is in use, and every bar records the `tape` it came
 * from so that upgrade can recompute exactly the affected rows.
 */

export type Tape = "iex" | "sip" | "synthetic";

export interface RawDailyBar {
  symbol: string;
  /** Session date in exchange-local terms, ISO `YYYY-MM-DD`. */
  sessionDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount?: number | undefined;
  vwap?: number | undefined;
}

export interface RawCorporateAction {
  symbol: string;
  kind: "split" | "cash_dividend";
  /** When it takes effect. */
  exDate: string;
  /** When it first became publicly knowable. Critical for point-in-time
   *  correctness — adjusting with an action the market had not been told about
   *  is look-ahead bias. */
  announcedAt: string;
  splitRatio?: number | undefined;
  cashAmount?: number | undefined;
}

export interface MarketDataProvider {
  /** Matches a `sources.slug` row so every ingested fact is attributable. */
  readonly slug: string;
  readonly tape: Tape;
  fetchDailyBars(symbols: readonly string[], from: string, to: string): Promise<RawDailyBar[]>;
  fetchCorporateActions?(
    symbols: readonly string[],
    from: string,
    to: string,
  ): Promise<RawCorporateAction[]>;
}

/**
 * Rejects a bar that cannot be true.
 *
 * Bad ticks reach production data more often than people expect, and a single
 * impossible bar silently poisons every feature, backtest, and expectancy figure
 * computed downstream. Cheaper to reject at the door than to explain a
 * suspiciously profitable strategy three months later.
 */
export function validateBar(bar: RawDailyBar): string[] {
  const problems: string[] = [];
  const finite = (n: number) => Number.isFinite(n);

  if (![bar.open, bar.high, bar.low, bar.close].every(finite)) problems.push("non-finite price");
  if (bar.low <= 0) problems.push("non-positive low");
  if (bar.volume < 0) problems.push("negative volume");
  if (bar.high < bar.low) problems.push("high below low");
  if (bar.high < bar.open || bar.high < bar.close) problems.push("high below open or close");
  if (bar.low > bar.open || bar.low > bar.close) problems.push("low above open or close");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.sessionDate)) problems.push("malformed session date");
  // A VWAP outside the bar's own range is arithmetically impossible.
  if (bar.vwap !== undefined && (bar.vwap < bar.low || bar.vwap > bar.high)) {
    problems.push("vwap outside high/low range");
  }
  return problems;
}
