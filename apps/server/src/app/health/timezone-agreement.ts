import { DateTime } from 'luxon';

export interface TimezoneDisagreement {
  timezone: string;
  serverOffset: string;
  systemOffset: string;
}

export type ReadSystemOffset = (timezone: string) => string | null;

const COMPACT_OFFSET_PATTERN = /^([+-])(\d{2})(\d{2})$/;

// Node carries its own copy of the timezone rules, so it can fall behind the OS's (BC, November 2026).
export function findTimezoneDisagreements(
  timezones: readonly string[],
  instant: Date,
  readSystemOffset: ReadSystemOffset,
): TimezoneDisagreement[] {
  return [...new Set(timezones)].flatMap((timezone) => {
    const serverOffset = readServerOffset(timezone, instant);
    const systemOffset = readSystemOffset(timezone);
    const isComparable = serverOffset !== null && systemOffset !== null;
    if (!isComparable || serverOffset === systemOffset) {
      return [];
    }
    return [{ timezone, serverOffset, systemOffset }];
  });
}

export function describeTimezoneDisagreement(
  disagreement: TimezoneDisagreement,
): string {
  return (
    `Node and the OS disagree on local time in ${disagreement.timezone}: ` +
    `Node says ${disagreement.serverOffset}, the OS says ${disagreement.systemOffset}`
  );
}

// `date +%z` prints -0700; luxon prints -07:00.
export function toColonOffset(compactOffset: string): string | null {
  const match = COMPACT_OFFSET_PATTERN.exec(compactOffset.trim());
  if (!match) {
    return null;
  }
  const [, sign, hours, minutes] = match;
  return `${sign}${hours}:${minutes}`;
}

function readServerOffset(timezone: string, instant: Date): string | null {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  return local.isValid ? local.toFormat('ZZ') : null;
}
