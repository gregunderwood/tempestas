import { DateTime } from 'luxon';

const MINUTES_PER_HOUR = 60;

// Both fall-back 01:30s get the same number: "is it night?" has one answer at 01:30.
export function minutesSinceMidnight(instant: Date, zone: string): number {
  const local = toZonedDateTime(instant, zone);
  return local.hour * MINUTES_PER_HOUR + local.minute;
}

export function localTimeLabel(instant: Date, zone: string): string {
  return toZonedDateTime(instant, zone).toFormat('HH:mm');
}

// Never the host's zone: resolving through the host's current offset is the DST bug this module exists to fix.
function toZonedDateTime(instant: Date, zone: string): DateTime {
  const local = DateTime.fromJSDate(instant, { zone });
  if (!local.isValid) {
    throw new Error(
      `Invalid timezone "${zone}": ${local.invalidReason ?? 'unknown'}`,
    );
  }
  return local;
}
