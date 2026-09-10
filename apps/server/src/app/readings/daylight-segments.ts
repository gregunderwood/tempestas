import { DateTime } from 'luxon';

/**
 * The last few alternating daylight and night periods, oldest first, ending
 * with the one still running.
 *
 * Not "all the daylight readings in the last 24 hours" - that mixes this
 * morning with yesterday afternoon and averages two different days together.
 * Each period here is contiguous, so by day the sequence reads previous day,
 * last night, today so far; by night, previous night, yesterday's daylight,
 * tonight so far.
 *
 * It matters because the burner wears two hats. By day it is CO2 enrichment
 * and failing it off costs nothing; by night it is the heat source. A minimum
 * of 4 °C means the night rule did its job, or that something went wrong at
 * midday, and only the period it belongs to says which.
 *
 * The boundary is the zone's own `thresholds.startTime`/`endTime`, the pair the
 * rules engine branches on. A second definition of night living here would
 * eventually disagree with the one that drives the relay.
 *
 * RULE: nothing here reads the host timezone. Boundaries are built in the given
 * IANA zone with Luxon, so each one lands on the correct instant across a DST
 * change rather than being computed from one fixed offset.
 */

export type SegmentKind = 'day' | 'night';

export interface Segment {
  kind: SegmentKind;
  from: Date;
  to: Date;
}

/** The most recent period is last, and it is the one still running. */
export type Segments = Segment[];

/** Minutes since local midnight. Mirrors `parseWallClock` in the rules engine. */
export function wallClockMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid wall-clock time "${value}"; expected HH:MM`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid wall-clock time "${value}"; expected HH:MM`);
  }
  return hours * 60 + minutes;
}

/**
 * Resolve the `count` most recent periods, oldest first.
 *
 * Works by listing the boundary instants of the last several local days and
 * taking those that have already happened. Doing it that way means the
 * midnight-crossing case needs no special handling: a night window of 18:30 to
 * 06:30 produces the same ordered list of boundaries as any other, and it is
 * the normal shape here rather than an edge case.
 *
 * Returns null when `startTime` equals `endTime`. That is a zero-length
 * daylight window, so there are no alternating periods to show - and guessing
 * would turn a mistyped config into a confident, wrong answer.
 */
export function resolveSegments(
  now: Date,
  startTime: string,
  endTime: string,
  timezone: string,
  count = 3,
): Segments | null {
  const startMinutes = wallClockMinutes(startTime);
  const endMinutes = wallClockMinutes(endTime);
  if (startMinutes === endMinutes) {
    return null;
  }

  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) {
    // A bad IANA name must not silently fall back to the host zone.
    throw new Error(
      `Invalid timezone "${timezone}": ${local.invalidReason ?? 'unknown'}`,
    );
  }

  // Each local day contributes two boundaries, so this reaches back further
  // than `count` periods whatever the window shape, and it is cheap.
  // SET the wall clock, never ADD minutes to midnight. On a spring-forward day
  // the clock skips an hour, so midnight plus 390 minutes is 07:30 local, not
  // 06:30 - the boundary lands an hour late and the period is mislabelled.
  // `set` resolves the intended local time instead.
  const boundaryAt = (day: DateTime, minutes: number): DateTime =>
    day.set({
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
      second: 0,
      millisecond: 0,
    });

  const boundaries: { at: DateTime; begins: SegmentKind }[] = [];
  for (let dayOffset = -(count + 2); dayOffset <= 1; dayOffset++) {
    const day = local.startOf('day').plus({ days: dayOffset });
    boundaries.push({ at: boundaryAt(day, startMinutes), begins: 'day' });
    boundaries.push({ at: boundaryAt(day, endMinutes), begins: 'night' });
  }
  boundaries.sort((a, b) => a.at.toMillis() - b.at.toMillis());

  const past = boundaries.filter((b) => b.at.toMillis() <= local.toMillis());
  const starts = past.slice(-count);

  // Each period ends where the next one begins; the last ends at `now`.
  return starts.map((start, i) => ({
    kind: start.begins,
    from: start.at.toJSDate(),
    to: i === starts.length - 1 ? now : starts[i + 1].at.toJSDate(),
  }));
}
