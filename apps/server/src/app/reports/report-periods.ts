import type { PeriodKind } from '@tempestas/domain';
import { resolveSegments } from '../readings/daylight-segments';
import type { Daylight } from '../readings/zone-daylight';

export interface NightWindow {
  from: Date;
  to: Date;
  inProgress: boolean;
}

export interface ReportPeriod extends NightWindow {
  kind: PeriodKind;
}

const PERIODS_PER_DAY = 2;

/** Newest first. Empty for a zero-length daylight window, which has no nights to speak of. */
export function listRecentNights(
  now: Date,
  daylight: Daylight,
  count: number,
): NightWindow[] {
  return listRecentPeriods(now, daylight, count * PERIODS_PER_DAY + 1)
    .filter((period) => period.kind === 'night')
    .slice(0, count)
    .map(({ from, to, inProgress }) => ({ from, to, inProgress }));
}

/** Daylight and night periods over the last `days` days, newest first, starting with the running one. */
export function listRecentDayAndNightPeriods(
  now: Date,
  daylight: Daylight,
  days: number,
): ReportPeriod[] {
  return listRecentPeriods(now, daylight, days * PERIODS_PER_DAY);
}

function listRecentPeriods(
  now: Date,
  daylight: Daylight,
  count: number,
): ReportPeriod[] {
  const segments =
    resolveSegments(
      now,
      daylight.startTime,
      daylight.endTime,
      daylight.timezone,
      count,
    ) ?? [];
  const runningIndex = segments.length - 1;
  return segments
    .map((segment, index) => ({
      kind: segment.kind,
      from: segment.from,
      to: segment.to,
      inProgress: index === runningIndex,
    }))
    .reverse();
}

export function findEarliestStart(
  periods: readonly NightWindow[],
  now: Date,
): Date {
  const starts = periods.map((period) => period.from.getTime());
  return new Date(Math.min(now.getTime(), ...starts));
}
