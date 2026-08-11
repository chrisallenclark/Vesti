/**
 * The EDGAR client and fact extraction, without EDGAR.
 *
 * `fetch` is injected and the fixture is a cut-down `companyfacts` document in
 * the shape the API documents, so every branch is reachable offline and
 * deterministically.
 *
 * The validator gets the most attention, and one rule in particular: a fact
 * filed before the period it describes had ended. That is not a data-quality
 * nicety — it is look-ahead with a timestamp on it, and admitting one lets a
 * backtest read a quarter before the quarter finished. It is the single most
 * flattering bug available anywhere in this system, which is why it fails here
 * rather than being noticed as a suspiciously good screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONCEPT_GROUPS,
  EdgarClient,
  INGESTED_CONCEPTS,
  extractFacts,
  resolveConcept,
  validateFact,
  type RawFundamentalFact,
} from "./edgar.ts";

const UA = "Vesti Research test@example.com";

/**
 * A filer that reports FY2022 revenue twice: once in its own 10-K, and again —
 * restated — in the following year's. That is the normal shape of a long
 * history, not an anomaly.
 */
const FIXTURE = {
  cik: 320193,
  entityName: "TEST CO",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            {
              start: "2021-10-01",
              end: "2022-09-30",
              val: 394_328_000_000,
              accn: "0000320193-22-000108",
              fy: 2022,
              fp: "FY",
              form: "10-K",
              filed: "2022-10-28",
              frame: "CY2022",
            },
            {
              // The same period, restated a year later under a new accession.
              start: "2021-10-01",
              end: "2022-09-30",
              val: 394_000_000_000,
              accn: "0000320193-23-000106",
              fy: 2023,
              fp: "FY",
              form: "10-K",
              filed: "2023-11-03",
            },
            {
              start: "2022-10-01",
              end: "2023-09-30",
              val: 383_285_000_000,
              accn: "0000320193-23-000106",
              fy: 2023,
              fp: "FY",
              form: "10-K",
              filed: "2023-11-03",
            },
          ],
        },
      },
      // Instantaneous: a balance sheet is a point, so there is no `start`.
      Assets: {
        units: {
          USD: [
            {
              end: "2023-09-30",
              val: 352_583_000_000,
              accn: "0000320193-23-000106",
              fy: 2023,
              fp: "FY",
              form: "10-K",
              filed: "2023-11-03",
            },
          ],
        },
      },
      // Not in the curated set — must not be ingested.
      AccruedLiabilitiesCurrent: {
        units: { USD: [{ end: "2023-09-30", val: 1, accn: "x", form: "10-K", filed: "2023-11-03" }] },
      },
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: {
          shares: [
            {
              end: "2023-10-20",
              val: 15_552_752_000,
              accn: "0000320193-23-000106",
              fy: 2023,
              fp: "FY",
              form: "10-K",
              filed: "2023-11-03",
            },
          ],
        },
      },
    },
  },
};

function fact(overrides: Partial<RawFundamentalFact> = {}): RawFundamentalFact {
  return {
    symbol: "TEST",
    taxonomy: "us-gaap",
    concept: "Revenues",
    unit: "USD",
    periodStart: "2023-01-01",
    periodEnd: "2023-03-31",
    fiscalYear: 2023,
    fiscalPeriod: "Q1",
    form: "10-Q",
    value: 1000,
    accession: "0000320193-23-000001",
    filedAt: "2023-05-01",
    frame: null,
    ...overrides,
  };
}

describe("extracting facts", () => {
  it("keeps every version of a period, because that is the restatement history", () => {
    // Collapsing these to "the latest" here would destroy the only record of
    // what was believed when, which is the entire point of storing them.
    const facts = extractFacts(FIXTURE as never, "TEST");
    const revenue = facts.filter(
      (f) => f.concept === "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
    const fy2022 = revenue.filter((f) => f.periodEnd === "2022-09-30");
    assert.equal(fy2022.length, 2);
    assert.deepEqual(
      fy2022.map((f) => f.accession).sort(),
      ["0000320193-22-000108", "0000320193-23-000106"],
    );
    assert.notEqual(fy2022[0]!.value, fy2022[1]!.value, "a restatement changed the number");
  });

  it("carries the filing date through untouched", () => {
    const facts = extractFacts(FIXTURE as never, "TEST");
    const original = facts.find((f) => f.accession === "0000320193-22-000108");
    assert.equal(original?.filedAt, "2022-10-28");
  });

  it("distinguishes instantaneous facts from spans", () => {
    const facts = extractFacts(FIXTURE as never, "TEST");
    const assets = facts.find((f) => f.concept === "Assets");
    assert.equal(assets?.periodStart, null, "a balance sheet is a point, not a period");
    const revenue = facts.find((f) => f.periodEnd === "2023-09-30" && f.concept !== "Assets");
    assert.equal(revenue?.periodStart, "2022-10-01");
  });

  it("reads the dei taxonomy as well as us-gaap", () => {
    const facts = extractFacts(FIXTURE as never, "TEST");
    const shares = facts.find((f) => f.taxonomy === "dei");
    assert.equal(shares?.concept, "EntityCommonStockSharesOutstanding");
    assert.equal(shares?.unit, "shares");
  });

  it("ingests only the curated concepts", () => {
    // A full companyfacts document is megabytes of concepts nobody screens on.
    const facts = extractFacts(FIXTURE as never, "TEST");
    assert.equal(
      facts.some((f) => f.concept === "AccruedLiabilitiesCurrent"),
      false,
    );
    for (const f of facts) assert.ok(INGESTED_CONCEPTS.includes(f.concept), f.concept);
  });

  it("can be limited to facts after a date", () => {
    const facts = extractFacts(FIXTURE as never, "TEST", { since: "2023-01-01" });
    assert.equal(
      facts.some((f) => f.periodEnd === "2022-09-30"),
      false,
    );
    assert.ok(facts.length > 0);
  });
});

describe("concept aliasing", () => {
  it("prefers the newer revenue tag when a filer emits both", () => {
    // Some filers still emit the legacy roll-up alongside the newer
    // revenue-from-contracts tag. Taking both would double count.
    const available = new Set([
      "Revenues",
      "RevenueFromContractWithCustomerExcludingAssessedTax",
    ]);
    assert.equal(
      resolveConcept("revenue", available),
      "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
  });

  it("falls back through the preference order", () => {
    assert.equal(resolveConcept("revenue", new Set(["SalesRevenueNet"])), "SalesRevenueNet");
    assert.equal(resolveConcept("revenue", new Set(["Revenues"])), "Revenues");
  });

  it("returns null rather than guessing when a filer used none of them", () => {
    assert.equal(resolveConcept("revenue", new Set(["SomethingElse"])), null);
  });

  it("lists every aliased tag as ingestible", () => {
    // A tag the resolver can choose but the ingest never fetches is a screen
    // that silently returns nothing for that filer.
    for (const tags of Object.values(CONCEPT_GROUPS)) {
      for (const tag of tags) assert.ok(INGESTED_CONCEPTS.includes(tag), tag);
    }
  });
});

describe("validating facts", () => {
  it("rejects a fact filed before the period it reports had ended", () => {
    // The one that matters. A company cannot report a quarter before the
    // quarter is over, and admitting such a row lets a backtest read it early.
    const problems = validateFact(fact({ periodEnd: "2023-03-31", filedAt: "2023-02-01" }));
    assert.deepEqual(problems, ["filed before the period it reports had ended"]);
  });

  it("accepts a filing on the period end itself", () => {
    // An 8-K reporting a balance as of the day it is filed is legitimate.
    assert.deepEqual(validateFact(fact({ periodEnd: "2023-03-31", filedAt: "2023-03-31" })), []);
  });

  it("rejects a period that starts after it ends", () => {
    const problems = validateFact(fact({ periodStart: "2023-06-01", periodEnd: "2023-03-31" }));
    assert.ok(problems.includes("period starts after it ends"));
  });

  it("rejects non-finite values and missing identity", () => {
    assert.ok(validateFact(fact({ value: Number.NaN })).includes("non-finite value"));
    assert.ok(validateFact(fact({ accession: "" })).includes("no accession"));
    assert.ok(validateFact(fact({ unit: "" })).includes("no unit"));
  });

  it("accepts a well-formed instantaneous fact", () => {
    assert.deepEqual(validateFact(fact({ periodStart: null })), []);
  });
});

describe("EdgarClient", () => {
  it("refuses to start without a contact address", () => {
    // The SEC requires it and refuses requests without one. Failing here turns
    // a mysterious empty ingest into an obvious configuration error.
    assert.throws(() => new EdgarClient({ userAgent: "Vesti Research" }), /real contact address/);
    assert.throws(() => new EdgarClient({ userAgent: "" }), /real contact address/);
  });

  it("sends the contact address on every request", async () => {
    const seen: Array<Record<string, string>> = [];
    const client = new EdgarClient({
      userAgent: UA,
      sleep: async () => {},
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response(JSON.stringify({ cik: 1, facts: {} }), { status: 200 });
      }) as typeof fetch,
    });
    await client.fetchCompanyFacts("320193");
    assert.equal(seen[0]?.["User-Agent"], UA);
  });

  it("zero-pads a CIK to the ten digits the API expects", async () => {
    const urls: string[] = [];
    const client = new EdgarClient({
      userAgent: UA,
      sleep: async () => {},
      fetchImpl: (async (url: unknown) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ cik: 1, facts: {} }), { status: 200 });
      }) as typeof fetch,
    });
    await client.fetchCompanyFacts("320193");
    assert.match(urls[0]!, /CIK0000320193\.json$/);
  });

  it("spaces requests rather than bursting them", async () => {
    // The SEC enforces its rate limit with IP blocks that outlast the request
    // that earned them, so this is not politeness.
    const waits: number[] = [];
    const client = new EdgarClient({
      userAgent: UA,
      requestsPerSecond: 10,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ cik: 1, facts: {} }), { status: 200 })) as typeof fetch,
    });
    await client.fetchCompanyFacts("1");
    await client.fetchCompanyFacts("2");
    assert.ok(
      waits.some((w) => w > 0),
      "the second request must wait for the interval",
    );
  });

  it("maps tickers to zero-padded CIKs", async () => {
    const client = new EdgarClient({
      userAgent: UA,
      sleep: async () => {},
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            "0": { cik_str: 320193, ticker: "aapl", title: "Apple Inc." },
            "1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft" },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    const map = await client.fetchTickerMap();
    assert.equal(map.get("AAPL"), "0000320193");
    assert.equal(map.get("MSFT"), "0000789019");
  });

  it("surfaces an EDGAR error rather than returning nothing", async () => {
    const client = new EdgarClient({
      userAgent: UA,
      sleep: async () => {},
      fetchImpl: (async () => new Response("rate limited", { status: 429 })) as typeof fetch,
    });
    await assert.rejects(() => client.fetchCompanyFacts("1"), /EDGAR request failed: 429/);
  });

  /**
   * SPY is the case that found this: an ETF has a CIK and sits in the ticker
   * file, but files no XBRL facts, so `companyfacts` 404s. Raising that as an
   * error aborts the whole run at whichever ETF sorts first and loses every
   * filer after it — which is precisely what a real universe run did.
   */
  it("reports a filer with no XBRL facts as absent rather than failing", async () => {
    const client = new EdgarClient({
      userAgent: UA,
      sleep: async () => {},
      fetchImpl: (async () =>
        new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })) as typeof fetch,
    });
    assert.equal(await client.fetchCompanyFacts("0000884394"), null);
  });

  it("still fails on a 403, which means the contact was refused, not that facts are absent", async () => {
    const client = new EdgarClient({
      userAgent: UA,
      sleep: async () => {},
      fetchImpl: (async () => new Response("undeclared automated tool", { status: 403 })) as typeof fetch,
    });
    await assert.rejects(() => client.fetchCompanyFacts("1"), /EDGAR request failed: 403/);
  });
});
