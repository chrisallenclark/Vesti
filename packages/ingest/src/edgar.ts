/**
 * SEC EDGAR XBRL company facts.
 *
 * EDGAR is free, primary-source, and the only place these numbers come from
 * without paying a vendor to retype them. Three things about it shape this file:
 *
 *   IT PUBLISHES THE FILING DATE, which is the whole reason fundamentals can be
 *   used point-in-time at all. Every fact carries `filed`, and that is what
 *   makes "could we have known this then?" answerable rather than assumed.
 *
 *   IT REQUIRES A REAL CONTACT in the User-Agent and rate-limits to 10 requests
 *   a second. Both are conditions of use rather than suggestions; an ingest that
 *   ignores them gets the IP blocked, which is a slow and confusing failure.
 *
 *   FILERS DISAGREE ABOUT TAGS. The same economic quantity — revenue — appears
 *   as `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`, or
 *   `SalesRevenueNet` depending on the company and the year. That mapping lives
 *   here as code, and the RAW tag is what gets stored, so revising the mapping
 *   later does not mean re-ingesting a decade of filings.
 */

export interface RawFundamentalFact {
  symbol: string;
  taxonomy: string;
  concept: string;
  unit: string;
  /** NULL for instantaneous facts — a balance sheet is a point, not a span. */
  periodStart: string | null;
  periodEnd: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  form: string;
  value: number;
  accession: string;
  /** The date EDGAR made the filing public. */
  filedAt: string;
  frame: string | null;
}

/**
 * The tags worth ingesting, grouped by what they measure.
 *
 * Curated rather than exhaustive: a full `companyfacts` document runs to
 * megabytes of concepts nobody screens on, and storing all of it would trade a
 * large ingest and a large table for no answerable question. Every tag here
 * feeds a specific part of the Long-Term mandate's screen.
 *
 * Order within a group is PREFERENCE, most specific first. `Revenues` is a
 * legacy roll-up that some filers still emit alongside the newer
 * revenue-from-contracts tag; taking the newer one when both exist avoids
 * double counting and matches what the filer's own income statement shows.
 */
export const CONCEPT_GROUPS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
  ],
  costOfRevenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  assets: ["Assets"],
  currentAssets: ["AssetsCurrent"],
  liabilities: ["Liabilities"],
  currentLiabilities: ["LiabilitiesCurrent"],
  equity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  cash: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  shortTermInvestments: ["ShortTermInvestments", "MarketableSecuritiesCurrent"],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  shortTermDebt: ["LongTermDebtCurrent", "DebtCurrent"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
  ],
  interestExpense: ["InterestExpense", "InterestIncomeExpenseNet"],
  taxExpense: ["IncomeTaxExpenseBenefit"],
  pretaxIncome: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  dilutedShares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
  basicShares: ["WeightedAverageNumberOfSharesOutstandingBasic"],
  sharesOutstanding: ["CommonStockSharesOutstanding", "EntityCommonStockSharesOutstanding"],
} as const;

export type ConceptGroup = keyof typeof CONCEPT_GROUPS;

/** Every tag the ingest asks for, flattened. */
export const INGESTED_CONCEPTS: readonly string[] = [
  ...new Set(Object.values(CONCEPT_GROUPS).flat()),
];

/**
 * Picks the tag a filer actually used for a measure, honouring preference order.
 *
 * Resolution is deliberately at READ time, not write time. Filers change tags
 * between years, and a canonicalisation baked into storage would have to be
 * re-ingested to fix — the same mistake as storing an adjusted close.
 */
export function resolveConcept(
  group: ConceptGroup,
  available: ReadonlySet<string>,
): string | null {
  for (const concept of CONCEPT_GROUPS[group]) {
    if (available.has(concept)) return concept;
  }
  return null;
}

interface EdgarFactEntry {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number;
  fp?: string;
  form: string;
  filed: string;
  frame?: string;
}

interface EdgarCompanyFacts {
  cik: number;
  entityName?: string;
  facts?: Record<string, Record<string, { units?: Record<string, EdgarFactEntry[]> }>>;
}

export interface EdgarOptions {
  /**
   * Required by the SEC and required here. A request without a real contact is
   * refused by EDGAR, and pretending otherwise turns a clear 403 into a
   * mysterious empty ingest.
   */
  userAgent: string;
  baseUrl?: string;
  wwwUrl?: string;
  fetchImpl?: typeof fetch;
  /** Requests per second. The SEC's published ceiling is 10; default leaves room. */
  requestsPerSecond?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class EdgarClient {
  readonly slug = "sec_edgar";

  readonly #userAgent: string;
  readonly #baseUrl: string;
  readonly #wwwUrl: string;
  readonly #fetch: typeof fetch;
  readonly #minIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  #lastRequestAt = 0;

  constructor(options: EdgarOptions) {
    if (!options.userAgent || !options.userAgent.includes("@")) {
      throw new Error(
        "SEC_EDGAR_USER_AGENT must contain a real contact address — the SEC requires it " +
          'and refuses requests without one. Example: "Vesti Research you@example.com".',
      );
    }
    this.#userAgent = options.userAgent;
    this.#baseUrl = options.baseUrl ?? "https://data.sec.gov";
    this.#wwwUrl = options.wwwUrl ?? "https://www.sec.gov";
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#minIntervalMs = 1000 / (options.requestsPerSecond ?? 8);
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Ticker → CIK, zero-padded to the ten digits the API expects.
   *
   * The mapping only covers currently-listed companies, which is a survivorship
   * hole the caller has to know about: a company delisted last year cannot be
   * looked up here, so its fundamentals cannot be backfilled from a ticker
   * alone. Storing the CIK on `security_identifiers` at first sight is what
   * keeps a name resolvable after it leaves the file.
   */
  async fetchTickerMap(): Promise<Map<string, string>> {
    const response = await this.#request(`${this.#wwwUrl}/files/company_tickers.json`);
    const payload = (await response.json()) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >;
    const map = new Map<string, string>();
    for (const entry of Object.values(payload)) {
      map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
    }
    return map;
  }

  /**
   * Every XBRL fact EDGAR holds for one filer, or `null` if it holds none.
   *
   * A 404 here is not an error and must not be raised as one. An ETF has a CIK
   * and appears in the ticker file, but files no XBRL company facts — SPY is the
   * obvious case, and any index or commodity trust behaves the same way. Since a
   * universe legitimately contains ETFs, treating their absence as a failure
   * aborts the run at whichever ETF happens to sort first and silently costs
   * every filer after it.
   *
   * So absence is reported as absence, and the caller decides. Every other
   * status still throws: a 403 is the missing-contact refusal and a 429 is the
   * rate limit, and both need to stop the run rather than be read as "this
   * company has no financials".
   */
  async fetchCompanyFacts(cik: string): Promise<EdgarCompanyFacts | null> {
    const padded = cik.replace(/\D/g, "").padStart(10, "0");
    const response = await this.#request(
      `${this.#baseUrl}/api/xbrl/companyfacts/CIK${padded}.json`,
      { allowNotFound: true },
    );
    if (response === null) return null;
    return (await response.json()) as EdgarCompanyFacts;
  }

  async #request(url: string, options?: { allowNotFound?: false }): Promise<Response>;
  async #request(url: string, options: { allowNotFound: true }): Promise<Response | null>;
  async #request(
    url: string,
    options: { allowNotFound?: boolean } = {},
  ): Promise<Response | null> {
    // Spaced rather than bursted. The SEC publishes a rate limit and enforces it
    // with IP blocks that persist well beyond the request that earned them.
    const wait = this.#minIntervalMs - (Date.now() - this.#lastRequestAt);
    if (wait > 0) await this.#sleep(wait);
    this.#lastRequestAt = Date.now();

    const response = await this.#fetch(url, {
      headers: {
        "User-Agent": this.#userAgent,
        accept: "application/json",
        "accept-encoding": "gzip, deflate",
      },
    });
    if (response.status === 404 && options.allowNotFound) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`EDGAR request failed: ${response.status} ${url} ${body.slice(0, 200)}`);
    }
    return response;
  }
}

/**
 * Flattens a `companyfacts` document into rows, keeping only ingested concepts.
 *
 * Every entry becomes its own row, INCLUDING several reports of the same period
 * from different accessions. That is not duplication to be cleaned up — it is
 * the restatement history, and collapsing it here would destroy the only record
 * of what was believed when.
 */
export function extractFacts(
  document: EdgarCompanyFacts,
  symbol: string,
  options: { concepts?: readonly string[]; since?: string } = {},
): RawFundamentalFact[] {
  const wanted = new Set(options.concepts ?? INGESTED_CONCEPTS);
  const facts: RawFundamentalFact[] = [];

  for (const [taxonomy, concepts] of Object.entries(document.facts ?? {})) {
    for (const [concept, detail] of Object.entries(concepts)) {
      if (!wanted.has(concept)) continue;
      for (const [unit, entries] of Object.entries(detail.units ?? {})) {
        for (const entry of entries) {
          if (options.since && entry.end < options.since) continue;
          facts.push({
            symbol,
            taxonomy,
            concept,
            unit,
            periodStart: entry.start ?? null,
            periodEnd: entry.end,
            fiscalYear: entry.fy ?? null,
            fiscalPeriod: entry.fp ?? null,
            form: entry.form,
            value: entry.val,
            accession: entry.accn,
            filedAt: entry.filed,
            frame: entry.frame ?? null,
          });
        }
      }
    }
  }

  return facts;
}

/**
 * Rejects a fact that cannot be true, or that would poison the PIT layer.
 *
 * The filing-date check is the important one and is not a data-quality nicety:
 * a fact whose filing date precedes the end of the period it describes claims
 * the company reported results before it had them. Admitting one would let a
 * backtest read a quarter before the quarter finished, which is the single most
 * flattering bug available in this whole system.
 */
export function validateFact(fact: RawFundamentalFact): string[] {
  const problems: string[] = [];
  const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

  if (!Number.isFinite(fact.value)) problems.push("non-finite value");
  if (!isDate(fact.periodEnd)) problems.push("malformed period end");
  if (!isDate(fact.filedAt)) problems.push("malformed filing date");
  if (fact.periodStart !== null && !isDate(fact.periodStart)) {
    problems.push("malformed period start");
  }
  if (fact.periodStart !== null && fact.periodStart > fact.periodEnd) {
    problems.push("period starts after it ends");
  }
  if (isDate(fact.periodEnd) && isDate(fact.filedAt) && fact.filedAt < fact.periodEnd) {
    problems.push("filed before the period it reports had ended");
  }
  if (!fact.accession) problems.push("no accession");
  if (!fact.unit) problems.push("no unit");
  return problems;
}
