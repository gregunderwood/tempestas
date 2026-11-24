export const MILLISECONDS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const MILLISECONDS_PER_MINUTE =
  SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

// setTimeout overflows past this and fires immediately.
export const LONGEST_TIMEOUT_MILLISECONDS = 2_147_483_647;

export function secondsSince(isoTime: string, now: number): number {
  return Math.max(
    0,
    Math.round((now - Date.parse(isoTime)) / MILLISECONDS_PER_SECOND),
  );
}
