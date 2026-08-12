import assert from "node:assert/strict";
import { test } from "node:test";
import { IntradayMarketData, sessionOpenInstant } from "./market-data.ts";

/**
 * The date arithmetic, pinned.
 *
 * `sessionOpenInstant` decides which bars the worker asks for. Getting the
 * offset wrong does not throw — it requests an hour of a session that has not
 * started, the opening range never completes, and the worker scans all day
 * without ever finding a setup. That failure looks exactly like a quiet market,
 * which is why it is worth a test rather than a careful reading.
 *
 * The interesting cases are the two sides of daylight saving, because a fixed
 * offset passes one and fails the other.
 */

test("the session open is 13:30Z under EDT and 14:30Z under EST", () => {
  assert.equal(sessionOpenInstant("2026-08-12"), "2026-08-12T13:30:00.000Z");
  assert.equal(sessionOpenInstant("2026-01-14"), "2026-01-14T14:30:00.000Z");
});

test("it tracks the changeover rather than the month", () => {
  // 2026: DST begins 8 March, ends 1 November.
  assert.equal(sessionOpenInstant("2026-03-06"), "2026-03-06T14:30:00.000Z"); // EST
  assert.equal(sessionOpenInstant("2026-03-09"), "2026-03-09T13:30:00.000Z"); // EDT
  assert.equal(sessionOpenInstant("2026-10-30"), "2026-10-30T13:30:00.000Z"); // EDT
  assert.equal(sessionOpenInstant("2026-11-02"), "2026-11-02T14:30:00.000Z"); // EST
});

test("bars are requested from the real-time feed, ordered oldest first", async () => {
  const seen: string[] = [];
  const data = new IntradayMarketData({
    keyId: "k",
    secretKey: "s",
    fetchImpl: (async (url: URL) => {
      seen.push(url.toString());
      return new Response(
        JSON.stringify({
          // Returned newest-first on purpose: every indicator downstream
          // assumes oldest-first, and the client is what guarantees it.
          bars: {
            AAPL: [
              { t: "2026-08-12T14:01:00Z", o: 2, h: 2, l: 2, c: 2, v: 20, vw: 2 },
              { t: "2026-08-12T14:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 10, vw: 1 },
            ],
          },
          next_page_token: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });

  const bars = await data.fetchBars(["AAPL"], "2026-08-12T13:30:00.000Z");
  const url = new URL(seen[0]!);

  // IEX, not SIP: the free plan withholds SIP for fifteen minutes, and a
  // fifteen-minute-old price is not a price to decide on.
  assert.equal(url.searchParams.get("feed"), "iex");
  assert.equal(url.searchParams.get("timeframe"), "1Min");
  assert.equal(url.searchParams.get("adjustment"), "raw");
  assert.equal(url.searchParams.get("start"), "2026-08-12T13:30:00.000Z");

  assert.deepEqual(
    bars.get("AAPL")!.map((b) => b.ts),
    ["2026-08-12T14:00:00Z", "2026-08-12T14:01:00Z"],
  );
});

test("it follows pagination rather than silently truncating the session", async () => {
  let call = 0;
  const data = new IntradayMarketData({
    keyId: "k",
    secretKey: "s",
    fetchImpl: (async () => {
      call += 1;
      const first = call === 1;
      return new Response(
        JSON.stringify({
          bars: {
            AAPL: [
              {
                t: first ? "2026-08-12T14:00:00Z" : "2026-08-12T14:01:00Z",
                o: 1,
                h: 1,
                l: 1,
                c: 1,
                v: 10,
              },
            ],
          },
          next_page_token: first ? "more" : null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });

  const bars = await data.fetchBars(["AAPL"], "2026-08-12T13:30:00.000Z");
  assert.equal(call, 2);
  assert.equal(bars.get("AAPL")!.length, 2, "a truncated page is a gap that reads as a quiet market");
});

test("a 4xx is not retried — the venue understood and refused", async () => {
  let calls = 0;
  const data = new IntradayMarketData({
    keyId: "k",
    secretKey: "s",
    fetchImpl: (async () => {
      calls += 1;
      return new Response("nope", { status: 403 });
    }) as unknown as typeof fetch,
  });

  await assert.rejects(() => data.fetchBars(["AAPL"], "2026-08-12T13:30:00.000Z"), /403/);
  assert.equal(calls, 1);
});
