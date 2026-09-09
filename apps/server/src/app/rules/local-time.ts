import { DateTime } from 'luxon';

/**
 * The one place an instant becomes a local wall clock.
 *
 * This exists as its own module because it is the defect being fixed. The Python
 * system resolved local time through the host's *current* UTC offset, so a
 * reading taken in July was interpreted with January's offset and every
 * historical query was an hour out across a DST boundary. Luxon with an explicit
 * IANA zone resolves each instant with *its own* offset.
 *
 * RULE: nothing here reads the host locale or the host timezone. The zone is
 * always passed in, and it comes from the zone row's `rulesConfig.timezone`.
 */

/**
 * Minutes since local midnight for `instant` in `zone`.
 *
 * Note what this deliberately does NOT do: it does not attempt to make the two
 * distinct instants that both read 01:30 on a fall-back night distinguishable.
 * They are the same wall clock, they get the same number, and the rules engine
 * is right to treat them identically - "is it night?" has one answer at 01:30
 * however many times 01:30 happens.
 */
export function minutesSinceMidnight(instant: Date, zone: string): number {
  const local = DateTime.fromJSDate(instant, { zone });
  if (!local.isValid) {
    // A bad IANA name must not silently fall back to the host zone: that is
    // exactly the bug this module exists to prevent.
    throw new Error(
      `Invalid timezone "${zone}": ${local.invalidReason ?? 'unknown'}`,
    );
  }
  return local.hour * 60 + local.minute;
}

/** `"2026-01-10T20:04:00Z"` in America/Vancouver -> `"12:04"`. For logs and the API. */
export function localTimeLabel(instant: Date, zone: string): string {
  const local = DateTime.fromJSDate(instant, { zone });
  if (!local.isValid) {
    throw new Error(
      `Invalid timezone "${zone}": ${local.invalidReason ?? 'unknown'}`,
    );
  }
  return local.toFormat('HH:mm');
}
