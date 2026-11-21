import { DateTime } from 'luxon';
import { isWithinWindow } from '../rules/rules.engine';
import {
  resolveSegments,
  parseWallClockMinutes,
  type Segments,
} from './daylight-segments';

const TIMEZONE = 'America/Vancouver';
const DAY_START = '06:30';
const DAY_END = '18:30';

const atLocal = (iso: string) =>
  DateTime.fromISO(iso, { zone: TIMEZONE }).toJSDate();
const localLabel = (instant: Date) =>
  DateTime.fromJSDate(instant, { zone: TIMEZONE }).toFormat('yyyy-MM-dd HH:mm');

function segmentsAt(nowIso: string): Segments {
  const result = resolveSegments(atLocal(nowIso), DAY_START, DAY_END, TIMEZONE);
  if (!result) throw new Error('expected segments');
  return result;
}

describe('parseWallClockMinutes', () => {
  it.each([
    ['00:00', 0],
    ['06:30', 390],
    ['18:30', 1110],
    ['23:59', 1439],
  ])('%s is %s minutes', (value, expected) => {
    expect(parseWallClockMinutes(value)).toBe(expected);
  });

  it.each(['24:00', '12:60', '6:5', 'noon', ''])(
    'refuses %s rather than guessing',
    (value) => {
      expect(() => parseWallClockMinutes(value)).toThrow(/wall-clock/);
    },
  );
});

describe('resolveSegments', () => {
  // Contiguous periods, not a 24-hour window that drags yesterday afternoon in with this morning.
  it('during the day ends with today so far', () => {
    const periods = segmentsAt('2026-09-10T15:00');
    expect(periods.map((period) => period.kind)).toEqual([
      'day',
      'night',
      'day',
    ]);
    expect(periods.map((period) => localLabel(period.from))).toEqual([
      '2026-09-09 06:30',
      '2026-09-09 18:30',
      '2026-09-10 06:30',
    ]);
    expect(localLabel(periods[2].to)).toBe('2026-09-10 15:00');
  });

  // At night the same rule gives the mirror image.
  it('in the evening ends with tonight so far', () => {
    const periods = segmentsAt('2026-09-10T21:00');
    expect(periods.map((period) => period.kind)).toEqual([
      'night',
      'day',
      'night',
    ]);
    expect(periods.map((period) => localLabel(period.from))).toEqual([
      '2026-09-09 18:30',
      '2026-09-10 06:30',
      '2026-09-10 18:30',
    ]);
    expect(localLabel(periods[2].to)).toBe('2026-09-10 21:00');
  });

  // Getting this wrong would report a period starting a few hours in the future.
  it('after midnight the running night still starts the evening before', () => {
    const periods = segmentsAt('2026-09-11T02:00');
    const running = periods[periods.length - 1];
    expect(running.kind).toBe('night');
    expect(localLabel(running.from)).toBe('2026-09-10 18:30');
    expect(localLabel(running.to)).toBe('2026-09-11 02:00');
  });

  it('is contiguous, alternating, and never reaches into the future', () => {
    for (const nowIso of [
      '2026-09-10T06:30',
      '2026-09-10T06:31',
      '2026-09-10T12:00',
      '2026-09-10T18:29',
      '2026-09-10T18:30',
      '2026-09-11T00:00',
      '2026-09-11T05:00',
    ]) {
      const now = atLocal(nowIso);
      const periods = segmentsAt(nowIso);
      expect(periods).toHaveLength(3);
      for (let index = 1; index < periods.length; index++) {
        const previous = periods[index - 1];
        expect(previous.to.getTime()).toBe(periods[index].from.getTime());
        expect(previous.kind).not.toBe(periods[index].kind);
      }
      expect(periods[periods.length - 1].to.getTime()).toBe(now.getTime());
    }
  });

  it('returns as many periods as asked for', () => {
    expect(
      resolveSegments(
        atLocal('2026-09-10T15:00'),
        DAY_START,
        DAY_END,
        TIMEZONE,
        5,
      ),
    ).toHaveLength(5);
  });

  // Start-inclusive: the instant the window opens is already day.
  it('treats the boundary instant as the start of the new period', () => {
    expect(segmentsAt('2026-09-10T06:30').at(-1)?.kind).toBe('day');
    expect(segmentsAt('2026-09-10T18:30').at(-1)?.kind).toBe('night');
  });

  it('returns null for a zero-length daylight window', () => {
    expect(
      resolveSegments(atLocal('2026-09-10T15:00'), '06:30', '06:30', TIMEZONE),
    ).toBe(null);
  });

  it('refuses an invalid timezone rather than falling back to the host', () => {
    expect(() =>
      resolveSegments(new Date(), DAY_START, DAY_END, 'Not/AZone'),
    ).toThrow(/Invalid timezone/);
  });

  // Adding 390 minutes to midnight on a spring-forward day lands on 07:30, not 06:30.
  it('crosses a DST change with the correct local boundary', () => {
    const periods = segmentsAt('2026-03-08T15:00');
    const running = periods[periods.length - 1];
    expect(localLabel(running.from)).toBe('2026-03-08 06:30');
    const night = periods[periods.length - 2];
    expect(localLabel(night.from)).toBe('2026-03-07 18:30');
    // 18:30 to 06:30 across spring forward is eleven hours, not twelve.
    expect((night.to.getTime() - night.from.getTime()) / 3_600_000).toBeCloseTo(
      11,
      5,
    );
  });
});

// A screen drawing the line elsewhere would explain a decision the controller never made.
describe('resolveSegments agrees with the rules engine about now', () => {
  it.each([
    ['06:30', '18:30'],
    ['18:30', '06:30'],
    ['00:00', '12:00'],
    ['23:00', '01:00'],
  ])('for a %s-%s window, at every half hour', (startTime, endTime) => {
    const start = parseWallClockMinutes(startTime);
    const end = parseWallClockMinutes(endTime);
    for (let minutes = 0; minutes < 1440; minutes += 30) {
      const now = DateTime.fromISO('2026-09-10T00:00', { zone: TIMEZONE })
        .plus({ minutes })
        .toJSDate();
      const result = resolveSegments(now, startTime, endTime, TIMEZONE);
      if (!result) throw new Error('expected segments');
      const engineSaysDay = isWithinWindow(minutes, start, end);
      expect(result[result.length - 1].kind).toBe(
        engineSaysDay ? 'day' : 'night',
      );
    }
  });
});
