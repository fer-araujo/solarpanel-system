/**
 * Calendar dates as the bill writes them: `YYYY-MM-DD`, no time, no zone.
 *
 * Arithmetic runs in UTC so a day is always 24 hours; the dates themselves
 * are plant-local days copied off the meter or the recibo.
 */

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True only for a date that exists. The shape alone accepts 2026-13-01 and
 * 2026-02-31, which `Date` silently rolls over into a different day — and a
 * reading filed under the wrong day corrupts every period it touches.
 */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Last day of a `YYYY-MM` month; leap years included. */
export function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

/** Today's UTC date. Mexico runs behind UTC, so it is never before the plant's. */
export function utcToday(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The latest date a reading or a cut can carry: today, plus a day of slack
 * for a server clock and a phone that disagree around midnight.
 */
export function latestAcceptableDate(now: number = Date.now()): string {
  return addDays(utcToday(now), 1);
}
