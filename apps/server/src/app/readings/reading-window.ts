import { DateTime } from 'luxon';
import type { ReadingsQuery } from '@tempestas/domain';
import { MILLISECONDS_PER_DAY } from '../common/time-units';

export interface ReadingWindow {
  from: Date;
  to: Date;
}

type WindowQuery = Pick<ReadingsQuery, 'days' | 'from' | 'to'>;

export function resolveReadingWindow(
  query: WindowQuery,
  now: Date,
  timezone: string,
): ReadingWindow {
  const to = resolveTo(query, now);
  const from = resolveFrom(query, now, timezone);
  if (isReversed(from, to)) {
    throw new RangeError(
      `Window starts after it ends: from=${from.toISOString()} to=${to.toISOString()}`,
    );
  }
  return { from, to };
}

function resolveTo(query: WindowQuery, now: Date): Date {
  if (!query.to) return now;
  return clampToNow(parseInstant(query.to, 'to'), now);
}

function resolveFrom(query: WindowQuery, now: Date, timezone: string): Date {
  if (query.from) return parseInstant(query.from, 'from');
  if (query.days !== undefined) {
    return startOfLocalDay(now, timezone, query.days - 1);
  }
  return new Date(now.getTime() - MILLISECONDS_PER_DAY);
}

function isReversed(from: Date, to: Date): boolean {
  return from.getTime() > to.getTime();
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
  // Calendar arithmetic before startOf, so a DST day is 23 or 25 hours long.
  return local.minus({ days: daysAgo }).startOf('day').toJSDate();
}
