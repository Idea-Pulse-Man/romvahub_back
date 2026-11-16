/**
 * Date handling across the API boundary.
 *
 * The frontend speaks two string formats and no others:
 *
 *   - **date-only** — `YYYY-MM-DD` (`bidDate`, `followUpDate`, `dateOfBirth`,
 *     commitment dates). Rendered with `date-fns`, never timezone-shifted.
 *   - **month-only** — `YYYY-MM` (work history and education). A Resume prints
 *     "Aug 2024"; the day was precision the data never actually had, and asking
 *     for one invited a wrong answer to a question nobody reads.
 *   - **naive datetime** — `YYYY-MM-DDTHH:mm:ss` with no offset suffix
 *     (`InterviewRound.dateTime`). The frontend builds these as
 *     `` `${date}T${time}:00` `` and reads them back with `parseISO`, which
 *     treats them as local wall-clock.
 *
 * Both are stored in Postgres as `DATE` / `TIMESTAMP` (no timezone) and moved
 * through JS `Date` objects **anchored to UTC**, so the calendar fields the user
 * typed are the calendar fields that come back. `createdAt` / `updatedAt` are
 * genuine instants and keep their full ISO-8601 `Z` form.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_ONLY = /^\d{4}-\d{2}$/;
const NAIVE_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function isMonthOnly(value: string): boolean {
  return MONTH_ONLY.test(value) && !Number.isNaN(Date.parse(`${value}-01T00:00:00Z`));
}

/**
 * `YYYY-MM-DD` or `YYYY-MM` -> `YYYY-MM`.
 *
 * Accepting the longer form is what lets a data export taken before the change,
 * or a client that has not caught up, still import: the day is simply dropped,
 * which is the only sensible reading of it.
 */
export function toMonthOnly(value: string): string {
  return value.slice(0, 7);
}

export function isNaiveDateTime(value: string): boolean {
  return NAIVE_DATE_TIME.test(value) && !Number.isNaN(Date.parse(`${normalizeSeconds(value)}Z`));
}

function normalizeSeconds(value: string): string {
  return value.length === 16 ? `${value}:00` : value;
}

/** `YYYY-MM-DD` -> a `Date` at UTC midnight, ready for a `DATE` column. */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** A `DATE` column value -> `YYYY-MM-DD`. */
export function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH:mm[:ss]` -> a `Date` holding those exact fields in UTC. */
export function parseNaiveDateTime(value: string): Date {
  return new Date(`${normalizeSeconds(value)}.000Z`);
}

/** A `TIMESTAMP` column value -> `YYYY-MM-DDTHH:mm:ss`, no offset suffix. */
export function formatNaiveDateTime(value: Date): string {
  return value.toISOString().slice(0, 19);
}

/** A true instant -> full ISO-8601 with `Z`, for `createdAt` / `updatedAt`. */
export function formatInstant(value: Date): string {
  return value.toISOString();
}

/**
 * "Now", expressed in the same UTC-anchored frame the naive datetimes live in,
 * so that comparing an interview time against it is a wall-clock comparison.
 * `offsetMinutes` is the client's UTC offset as reported by
 * `Date.prototype.getTimezoneOffset()` (positive west of UTC).
 */
export function naiveNow(offsetMinutes = 0): Date {
  return new Date(Date.now() - offsetMinutes * 60_000);
}

/** Midnight UTC on the day `days` before `from`. */
export function startOfDayUtc(from: Date, days = 0): Date {
  const date = new Date(from);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}
