/**
 * Real-time-ish market data for the DAY engine.
 *
 * Separate from `@vesti/ingest`'s Alpaca provider, which exists to backfill
 * history into `bars_daily` under point-in-time rules and is built around
 * paging ten years at a time. This one answers a different question — "what has
 * happened in the last few minutes?" — and answers it without touching the
 * database at all. Intraday bars are not persisted here on purpose: the worker
 * re-derives its view from the venue on every cycle, so a restart cannot
 * inherit a stale opinion, and `bars_intraday` does not fill with a partial
 * tape that history would later have to be untangled from.
 *
 * THE FEED IS IEX, AND THAT IS A DELIBERATE DOWNGRADE.
 *
 * Alpaca's free plan withholds SIP data from the last fifteen minutes. For a
 * backfill that is a non-issue and `@vesti/ingest` clamps its request behind
 * the window. For a strategy deciding NOW it is fatal: a fifteen-minute-old
 * consolidated print is not a price, it is a memory. IEX is roughly 2–3% of
 * consolidated volume and is available immediately, so the real-time path takes
 * the partial tape and the freshness.
 *
 * What that costs, stated rather than hidden: every volume number from this
 * client is a fraction of the real one. Any rule using an ABSOLUTE volume
 * threshold would be wrong by more than an order of magnitude. Rules here use
 * ratios between bars from this same feed, where the tape's share cancels.
 * Prices are the trades that actually printed on IEX, so they are real prices,
 * just not every price.
 */

export interface IntradayBarRow {
  symbol: string;
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
}

export interface MarketClock {
  isOpen: boolean;
  /** Venue time, ISO. Used in preference to ours — clock skew is real. */
  timestamp: string;
  nextOpen: string;
  nextClose: string;
}

export interface IntradayDataOptions {
  keyId: string;
  secretKey: string;
  /** Data API root. Defaults to Alpaca's. */
  baseUrl?: string;
  /**
   * Feed. `iex` by default and for good reason — see the header. `sip` is
   * accepted for replaying a completed session, where the delay does not
   * matter and the full tape is strictly better.
   */
  feed?: "iex" | "sip";
  fetchImpl?: typeof fetch;
}

const RETRY_DELAYS_MS = [250, 1000, 3000];

export class IntradayMarketData {
  readonly feed: "iex" | "sip";

  readonly #keyId: string;
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: IntradayDataOptions) {
    this.#keyId = options.keyId;
    this.#secretKey = options.secretKey;
    this.#baseUrl = options.baseUrl ?? "https://data.alpaca.markets";
    this.feed = options.feed ?? "iex";
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Every completed bar for these symbols since `from`.
   *
   * `from` is an ISO instant, normally the session open in UTC. The response is
   * ordered oldest-first per symbol, which is the order every indicator here
   * expects.
   *
   * The newest FORMING bar is excluded by Alpaca itself — it publishes a bar
   * once its minute has elapsed — so nothing downstream has to know about the
   * distinction. That is the whole reason bars are used rather than the
   * `/snapshot` endpoint's last trade: a strategy reading a price that is still
   * changing is a strategy whose backtest can never reproduce it.
   */
  async fetchBars(
    symbols: readonly string[],
    from: string,
    timeframe = "1Min",
  ): Promise<Map<string, IntradayBarRow[]>> {
    const bars = new Map<string, IntradayBarRow[]>();
    if (symbols.length === 0) return bars;

    let pageToken: string | null | undefined;
    do {
      const url = new URL("/v2/stocks/bars", this.#baseUrl);
      url.searchParams.set("symbols", symbols.join(","));
      url.searchParams.set("timeframe", timeframe);
      url.searchParams.set("start", from);
      url.searchParams.set("limit", "10000");
      url.searchParams.set("feed", this.feed);
      url.searchParams.set("adjustment", "raw");
      if (pageToken) url.searchParams.set("page_token", pageToken);

      const response = await this.#request(url);
      if (!response.ok) {
        throw new Error(
          `Alpaca bars failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
        );
      }
      const payload = (await response.json()) as {
        bars: Record<string, AlpacaBar[]> | null;
        next_page_token?: string | null;
      };

      for (const [symbol, rows] of Object.entries(payload.bars ?? {})) {
        const list = bars.get(symbol) ?? [];
        for (const row of rows) {
          list.push({
            symbol,
            ts: row.t,
            open: row.o,
            high: row.h,
            low: row.l,
            close: row.c,
            volume: row.v,
            vwap: row.vw ?? null,
          });
        }
        bars.set(symbol, list);
      }
      pageToken = payload.next_page_token;
    } while (pageToken);

    // Alpaca returns each symbol's page in order, but pages arrive per request
    // and a symbol can span two. Sorting once here is cheaper than every caller
    // having to know that.
    for (const list of bars.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
    return bars;
  }

  /**
   * The venue's own clock.
   *
   * Asked rather than computed. The calendar in `@vesti/core` knows the regular
   * holidays, but it does not know about an unscheduled halt, and a worker that
   * decides the market is open by consulting a hardcoded list will trade into a
   * closed venue on the day that matters.
   *
   * Lives on the TRADING host, not the data host, which is why this takes its
   * own base URL.
   */
  async fetchClock(tradingBaseUrl: string): Promise<MarketClock> {
    const response = await this.#request(new URL("/v2/clock", tradingBaseUrl));
    if (!response.ok) {
      throw new Error(`Alpaca clock failed: ${response.status}`);
    }
    const payload = (await response.json()) as {
      is_open: boolean;
      timestamp: string;
      next_open: string;
      next_close: string;
    };
    return {
      isOpen: payload.is_open,
      timestamp: payload.timestamp,
      nextOpen: payload.next_open,
      nextClose: payload.next_close,
    };
  }

  /**
   * One request, retried through transient failure.
   *
   * Same policy as the broker adapter: 5xx, 429 and transport errors are
   * retried; a 4xx is not, because the venue understood the request and refused
   * it. All of these are GETs, so retrying is free of the duplicate-order
   * hazard that makes the broker's version of this delicate.
   */
  async #request(url: URL): Promise<Response> {
    const init: RequestInit = {
      headers: {
        "APCA-API-KEY-ID": this.#keyId,
        "APCA-API-SECRET-KEY": this.#secretKey,
        accept: "application/json",
      },
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await this.#fetch(url, init);
        if (!isRetryable(response.status) || attempt === RETRY_DELAYS_MS.length) return response;
      } catch (error) {
        lastError = error;
        if (attempt === RETRY_DELAYS_MS.length) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
    throw lastError ?? new Error(`Alpaca GET ${url.pathname} exhausted retries.`);
  }
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
  n?: number;
}

function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * The UTC instant of a session's 09:30 ET open.
 *
 * Derived by asking what the offset actually is on that date rather than
 * assuming one, because the answer changes twice a year and being wrong makes
 * the worker request bars for a session that has not started.
 */
export function sessionOpenInstant(sessionDate: string): string {
  // Midday UTC on the session date is inside the same Eastern day under both
  // offsets, so it is a safe probe for which one applies.
  const probe = new Date(`${sessionDate}T12:00:00Z`);
  const offsetMinutes = easternOffsetMinutes(probe);
  const utcMinutes = 9 * 60 + 30 + offsetMinutes;
  const open = new Date(`${sessionDate}T00:00:00Z`);
  open.setUTCMinutes(utcMinutes);
  return open.toISOString();
}

/** Minutes to ADD to Eastern wall-clock to get UTC. 240 under EDT, 300 under EST. */
function easternOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 300;
  const sign = match[1] === "-" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
