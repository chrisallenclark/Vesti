import type {
  MarketDataProvider,
  RawCorporateAction,
  RawDailyBar,
  Tape,
} from "./provider.ts";

/**
 * Alpaca market data.
 *
 * THE FREE TIER SERVES THE FULL CONSOLIDATED TAPE, historically. This was
 * measured, and it contradicts what this file used to claim: `feed=sip` returns
 * data from 2016-01-04 onward — daily and 1-minute — with real consolidated
 * volume, on the same free plan that serves IEX. What the free plan withholds
 * is *recent* SIP, not SIP.
 *
 * The withholding has a sharp edge worth stating, because it is what made SIP
 * look unavailable: asking for an `end` inside the last fifteen minutes does not
 * truncate the response, it rejects the whole request with "subscription does
 * not permit querying recent SIP data". Since a daily backfill naturally ends
 * at "today", every SIP request made that way fails, and the failure reads like
 * a plan restriction on the feed itself rather than on its recency. `#clampEnd`
 * is the whole fix: hold `end` back behind the delay and SIP answers normally.
 *
 * IEX remains selectable and is the honest choice for anything real-time, where
 * a fifteen-minute-old consolidated print is worse than a fresh partial one.
 * Its volume is roughly 2–3% of consolidated, so RVOL and any volume-confirmation
 * signal derived from it is biased — which is why the tape is recorded per bar
 * rather than assumed away, and why history is now fetched from SIP.
 */

const PAGE_LIMIT = 10_000;

/**
 * How far behind "now" a SIP request has to stay. Alpaca documents fifteen
 * minutes; the extra minute absorbs clock skew between this process and theirs,
 * because being wrong by a second here costs the entire request rather than the
 * single bar at the boundary.
 */
const SIP_DELAY_MS = 16 * 60 * 1000;

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
  /** Injectable for tests, so the SIP clamp is assertable without waiting. */
  now?: () => number;
}

export class AlpacaProvider implements MarketDataProvider {
  readonly slug = "alpaca";
  readonly tape: Tape;

  readonly #keyId: string;
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #feed: "iex" | "sip";
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: AlpacaOptions) {
    this.#keyId = options.keyId;
    this.#secretKey = options.secretKey;
    this.#baseUrl = options.baseUrl ?? "https://data.alpaca.markets";
    // SIP by default: same price, whole tape, and history back to 2016. IEX is
    // now an opt-in for the real-time path rather than the default everything
    // inherits.
    this.#feed = options.feed ?? "sip";
    this.tape = this.#feed;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Holds a SIP `end` behind the free plan's fifteen-minute delay.
   *
   * Two shapes arrive here. A bare `YYYY-MM-DD` means end-of-day to Alpaca, so
   * today's date is a future timestamp and is refused even though the caller
   * meant "everything up to now" — that is the common case, since a backfill
   * ends at today. A full timestamp is refused only if it genuinely falls
   * inside the window.
   *
   * Clamping rather than erroring is deliberate: the caller asked for all
   * available history, and all available history is what it gets. The bars
   * inside the window are the current session's, which the PIT layer will not
   * serve before its close anyway.
   */
  #clampEnd(to: string): string {
    if (this.#feed !== "sip") return to;

    const requested = /^\d{4}-\d{2}-\d{2}$/.test(to)
      ? Date.parse(`${to}T23:59:59.999Z`)
      : Date.parse(to);
    if (!Number.isFinite(requested)) return to;

    const latest = this.#now() - SIP_DELAY_MS;
    if (requested <= latest) return to;
    return new Date(latest).toISOString();
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
      url.searchParams.set("end", this.#clampEnd(to));
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
