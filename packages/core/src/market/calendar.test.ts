import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDays,
  daysBetween,
  isEarlyClose,
  isTradingDay,
  marketHolidays,
  nextTradingDay,
  previousTradingDay,
  tradingDaysBetween,
  tradingDaysFrom,
} from "./calendar.ts";

describe("trading calendar", () => {
  it("closes on the fixed and floating holidays", () => {
    // Spot-checked against the published NYSE calendars rather than derived
    // from the same rules the implementation uses.
    const closed = [
      "2024-01-01", // New Year's Day
      "2024-01-15", // MLK Jr.
      "2024-02-19", // Washington's Birthday
      "2024-03-29", // Good Friday
      "2024-05-27", // Memorial Day
      "2024-06-19", // Juneteenth
      "2024-07-04", // Independence Day
      "2024-09-02", // Labor Day
      "2024-11-28", // Thanksgiving
      "2024-12-25", // Christmas
    ];
    for (const date of closed) {
      assert.equal(isTradingDay(date), false, `${date} should be closed`);
    }
    assert.equal(marketHolidays(2024).size, closed.length);
  });

  it("observes a Saturday holiday on the preceding Friday", () => {
    // July 4 2015 fell on a Saturday; the NYSE closed Friday July 3.
    assert.equal(isTradingDay("2015-07-03"), false);
    // Christmas 2021 fell on a Saturday; December 24 was a full closure.
    assert.equal(isTradingDay("2021-12-24"), false);
  });

  it("observes a Sunday holiday on the following Monday", () => {
    // July 4 2021 fell on a Sunday; Monday July 5 was closed.
    assert.equal(isTradingDay("2021-07-05"), false);
    assert.equal(isTradingDay("2021-07-02"), true);
  });

  it("does not backdate Juneteenth before it became a market holiday", () => {
    assert.equal(isTradingDay("2021-06-18"), true, "2021 Juneteenth observance was not a closure");
    assert.equal(isTradingDay("2022-06-20"), false, "2022 Juneteenth observed Monday");
  });

  it("tracks Good Friday as it moves", () => {
    assert.equal(isTradingDay("2023-04-07"), false);
    assert.equal(isTradingDay("2025-04-18"), false);
    assert.equal(isTradingDay("2026-04-03"), false);
  });

  it("knows the unscheduled closures", () => {
    assert.equal(isTradingDay("2001-09-12"), false, "markets were shut after September 11");
    assert.equal(isTradingDay("2012-10-30"), false, "Hurricane Sandy");
    assert.equal(isTradingDay("2018-12-05"), false, "Bush state funeral");
    assert.equal(isTradingDay("2025-01-09"), false, "Carter state funeral");
  });

  it("counts the right number of sessions in a year", () => {
    // 2024 had 252 trading days.
    assert.equal(tradingDaysBetween("2024-01-01", "2024-12-31").length, 252);
    // 2012 lost two sessions to Sandy.
    assert.equal(tradingDaysBetween("2012-01-01", "2012-12-31").length, 250);
  });

  it("steps forward and back across weekends and holidays", () => {
    assert.equal(nextTradingDay("2024-12-24"), "2024-12-26");
    assert.equal(previousTradingDay("2024-12-26"), "2024-12-24");
    assert.equal(nextTradingDay("2024-08-30"), "2024-09-03", "Friday to Tuesday over Labor Day");
  });

  it("returns exactly the requested number of sessions", () => {
    const days = tradingDaysFrom("2024-11-25", 10);
    assert.equal(days.length, 10);
    assert.ok(!days.includes("2024-11-28"), "Thanksgiving is not a session");
    assert.ok(days.every(isTradingDay));
  });

  it("flags the scheduled early closes", () => {
    assert.equal(isEarlyClose("2024-11-29"), true, "day after Thanksgiving");
    assert.equal(isEarlyClose("2024-07-03"), true, "July 3 ahead of a Thursday holiday");
    assert.equal(isEarlyClose("2024-12-24"), true, "Christmas Eve");
    assert.equal(isEarlyClose("2024-11-26"), false);
    assert.equal(isEarlyClose("2024-12-25"), false, "a closure is not an early close");
  });

  it("does arithmetic in UTC regardless of host timezone", () => {
    assert.equal(addDays("2024-03-10", 1), "2024-03-11", "US DST transition");
    assert.equal(addDays("2024-02-28", 2), "2024-03-01", "leap year");
    assert.equal(daysBetween("2024-01-01", "2024-12-31"), 365);
  });
});
