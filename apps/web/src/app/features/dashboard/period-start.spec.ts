import type { DayNightStats, Reading } from '@tempestas/domain';
import {
  PERIOD_START_RETRY_MILLISECONDS,
  buildPeriodStarts,
  chooseNextPeriodLoadDelay,
  isBaselineDue,
  replaceCurrentPeriod,
  type CurrentPeriod,
  type PeriodLookup,
  type SensorBaseline,
} from './period-start';

const NOW = Date.parse('2026-11-20T21:00:00.000Z');
const MINUTE_MILLISECONDS = 60_000;

function minutesFromNow(minutes: number): string {
  return new Date(NOW + minutes * MINUTE_MILLISECONDS).toISOString();
}

function period(from: string, endsAt: string | null): CurrentPeriod {
  return { kind: 'night', from, endsAt };
}

function lookup(
  current: CurrentPeriod | null,
  nextBoundary: string | null,
): PeriodLookup {
  return { stats: { nextBoundary } as DayNightStats, period: current };
}

function pipesReading(createdAt: string): Reading {
  return { nodeId: 'patji', sensorId: 'pipes', createdAt } as Reading;
}

function baselineOf(
  periodFrom: string,
  reading: Reading | null,
  failedAt: number | null = null,
): ReadonlyMap<string, SensorBaseline> {
  return new Map([['patji/pipes', { periodFrom, reading, failedAt }]]);
}

const NIGHT = period(minutesFromNow(-60), minutesFromNow(600));

describe('replaceCurrentPeriod', () => {
  it('takes the new period when the lookup succeeds', () => {
    const fresh = period(minutesFromNow(-1), minutesFromNow(600));
    const periods = replaceCurrentPeriod(
      new Map([['patji', period(minutesFromNow(-700), minutesFromNow(-1))]]),
      'patji',
      lookup(fresh, minutesFromNow(600)),
      NOW,
    );
    expect(periods.get('patji')).toBe(fresh);
  });

  it('keeps the period through a failed lookup while it runs', () => {
    const periods = replaceCurrentPeriod(
      new Map([['patji', NIGHT]]),
      'patji',
      null,
      NOW,
    );
    expect(periods.get('patji')).toBe(NIGHT);
  });

  // Otherwise a failed request at dawn leaves "since night fell" on screen measured from the night.
  it('drops the period after a failed lookup once it has ended', () => {
    const periods = replaceCurrentPeriod(
      new Map([['patji', period(minutesFromNow(-700), minutesFromNow(-1))]]),
      'patji',
      null,
      NOW,
    );
    expect(periods.has('patji')).toBe(false);
  });

  it('drops the period when the server says none is running', () => {
    const periods = replaceCurrentPeriod(
      new Map([['patji', NIGHT]]),
      'patji',
      lookup(null, null),
      NOW,
    );
    expect(periods.has('patji')).toBe(false);
  });
});

describe('chooseNextPeriodLoadDelay', () => {
  it('retries a failed lookup after a minute', () => {
    expect(chooseNextPeriodLoadDelay(null, NOW)).toBe(
      PERIOD_START_RETRY_MILLISECONDS,
    );
  });

  it('waits for the period to end', () => {
    expect(
      chooseNextPeriodLoadDelay(lookup(NIGHT, minutesFromNow(600)), NOW),
    ).toBe(600 * MINUTE_MILLISECONDS);
  });

  // A phone clock ahead of the server's would otherwise see the boundary as past and ask in a loop.
  it('never asks again faster than a retry, even when the boundary looks past', () => {
    expect(
      chooseNextPeriodLoadDelay(lookup(NIGHT, minutesFromNow(-2)), NOW),
    ).toBe(PERIOD_START_RETRY_MILLISECONDS);
  });

  it('stops when there is no boundary to wait for', () => {
    expect(chooseNextPeriodLoadDelay(lookup(null, null), NOW)).toBeNull();
  });
});

describe('isBaselineDue', () => {
  it('asks once the sensor has spoken this period', () => {
    expect(
      isBaselineDue(pipesReading(minutesFromNow(0)), NIGHT, new Map(), NOW),
    ).toBe(true);
  });

  it('never asks about a sensor that has been quiet all period', () => {
    expect(
      isBaselineDue(pipesReading(minutesFromNow(-90)), NIGHT, new Map(), NOW),
    ).toBe(false);
  });

  it('waits for the period before asking', () => {
    expect(
      isBaselineDue(pipesReading(minutesFromNow(0)), undefined, new Map(), NOW),
    ).toBe(false);
  });

  it('does not ask again once it has a baseline', () => {
    const known = baselineOf(NIGHT.from, pipesReading(NIGHT.from));
    expect(
      isBaselineDue(pipesReading(minutesFromNow(0)), NIGHT, known, NOW),
    ).toBe(false);
  });

  it('asks again for a new period', () => {
    const known = baselineOf(minutesFromNow(-700), pipesReading(NIGHT.from));
    expect(
      isBaselineDue(pipesReading(minutesFromNow(0)), NIGHT, known, NOW),
    ).toBe(true);
  });

  it('asks again a minute after a failed request, not sooner', () => {
    const failedJustNow = baselineOf(NIGHT.from, null, NOW);
    const failedAMinuteAgo = baselineOf(
      NIGHT.from,
      null,
      NOW - PERIOD_START_RETRY_MILLISECONDS,
    );
    const live = pipesReading(minutesFromNow(0));
    expect(isBaselineDue(live, NIGHT, failedJustNow, NOW)).toBe(false);
    expect(isBaselineDue(live, NIGHT, failedAMinuteAgo, NOW)).toBe(true);
  });

  // A slow reply over WiFi must not be joined by a second request for the same row.
  it('never asks again while a request is still out', () => {
    const inFlight = baselineOf(NIGHT.from, null, null);
    expect(
      isBaselineDue(
        pipesReading(minutesFromNow(0)),
        NIGHT,
        inFlight,
        NOW + 10 * MINUTE_MILLISECONDS,
      ),
    ).toBe(false);
  });
});

describe('buildPeriodStarts', () => {
  it("keeps only the running period's baselines", () => {
    const first = pipesReading(NIGHT.from);
    const starts = buildPeriodStarts(
      new Map([['patji', NIGHT]]),
      new Map<string, SensorBaseline>([
        [
          'patji/pipes',
          { periodFrom: NIGHT.from, reading: first, failedAt: null },
        ],
        [
          'patji/air',
          {
            periodFrom: minutesFromNow(-700),
            reading: { ...first, sensorId: 'air' },
            failedAt: null,
          },
        ],
      ]),
    );
    expect([...(starts.get('patji')?.readingsBySensor.keys() ?? [])]).toEqual([
      'pipes',
    ]);
    expect(starts.get('patji')?.kind).toBe('night');
  });
});
