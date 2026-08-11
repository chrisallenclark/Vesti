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

    const url = new URL("/v1/corporate-actions", this.#baseUrl);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("start", from);
    url.searchParams.set("end", to);
    url.searchParams.set("types", "forward_split,reverse_split,cash_dividend");

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

    const payload = (await response.json()) as {
      corporate_actions?: {
        forward_splits?: Array<{ symbol: string; ex_date: string; process_date?: string; old_rate: number; new_rate: number }>;
        reverse_splits?: Array<{ symbol: string; ex_date: string; process_date?: string; old_rate: number; new_rate: number }>;
        cash_dividends?: Array<{ symbol: string; ex_date: string; process_date?: string; rate: number }>;
      };
    };

    const actions: RawCorporateAction[] = [];
    const ca = payload.corporate_actions ?? {};

    for (const split of [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])]) {
      actions.push({
        symbol: split.symbol,
        kind: "split",
        exDate: split.ex_date,
        // Alpaca does not publish an announcement date. Falling back to
        // process_date, then ex_date, is CONSERVATIVE in the wrong direction —
        // it can make an adjustment appear knowable slightly later than it was,
        // which costs accuracy but never manufactures look-ahead.
        announcedAt: split.process_date ?? split.ex_date,
        splitRatio: split.new_rate / split.old_rate,
      });
    }

    for (const dividend of ca.cash_dividends ?? []) {
      actions.push({
        symbol: dividend.symbol,
        kind: "cash_dividend",
        exDate: dividend.ex_date,
        announcedAt: dividend.process_date ?? dividend.ex_date,
        cashAmount: dividend.rate,
      });
    }

    return actions;
  }
}
