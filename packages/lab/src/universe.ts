/**
 * The symbols a backtest runs over.
 *
 * Re-stated here rather than imported from the ingest package so that changing
 * what gets downloaded cannot silently change what a recorded backtest was run
 * against. A result is only comparable to another result over the same names.
 *
 * Survivorship applies and is not fixed by anything in this file: these are
 * companies that exist today, so a backtest over them never holds a name that
 * went to zero. The point-in-time universe that fixes it is Phase 2's
 * `pit_universe`, and until that is populated every return here is optimistic
 * by an unknown amount.
 */
export const STARTER_UNIVERSE: readonly string[] = [
  "AAPL",
  "AMD",
  "AMZN",
  "AVGO",
  "COST",
  "GOOGL",
  "JNJ",
  "JPM",
  "META",
  "MSFT",
  "NVDA",
  "TSLA",
  "WMT",
  "XOM",
  // Held out as the benchmark by default rather than traded.
  "SPY",
];
