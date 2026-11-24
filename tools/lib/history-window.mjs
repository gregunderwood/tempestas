import { DateTime } from 'luxon';

export const HISTORY_DAYS = 30;
export const DEFAULT_TIMEZONE = 'America/Vancouver';

export function findHistoryStart(now, timezone) {
  return startOfLocalDay(now, timezone)
    .minus({ days: HISTORY_DAYS })
    .toJSDate();
}

export function startOfLocalDay(instant, timezone) {
  return DateTime.fromJSDate(instant, { zone: timezone }).startOf('day');
}

export function countDaysAgo(localDay, now) {
  const today = startOfLocalDay(now, localDay.zoneName);
  return Math.round(today.diff(localDay.startOf('day'), 'days').days);
}
