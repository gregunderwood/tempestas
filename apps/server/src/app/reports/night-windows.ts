import { resolveSegments } from '../readings/daylight-segments';
import type { Daylight } from '../readings/zone-daylight';

export interface NightWindow {
  from: Date;
  to: Date;
  inProgress: boolean;
}

const SEGMENTS_PER_DAY = 2;

/** Newest first. Empty for a zero-length daylight window, which has no nights to speak of. */
export function listRecentNights(
  now: Date,
  daylight: Daylight,
  count: number,
): NightWindow[] {
  const segments =
    resolveSegments(
      now,
      daylight.startTime,
      daylight.endTime,
      daylight.timezone,
      count * SEGMENTS_PER_DAY + 1,
    ) ?? [];
  const runningIndex = segments.length - 1;
  return segments
    .map((segment, index) => ({
      ...segment,
      inProgress: index === runningIndex,
    }))
    .filter((segment) => segment.kind === 'night')
    .slice(-count)
    .reverse()
    .map(({ from, to, inProgress }) => ({ from, to, inProgress }));
}
