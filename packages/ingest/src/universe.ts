/**
 * The starter universe.
 *
 * Small on purpose. Its job is not coverage — it is to give every later phase
 * something real to stand on, and to make the point-in-time layer falsifiable
 * against corporate actions that actually happened rather than ones we
 * generated.
 *
 * Chosen against three constraints:
 *
 *   LIQUIDITY. The free Alpaca tier is IEX-only, ~2–3% of consolidated volume.
 *   On a mega-cap that still leaves millions of shares a session; on a small cap
 *   it leaves a tape too thin to model a fill against. Everything here trades
 *   enough that the IEX slice is still a usable series.
 *
 *   SPLIT COVERAGE. Nine of these names split inside the ingest window,
 *   including a 20:1 (AMZN, GOOGL) and two on one name (NVDA 4:1 then 10:1,
 *   TSLA 5:1 then 3:1). Compounding matters: a reconstruction that divides once
 *   instead of multiplying the factors passes on a single split and fails here.
 *
 *   BENCHMARKS. SPY, QQQ and IWM are not tradable candidates — they are what a
 *   mandate's return gets measured against at Phase 6. Ingesting them now means
 *   the comparison is against a series built by the same path as the strategy's,
 *   rather than a number pasted in later.
 *
 * Deliberately not a screen. A universe selected today by today's liquidity is
 * survivorship bias wearing a lab coat; the Phase 2 universe builder will
 * construct point-in-time membership from `pit_universe`. This is a fixed,
 * hand-written list, and it is honest about being one.
 */

export interface UniverseDefinition {
  readonly name: string;
  readonly symbols: readonly string[];
  readonly description: string;
}

export const STARTER_UNIVERSE: UniverseDefinition = {
  name: "starter",
  description: "Liquid US large caps with real split history, plus index benchmarks.",
  symbols: [
    // Mega-cap technology — the split-heavy cohort.
    "AAPL", // 4:1  ex 2020-08-31
    "AMZN", // 20:1 ex 2022-06-06
    "GOOGL", // 20:1 ex 2022-07-18
    "NVDA", // 4:1  ex 2021-07-20, 10:1 ex 2024-06-10
    "TSLA", // 5:1  ex 2020-08-31, 3:1  ex 2022-08-25
    "AVGO", // 10:1 ex 2024-07-15
    "MSFT",
    "META",
    "AMD",
    // Outside technology, so a regime engine has something that is not one bet.
    "JPM",
    "XOM",
    "JNJ",
    "WMT", // 3:1 ex 2024-02-26
    "COST",
    // Benchmarks.
    "SPY",
    "QQQ",
    "IWM",
  ],
};

export const UNIVERSES: Readonly<Record<string, UniverseDefinition>> = {
  starter: STARTER_UNIVERSE,
};

export function resolveUniverse(name: string): UniverseDefinition {
  const universe = UNIVERSES[name];
  if (!universe) {
    throw new Error(
      `Unknown universe "${name}". Known: ${Object.keys(UNIVERSES).join(", ")}.`,
    );
  }
  return universe;
}
