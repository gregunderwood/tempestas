import { DateTime } from 'luxon';
import { isWithinWindow } from '../rules/rules.engine';
import {
  resolveSegments,
  wallClockMinutes,
  type Segments,
} from './daylight-segments';

const TZ = 'America/Vancouver';
const DAY_START = '06:30';
const DAY_END = '18:30';

/** A local wall-clock time in the greenhouse's zone, as an instant. */
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();
const localLabel = (d: Date) =>
  DateTime.fromJSDate(d, { zone: TZ }).toFormat('yyyy-MM-dd HH:mm');

function segments(nowIso: string): Segments {
  const result = resolveSegments(at(nowIso), DAY_START, DAY_END, TZ);
  if (!result) throw new Error('expected segments');
  return result;
}

describe('wallClockMinutes', () => {
  it.each([
    ['00:00', 0],
    ['06:30', 390],
    ['18:30', 1110],
    ['23:59', 1439],
  ])('%s is %s minutes', (value, expected) => {
    expect(wallClockMinutes(value)).toBe(expected);
  });

  it.each(['24:00', '12:60', '6:5', 'noon', ''])(
    'refuses %s rather than guessing',
    (value) => {
      expect(() => wallClockMinutes(value)).toThrow(/wall-clock/);
    },
  );
});

describe('resolveSegments', () => {
  // By day the sequence reads previous day, last night, today so far - three
  // contiguous periods, oldest first, rather than a 24-hour window that would
  // drag yesterday afternoon in with this morning.
  it('during the day ends with today so far', () => {
    const periods = segments('2026-09-10T15:00');
    expect(periods.map((p) => p.kind)).toEqual(['day', 'night', 'day']);
    expect(periods.map((p) => localLabel(p.from))).toEqual([
      '2026-09-09 06:30',
      '2026-09-09 18:30',
      '2026-09-10 06:30',
    ]);
    expect(localLabel(periods[2].to)).toBe('2026-09-10 15:00');
  });

  // At night the same rule gives the mirror image.
  it('in the evening ends with tonight so far', () => {
    const periods = segments('2026-09-10T21:00');
    expect(periods.map((p) => p.kind)).toEqual(['night', 'day', 'night']);
    expect(periods.map((p) => localLabel(p.from))).toEqual([
      '2026-09-09 18:30',
      '2026-09-10 06:30',
      '2026-09-10 18:30',
    ]);
    expect(localLabel(periods[2].to)).toBe('2026-09-10 21:00');
  });

  // After midnight the night in progress began YESTERDAY evening. Getting this
  // wrong would report a period starting a few hours in the future.
  it('after midnight the running night still starts the evening before', () => {
    const periods = segments('2026-09-11T02:00');
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
      const now = at(nowIso);
      const periods = segments(nowIso);
      expect(periods).toHaveLength(3);
      for (let i = 1; i < periods.length; i++) {
        expect(periods[i - 1].to.getTime()).toBe(periods[i].from.getTime());
        expect(periods[i - 1].kind).not.toBe(periods[i].kind);
      }
      expect(periods[periods.length - 1].to.getTime()).toBe(now.getTime());
    }
  });

  it('returns as many periods as asked for', () => {
    expect(
      resolveSegments(at('2026-09-10T15:00'), DAY_START, DAY_END, TZ, 5),
    ).toHaveLength(5);
  });

  // Start-inclusive: the instant the window opens is already day.
  it('treats the boundary instant as the start of the new period', () => {
    expect(segments('2026-09-10T06:30').at(-1)?.kind).toBe('day');
    expect(segments('2026-09-10T18:30').at(-1)?.kind).toBe('night');
  });

  // Guessing here would turn a mistyped config into a confident wrong answer.
  it('returns null for a zero-length daylight window', () => {
    expect(resolveSegments(at('2026-09-10T15:00'), '06:30', '06:30', TZ)).toBe(
      null,
    );
  });

  it('refuses an invalid timezone rather than falling back to the host', () => {
    expect(() =>
      resolveSegments(new Date(), DAY_START, DAY_END, 'Not/AZone'),
    ).toThrow(/Invalid timezone/);
  });

  // Boundaries are SET in the zone, not added as minutes to midnight. On a
  // spring-forward day the clock skips an hour, so adding 390 minutes lands on
  // 07:30 and every period is mislabelled - the DST bug this codebase has
  // already fixed once.
  it('crosses a DST change with the correct local boundary', () => {
    const periods = segments('2026-03-08T15:00');
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

/**
 * The screen must not draw the day/night line anywhere other than where the
 * rules engine draws it, or it explains a decision the controller never made.
 */
describe('resolveSegments agrees with the rules engine about now', () => {
  it.each([
    ['06:30', '18:30'],
    ['18:30', '06:30'],
    ['00:00', '12:00'],
    ['23:00', '01:00'],
  ])('for a %s-%s window, at every half hour', (startTime, endTime) => {
    const start = wallClockMinutes(startTime);
    const end = wallClockMinutes(endTime);
    for (let minutes = 0; minutes < 1440; minutes += 30) {
      const now = DateTime.fromISO('2026-09-10T00:00', { zone: TZ })
        .plus({ minutes })
        .toJSDate();
      const result = resolveSegments(now, startTime, endTime, TZ);
      if (!result) throw new Error('expected segments');
      const engineSaysDay = isWithinWindow(minutes, start, end);
      expect(result[result.length - 1].kind).toBe(
        engineSaysDay ? 'day' : 'night',
      );
    }
  });
});
