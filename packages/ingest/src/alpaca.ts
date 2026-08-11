import type {
  MarketDataProvider,
  RawCorporateAction,
  RawDailyBar,
  Tape,
} from "./provider.ts";

/**
 * Alpaca market data.
 *
 * The free tier serves 10 years of history — genuinely enough for pattern
 * sample sizes — but from the IEX tape only. Prices and OHLC structure are
 * broadly sound; volume is roughly 2–3% of consolidated, so RVOL and any
 * volume-confirmation signal derived from it is biased. That is recorded per
 * bar rather than assumed away.
 */

const PAGE_LIMIT = 10_000;

/**
 * The earliest vendor-supplied date that cannot possibly precede the
 * declaration of a corporate action.
 *
 * Alpaca does not publish a declaration date, and `process_date` is its own
 * bookkeeping stamp — in practice always *equal to the ex-date* on every split
 * observed so far. Taking it at face value would tell the PIT layer that
 * Apple's 4:1 split became knowable on the morning it took effect, a month
 * after the market was actually told, and every backtest standing in that month
 * would read a price series a real trader never saw.
 *
 * Every other date the vendor does give is bounded below by the declaration: a
 * board declares first, and only then are record, payable and ex dates set off
 * it. The minimum of them is therefore the tightest bound that is still
 * defensible, and it errs in the safe direction — it can withhold an adjustment
 * a backtest was entitled to, never grant one it was not.
 *
 * Taking a minimum also guarantees `announcedAt <= exDate`, so a vendor row
 * whose `process_date` lands after the ex-date cannot trip the "announced after
 * the ex-date" validator and drop out of the batch. A silently missing split
 * leaves an unadjusted discontinuity in the series — a far worse failure than a
 * late announcement, and a much quieter one.
 */
function earliestKnowableDate(
  action: {
    ex_date: string;
    process_date?: string | undefined;
    record_date?: string | undefined;
    payable_date?: string | undefined;
  },
): string {
  const candidates = [
    action.ex_date,
    action.process_date,
    action.record_date,
    action.payable_date,
  ].filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
  // ISO dates sort lexically, so the string minimum is the chronological one.
  return candidates.reduce((earliest, d) => (d < earliest ? d : earliest), action.ex_date);
}

interface AlpacaBar {
  t: string; // RFC-3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
}

interface AlpacaBarsResponse {
  bars?: Record<string, AlpacaBar[]>;
  next_page_token?: string | null;
}

interface AlpacaSplit {
  symbol: string;
  ex_date: string;
  process_date?: string;
  record_date?: string;
  payable_date?: string;
  old_rate: number;
  new_rate: number;
}

interface AlpacaDividend {
  symbol: string;
  ex_date: string;
  process_date?: string;
  record_date?: string;
  payable_date?: string;
  rate: number;
}

interface AlpacaCorporateActionsResponse {
  corporate_actions?: {
    forward_splits?: AlpacaSplit[];
    reverse_splits?: AlpacaSplit[];
    cash_dividends?: AlpacaDividend[];
  };
  next_page_token?: string | null;
}

export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  baseUrl?: string;
  feed?: "iex" | "sip";
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class AlpacaProvider implements MarketDataProvider {
  readonly slug = "alpaca";
  readonly tape: Tape;

  readonly #keyId: string;
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #feed: "iex" | "sip";
  readonly #fetch: typeof fetch;

  constructor(options: AlpacaOptions) {
    this.#keyId = options.keyId;
    this.#secretKey = options.secretKey;
    this.#baseUrl = options.baseUrl ?? "https://data.alpaca.markets";
    this.#feed = options.feed ?? "iex";
    this.tape = this.#feed;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async fetchDailyBars(
    symbols: readonly string[],
    from: string,
    to: string,
  ): Promise<RawDailyBar[]> {
    if (symbols.length === 0) return [];

    const collected: RawDailyBar[] = [];
    let pageToken: string | null | undefined;

    // Paginate until exhausted. A silent truncation here would leave gaps in
    // history that look like real market closures to everything downstream.
    do {
      const url = new URL("/v2/stocks/bars", this.#baseUrl);
      url.searchParams.set("symbols", symbols.join(","));
      url.searchParams.set("timeframe", "1Day");
      url.searchParams.set("start", from);
      url.searchParams.set("end", to);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      url.searchParams.set("feed", this.#feed);
      // Raw prices only. Requesting adjusted data would bake every later split
      // into historical rows — the exact look-ahead the PIT layer exists to
      // prevent. Adjustment happens at query time from corporate_actions.
      url.searchParams.set("adjustment", "raw");
      if (pageToken) url.searchParams.set("page_token", pageToken);

      const response = await this.#fetch(url, {
        headers: {
          "APCA-API-KEY-ID": this.#keyId,
          "APCA-API-SECRET-KEY": this.#secretKey,
          accept: "application/json",
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Alpaca bars request failed: ${response.status} ${response.statusText}. ${body.slice(0, 300)}`,
        );
      }

      const payload = (await response.json()) as AlpacaBarsResponse;
      for (const [symbol, bars] of Object.entries(payload.bars ?? {})) {
        for (const bar of bars) {
          collected.push({
            symbol,
            // Alpaca stamps daily bars at 00:00 UTC of the session date.
            sessionDate: bar.t.slice(0, 10),
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v,
            tradeCount: bar.n,
            vwap: bar.vw,
          });
        }
      }
      pageToken = payload.next_page_token;
    } while (pageToken);

    return collected;
  }

  async fetchCorporateActions(
    symbols: readonly string[],
    from: string,
    to: string,
  ): Promise<RawCorporateAction[]> {
    if (symbols.length === 0) return [];

    const actions: RawCorporateAction[] = [];
    let pageToken: string | null | undefined;

    // Paginated for the same reason bars are, only with sharper consequences: a
    // truncated bar page leaves a visible hole in a series, while a truncated
    // action page leaves a split missing from an otherwise complete one. The
    // series then reads as a genuine 75% overnight collapse, and every feature
    // and label computed from it inherits the lie.
    do {
      const url = new URL("/v1/corporate-actions", this.#baseUrl);
      url.searchParams.set("symbols", symbols.join(","));
      url.searchParams.set("start", from);
      url.searchParams.set("end", to);
      url.searchParams.set("types", "forward_split,reverse_split,cash_dividend");
      url.searchParams.set("limit", "1000");
      if (pageToken) url.searchParams.set("page_token", pageToken);

      const response = await this.#fetch(url, {
        headers: {
          "APCA-API-KEY-ID": this.#keyId,
          "APCA-API-SECRET-KEY": this.#secretKey,
          accept: "application/json",
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Alpaca corporate actions request failed: ${response.status}. ${body.slice(0, 300)}`,
        );
      }

      const payload = (await response.json()) as AlpacaCorporateActionsResponse;
      const ca = payload.corporate_actions ?? {};

      for (const split of [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])]) {
        actions.push({
          symbol: split.symbol,
          kind: "split",
          exDate: split.ex_date,
          // See earliestKnowableDate: late rather than early, always.
          announcedAt: earliestKnowableDate(split),
          splitRatio: split.new_rate / split.old_rate,
        });
      }

      for (const dividend of ca.cash_dividends ?? []) {
        actions.push({
          symbol: dividend.symbol,
          kind: "cash_dividend",
          exDate: dividend.ex_date,
          announcedAt: earliestKnowableDate(dividend),
          cashAmount: dividend.rate,
        });
      }

      pageToken = payload.next_page_token;
    } while (pageToken);

    return actions;
  }
}
