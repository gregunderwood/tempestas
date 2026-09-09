import { DateTime } from 'luxon';
import type { ReadingsQuery } from '@tempestas/domain';

/**
 * Resolving a query into an absolute time window, as a pure function.
 *
 * This is where a specific old bug gets fixed. The Python default ran from
 * *yesterday* 23:59:59 to *today* 23:59:59 - a window that both starts a day
 * early and extends into the future, almost certainly by accident. The echoed
 * `to` then told the dashboard it was showing data up to a time that had not
 * happened yet.
 *
 * The rules here:
 *   - `to` is NEVER in the future. An explicit `to` is clamped to now.
 *   - `days=n` aligns `from` to the start of the local day n-1 days ago, so
 *     "last 7 days" means seven calendar days including today.
 *   - With no parameters at all it is a rolling 24 hours, not a calendar day.
 *   - A reversed range is refused rather than silently swapped.
 */

export interface ReadingWindow {
  from: Date;
  to: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveReadingWindow(
  query: Pick<ReadingsQuery, 'days' | 'from' | 'to'>,
  now: Date,
  timezone: string,
): ReadingWindow {
  const to = query.to ? clampToNow(parseInstant(query.to, 'to'), now) : now;

  let from: Date;
  if (query.from) {
    from = parseInstant(query.from, 'from');
  } else if (query.days !== undefined) {
    from = startOfLocalDay(now, timezone, query.days - 1);
  } else {
    from = new Date(now.getTime() - DAY_MS);
  }

  if (from.getTime() > to.getTime()) {
    // Swapping them would hide a client bug and quietly return the wrong data.
    throw new RangeError(
      `Window starts after it ends: from=${from.toISOString()} to=${to.toISOString()}`,
    );
  }
  return { from, to };
}

function parseInstant(value: string, field: 'from' | 'to'): Date {
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) {
    throw new RangeError(`Invalid ISO-8601 timestamp for "${field}": ${value}`);
  }
  return parsed.toJSDate();
}

function clampToNow(instant: Date, now: Date): Date {
  return instant.getTime() > now.getTime() ? now : instant;
}

function startOfLocalDay(now: Date, timezone: string, daysAgo: number): Date {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) {
    throw new RangeError(
      `Invalid timezone "${timezone}": ${local.invalidReason ?? 'unknown'}`,
    );
  }
  // Calendar arithmetic before startOf, so a DST day is 23 or 25 hours long
  // rather than exactly 24 - which is the point of doing this in Luxon at all.
  return local.minus({ days: daysAgo }).startOf('day').toJSDate();
}
