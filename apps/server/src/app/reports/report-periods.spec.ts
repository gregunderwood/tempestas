import { DateTime } from 'luxon';
import {
  listRecentDayAndNightPeriods,
  listRecentNights,
} from './report-periods';

const TIMEZONE = 'America/Edmonton';
const DAYLIGHT = { startTime: '07:00', endTime: '17:00', timezone: TIMEZONE };

const atLocal = (iso: string): Date =>
  DateTime.fromISO(iso, { zone: TIMEZONE }).toJSDate();
const localLabel = (instant: Date): string =>
  DateTime.fromJSDate(instant, { zone: TIMEZONE }).toFormat('MM-dd HH:mm');

describe('listRecentNights', () => {
  it('lists finished nights newest first while it is day', () => {
    const nights = listRecentNights(atLocal('2026-11-24T12:00'), DAYLIGHT, 3);
    expect(
      nights.map((night) => [
        localLabel(night.from),
        localLabel(night.to),
        night.inProgress,
      ]),
    ).toEqual([
      ['11-23 17:00', '11-24 07:00', false],
      ['11-22 17:00', '11-23 07:00', false],
      ['11-21 17:00', '11-22 07:00', false],
    ]);
  });

  it('leads with tonight, still running, after dark', () => {
    const now = atLocal('2026-11-24T22:00');
    const [tonight, lastNight] = listRecentNights(now, DAYLIGHT, 2);
    expect(localLabel(tonight.from)).toBe('11-24 17:00');
    expect(tonight.to).toEqual(now);
    expect(tonight.inProgress).toBe(true);
    expect(localLabel(lastNight.from)).toBe('11-23 17:00');
    expect(lastNight.inProgress).toBe(false);
  });

  it('has no nights for a zero-length daylight window', () => {
    expect(
      listRecentNights(
        atLocal('2026-11-24T12:00'),
        { ...DAYLIGHT, endTime: DAYLIGHT.startTime },
        3,
      ),
    ).toEqual([]);
  });
});

describe('listRecentDayAndNightPeriods', () => {
  it('alternates day and night, newest first, two per day', () => {
    const periods = listRecentDayAndNightPeriods(
      atLocal('2026-11-24T12:00'),
      DAYLIGHT,
      2,
    );
    expect(
      periods.map((period) => [
        period.kind,
        localLabel(period.from),
        period.inProgress,
      ]),
    ).toEqual([
      ['day', '11-24 07:00', true],
      ['night', '11-23 17:00', false],
      ['day', '11-23 07:00', false],
      ['night', '11-22 17:00', false],
    ]);
  });

  it('has no periods for a zero-length daylight window', () => {
    expect(
      listRecentDayAndNightPeriods(
        atLocal('2026-11-24T12:00'),
        { ...DAYLIGHT, endTime: DAYLIGHT.startTime },
        2,
      ),
    ).toEqual([]);
  });
});
