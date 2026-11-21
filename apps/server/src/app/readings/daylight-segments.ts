import { DateTime } from 'luxon';
import { MINUTES_PER_HOUR } from '../common/time-units';
// The same parser the rules engine branches on, so the two cannot disagree about a boundary.
import { parseWallClock } from '../rules/rules.engine';

export type SegmentKind = 'day' | 'night';

export interface Segment {
  kind: SegmentKind;
  from: Date;
  to: Date;
}

/** The most recent period is last, and it is the one still running. */
export type Segments = Segment[];

interface Boundary {
  at: DateTime;
  begins: SegmentKind;
}

interface DaylightMinutes {
  startMinutes: number;
  endMinutes: number;
}

const DEFAULT_SEGMENT_COUNT = 3;
const EXTRA_DAYS_BEHIND = 2;
const DAYS_AHEAD = 1;

export function findNextBoundary(
  now: Date,
  startTime: string,
  endTime: string,
  timezone: string,
): Date | null {
  const daylight = parseDaylightMinutes(startTime, endTime);
  if (!daylight) return null;

  const local = localNow(now, timezone);
  const future = listBoundaries(local, daylight, 1).find(
    (boundary) => boundary.at.toMillis() > local.toMillis(),
  );
  return future ? future.at.toJSDate() : null;
}

/** Null for a zero-length daylight window: guessing would make a config typo look confident. */
export function resolveSegments(
  now: Date,
  startTime: string,
  endTime: string,
  timezone: string,
  count = DEFAULT_SEGMENT_COUNT,
): Segments | null {
  const daylight = parseDaylightMinutes(startTime, endTime);
  if (!daylight) return null;

  const local = localNow(now, timezone);
  const starts = listBoundaries(local, daylight, count)
    .filter((boundary) => boundary.at.toMillis() <= local.toMillis())
    .slice(-count);

  return starts.map((start, index) => ({
    kind: start.begins,
    from: start.at.toJSDate(),
    to: isLast(starts, index) ? now : starts[index + 1].at.toJSDate(),
  }));
}

function parseDaylightMinutes(
  startTime: string,
  endTime: string,
): DaylightMinutes | null {
  const startMinutes = parseWallClock(startTime);
  const endMinutes = parseWallClock(endTime);
  if (startMinutes === endMinutes) return null;
  return { startMinutes, endMinutes };
}

function localNow(now: Date, timezone: string): DateTime {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) {
    // A bad IANA name must not silently fall back to the host zone.
    throw new Error(
      `Invalid timezone "${timezone}": ${local.invalidReason ?? 'unknown'}`,
    );
  }
  return local;
}

// Two boundaries per local day, over enough days to cover `count` periods whatever the window shape.
function listBoundaries(
  local: DateTime,
  daylight: DaylightMinutes,
  count: number,
): Boundary[] {
  const boundaries: Boundary[] = [];
  const firstDayOffset = -(count + EXTRA_DAYS_BEHIND);
  for (let dayOffset = firstDayOffset; dayOffset <= DAYS_AHEAD; dayOffset++) {
    const day = local.startOf('day').plus({ days: dayOffset });
    boundaries.push({
      at: setWallClock(day, daylight.startMinutes),
      begins: 'day',
    });
    boundaries.push({
      at: setWallClock(day, daylight.endMinutes),
      begins: 'night',
    });
  }
  return boundaries.sort(
    (first, second) => first.at.toMillis() - second.at.toMillis(),
  );
}

// Set the wall clock, never add minutes to midnight: a spring-forward day skips an hour.
function setWallClock(day: DateTime, minutesSinceMidnight: number): DateTime {
  return day.set({
    hour: Math.floor(minutesSinceMidnight / MINUTES_PER_HOUR),
    minute: minutesSinceMidnight % MINUTES_PER_HOUR,
    second: 0,
    millisecond: 0,
  });
}

function isLast(items: readonly unknown[], index: number): boolean {
  return index === items.length - 1;
}
