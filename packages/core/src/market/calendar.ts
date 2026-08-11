/**
 * US equity trading calendar (NYSE / Nasdaq).
 *
 * Session dates are the spine of everything time-indexed: bar alignment,
 * holding-period arithmetic, the daily-loss window, forward labeling. Getting a
 * holiday wrong shifts an entire return series by a day and quietly changes
 * every backtest result, so the rules are encoded explicitly rather than
 * approximated by "weekdays".
 *
 * All dates are ISO `YYYY-MM-DD` in exchange-local terms and all arithmetic is
 * done in UTC, which keeps the host machine's timezone out of the results.
 */

export type IsoDate = string;

const DAY_MS = 86_400_000;

function utc(date: IsoDate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function iso(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return iso(utc(date) + days * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  return new Date(utc(date)).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dateOf(year: number, month: number, day: number): IsoDate {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The nth given weekday of a month, e.g. the 3rd Monday of January. */
function nthWeekday(year: number, month: number, weekday: number, n: number): IsoDate {
  const first = Date.UTC(year, month - 1, 1);
  const shift = (weekday - new Date(first).getUTCDay() + 7) % 7;
  return iso(first + (shift + (n - 1) * 7) * DAY_MS);
}

function lastWeekday(year: number, month: number, weekday: number): IsoDate {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = Date.UTC(year, month - 1, lastDay);
  const shift = (new Date(last).getUTCDay() - weekday + 7) % 7;
  return iso(last - shift * DAY_MS);
}

/** Meeus/Jones/Butcher Gregorian Easter. Good Friday is the only market holiday that moves with it. */
function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dateOf(year, month, day);
}

/**
 * A fixed-date holiday falling on a weekend is observed on the adjacent
 * weekday: Saturday shifts back to Friday, Sunday forward to Monday. The NYSE
 * has followed this since 1959 — July 3 2015 and December 24 2021 were both
 * full closures for exactly this reason.
 */
function observed(date: IsoDate): IsoDate {
  const d = dayOfWeek(date);
  if (d === 6) return addDays(date, -1);
  if (d === 0) return addDays(date, 1);
  return date;
}

/**
 * Unscheduled closures. These are historical facts, not rules, so they are
 * listed: national days of mourning, the week of September 11, and Hurricane
 * Sandy. Omitting them puts phantom sessions in a backtest.
 */
const AD_HOC_CLOSURES = new Set<IsoDate>([
  "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", // September 11 attacks
  "2004-06-11", // Reagan state funeral
  "2007-01-02", // Ford state funeral
  "2012-10-29", "2012-10-30", // Hurricane Sandy
  "2018-12-05", // George H. W. Bush state funeral
  "2025-01-09", // Carter state funeral
]);

const holidayCache = new Map<number, Set<IsoDate>>();

/** Every full-day market closure in a given calendar year. */
export function marketHolidays(year: number): ReadonlySet<IsoDate> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const days = new Set<IsoDate>();
  days.add(observed(dateOf(year, 1, 1))); // New Year's Day
  days.add(nthWeekday(year, 1, 1, 3)); // MLK Jr. Day — 3rd Monday of January
  days.add(nthWeekday(year, 2, 1, 3)); // Washington's Birthday — 3rd Monday of February
  days.add(addDays(easterSunday(year), -2)); // Good Friday
  days.add(lastWeekday(year, 5, 1)); // Memorial Day — last Monday of May
  // Juneteenth became a market holiday in 2022, not retroactively.
  if (year >= 2022) days.add(observed(dateOf(year, 6, 19)));
  days.add(observed(dateOf(year, 7, 4))); // Independence Day
  days.add(nthWeekday(year, 9, 1, 1)); // Labor Day — 1st Monday of September
  days.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving — 4th Thursday of November
  days.add(observed(dateOf(year, 12, 25))); // Christmas

  for (const closure of AD_HOC_CLOSURES) {
    if (closure.startsWith(`${year}-`)) days.add(closure);
  }

  holidayCache.set(year, days);
  return days;
}

export function isTradingDay(date: IsoDate): boolean {
  if (isWeekend(date)) return false;
  const year = Number(date.slice(0, 4));
  return !marketHolidays(year).has(date);
}

/**
 * Scheduled 1:00pm ET closes. Not a full closure, but volume and volatility
 * profiles on these sessions are unlike a normal day, so any intraday feature
 * or strategy that assumes a 6.5-hour session needs to know.
 */
export function isEarlyClose(date: IsoDate): boolean {
  if (!isTradingDay(date)) return false;
  const year = Number(date.slice(0, 4));
  const dayAfterThanksgiving = addDays(nthWeekday(year, 11, 4, 4), 1);
  if (date === dayAfterThanksgiving) return true;
  // The day before Independence Day and Christmas, when both are sessions.
  for (const holiday of [dateOf(year, 7, 4), dateOf(year, 12, 25)]) {
    const eve = addDays(observed(holiday), -1);
    if (date === eve && isTradingDay(eve)) return true;
  }
  return false;
}

export function nextTradingDay(date: IsoDate): IsoDate {
  let cursor = addDays(date, 1);
  while (!isTradingDay(cursor)) cursor = addDays(cursor, 1);
  return cursor;
}

export function previousTradingDay(date: IsoDate): IsoDate {
  let cursor = addDays(date, -1);
  while (!isTradingDay(cursor)) cursor = addDays(cursor, -1);
  return cursor;
}

/** Trading days in `[from, to]`, inclusive of both endpoints when they qualify. */
export function tradingDaysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let cursor = from; utc(cursor) <= utc(to); cursor = addDays(cursor, 1)) {
    if (isTradingDay(cursor)) out.push(cursor);
  }
  return out;
}

/** The next `count` trading days starting at `from` (inclusive if it is one). */
export function tradingDaysFrom(from: IsoDate, count: number): IsoDate[] {
  const out: IsoDate[] = [];
  let cursor = from;
  while (out.length < count) {
    if (isTradingDay(cursor)) out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}
