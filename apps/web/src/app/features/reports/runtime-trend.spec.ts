import type { DeviceRuntimeDay } from '@tempestas/domain';
import {
  buildTrendBars,
  countDaysWithCappedRun,
  describeDay,
  findShortestRunMinutes,
  TREND_BAR_PITCH,
  TREND_HEIGHT,
} from './runtime-trend';

function runtimeDay(
  overrides: Partial<DeviceRuntimeDay> = {},
): DeviceRuntimeDay {
  return {
    date: '2026-09-09',
    hoursOn: 0,
    hoursOff: 24,
    hoursUnknown: 0,
    starts: 0,
    shortestRunMinutes: null,
    hasRunCappedAtLastSeen: false,
    ...overrides,
  };
}

describe('buildTrendBars', () => {
  it('draws hours on from the baseline, scaled to a whole day', () => {
    const [bar] = buildTrendBars([runtimeDay({ hoursOn: 12 })]);
    expect(bar.onHeight).toBe(TREND_HEIGHT / 2);
    expect(bar.onY).toBe(TREND_HEIGHT / 2);
  });

  it('stacks unknown hours on top of hours on, so unknown is shown rather than read as off', () => {
    const [bar] = buildTrendBars([runtimeDay({ hoursOn: 6, hoursUnknown: 6 })]);
    expect(bar.unknownHeight).toBe(TREND_HEIGHT / 4);
    expect(bar.unknownY).toBe(TREND_HEIGHT / 2);
  });

  it('keeps a 25-hour DST day inside the chart', () => {
    const [bar] = buildTrendBars([runtimeDay({ hoursOn: 25 })]);
    expect(bar.onY).toBe(0);
  });

  it('places days left to right, oldest first', () => {
    const bars = buildTrendBars([
      runtimeDay({ date: '2026-09-08' }),
      runtimeDay({ date: '2026-09-09' }),
    ]);
    expect(bars.map((bar) => bar.x)).toEqual([0, TREND_BAR_PITCH]);
  });
});

describe('describeDay', () => {
  it('says what happened in words', () => {
    expect(
      describeDay(
        runtimeDay({
          hoursOn: 2.5,
          hoursUnknown: 1,
          starts: 1,
          shortestRunMinutes: 4,
          hasRunCappedAtLastSeen: true,
        }),
      ),
    ).toBe(
      '2026-09-09: 2.5 h on, 1 start, shortest run 4.0 min, 1.0 h unknown, a run cut at the node going offline',
    );
  });

  it('leaves out what did not happen', () => {
    expect(describeDay(runtimeDay({ starts: 3 }))).toBe(
      '2026-09-09: 0.0 h on, 3 starts',
    );
  });
});

describe('findShortestRunMinutes', () => {
  it('is the shortest across the days that had a complete run', () => {
    expect(
      findShortestRunMinutes([
        runtimeDay({ shortestRunMinutes: 12 }),
        runtimeDay(),
        runtimeDay({ shortestRunMinutes: 3 }),
      ]),
    ).toBe(3);
  });

  it('is null when no run was measured', () => {
    expect(findShortestRunMinutes([runtimeDay()])).toBeNull();
  });
});

describe('countDaysWithCappedRun', () => {
  it('counts the days with a run cut at last-seen', () => {
    expect(
      countDaysWithCappedRun([
        runtimeDay({ hasRunCappedAtLastSeen: true }),
        runtimeDay(),
      ]),
    ).toBe(1);
  });
});
