/**
 * The SIP recency clamp, without Alpaca.
 *
 * This exists because the failure it prevents is not a degraded response but a
 * rejected one, and the rejection is easy to misread. Alpaca refuses a SIP
 * request whose `end` falls inside the last fifteen minutes with "subscription
 * does not permit querying recent SIP data" — wording that sounds like the plan
 * lacks SIP entirely. A daily backfill ends at today by construction, so every
 * SIP request made the obvious way fails, and the obvious conclusion from that
 * is the wrong one: that the tape is unavailable and the only fix is money.
 *
 * It is not. The free plan serves SIP from 2016 onward; it withholds only the
 * most recent fifteen minutes. So these tests pin the clamp on the exact shape
 * that produced the misreading — a bare `YYYY-MM-DD` of today, which Alpaca
 * reads as end-of-day and therefore as the future.
 *
 * `fetch` and the clock are both injected, so nothing here waits or reaches the
 * network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AlpacaProvider } from "./alpaca.ts";

/** Fixed clock: 2026-08-11T21:07:41Z, mid-session and mid-minute on purpose. */
const NOW = Date.parse("2026-08-11T21:07:41.000Z");

interface Captured {
  urls: URL[];
  provider: AlpacaProvider;
}

function providerWith(feed?: "iex" | "sip"): Captured {
  const urls: URL[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify({ bars: {}, next_page_token: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const provider = new AlpacaProvider({
    keyId: "key",
    secretKey: "secret",
    fetchImpl,
    now: () => NOW,
    ...(feed ? { feed } : {}),
  });
  return { urls, provider };
}

const endOf = (url: URL): string => url.searchParams.get("end") ?? "";
const feedOf = (url: URL): string => url.searchParams.get("feed") ?? "";

describe("AlpacaProvider feed selection", () => {
  it("takes the full consolidated tape unless IEX is asked for by name", () => {
    assert.equal(providerWith().provider.tape, "sip");
    assert.equal(providerWith("iex").provider.tape, "iex");
  });

  it("reports the tape it actually requested, so bars can record it", async () => {
    const { urls, provider } = providerWith("iex");
    await provider.fetchDailyBars(["AAPL"], "2016-01-01", "2026-08-11");
    assert.equal(feedOf(urls[0]!), "iex");
    assert.equal(provider.tape, "iex");
  });
});

describe("AlpacaProvider SIP recency clamp", () => {
  it("pulls today's date back behind the delay instead of sending it", async () => {
    const { urls, provider } = providerWith("sip");
    // The exact request that fails against the live API: end-of-day today.
    await provider.fetchDailyBars(["AAPL"], "2016-01-01", "2026-08-11");

    const sent = endOf(urls[0]!);
    assert.notEqual(sent, "2026-08-11");
    const sentAt = Date.parse(sent);
    assert.ok(Number.isFinite(sentAt), `end should be a timestamp, got ${sent}`);
    assert.ok(
      sentAt <= NOW - 15 * 60 * 1000,
      `end ${sent} must sit at least 15 minutes behind ${new Date(NOW).toISOString()}`,
    );
  });

  it("leaves an end that is already old enough exactly as it was given", async () => {
    const { urls, provider } = providerWith("sip");
    await provider.fetchDailyBars(["AAPL"], "2016-01-01", "2026-08-10");
    assert.equal(endOf(urls[0]!), "2026-08-10");
  });

  it("clamps a timestamp inside the window but not one just outside it", async () => {
    const inside = "2026-08-11T21:00:00.000Z"; // ~7 minutes old
    const outside = "2026-08-11T20:30:00.000Z"; // ~37 minutes old

    const a = providerWith("sip");
    await a.provider.fetchDailyBars(["AAPL"], "2016-01-01", inside);
    assert.notEqual(endOf(a.urls[0]!), inside);

    const b = providerWith("sip");
    await b.provider.fetchDailyBars(["AAPL"], "2016-01-01", outside);
    assert.equal(endOf(b.urls[0]!), outside);
  });

  it("does not touch the end date on IEX, which has no such restriction", async () => {
    const { urls, provider } = providerWith("iex");
    await provider.fetchDailyBars(["AAPL"], "2016-01-01", "2026-08-11");
    assert.equal(endOf(urls[0]!), "2026-08-11");
  });

  it("passes an unparseable end through rather than inventing a date", async () => {
    const { urls, provider } = providerWith("sip");
    await provider.fetchDailyBars(["AAPL"], "2016-01-01", "not-a-date");
    assert.equal(endOf(urls[0]!), "not-a-date");
  });

  it("still requests raw prices, because the clamp must not disturb adjustment", async () => {
    const { urls, provider } = providerWith("sip");
    await provider.fetchDailyBars(["AAPL"], "2016-01-01", "2026-08-11");
    assert.equal(urls[0]!.searchParams.get("adjustment"), "raw");
  });
});
