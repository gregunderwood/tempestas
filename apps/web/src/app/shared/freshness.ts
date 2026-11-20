export const READING_QUIET_AFTER_SECONDS = 120;

export function secondsSince(isoTime: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(isoTime)) / 1000));
}
