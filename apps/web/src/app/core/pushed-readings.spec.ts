import { MILLISECONDS_PER_MINUTE } from '../shared/time';
import type { Reading } from '@tempestas/domain';
import {
  addPushedReadings,
  dropWhatTheFetchCovered,
  NO_PUSHED_READINGS,
  type PushedReadings,
} from './pushed-readings';

const FETCHED_TO = '2026-11-20T21:00:00.000Z';
const FETCHED_TO_MS = Date.parse(FETCHED_TO);
const BUCKETS_PER_DAY = 288;

function reading(createdAt: string, temperature = 4): Reading {
  return {
    id: `r-${createdAt}`,
    nodeId: 'patji',
    sensorId: 'pipes',
    temperature,
    humidity: null,
    co2: null,
    createdAt,
  };
}

function minutesAfterFetch(minutes: number): string {
  return new Date(
    FETCHED_TO_MS + minutes * MILLISECONDS_PER_MINUTE,
  ).toISOString();
}

function probeOf(pushed: PushedReadings) {
  return pushed.get('patji/pipes');
}

const BEFORE_FETCH = reading('2026-11-20T20:59:50.000Z');
const AFTER_FETCH = reading(minutesAfterFetch(0.2));
const LATER = reading(minutesAfterFetch(0.4));

describe('addPushedReadings', () => {
  it('keeps every reading while nothing has been fetched yet', () => {
    const pushed = addPushedReadings(NO_PUSHED_READINGS, [BEFORE_FETCH], null);
    expect(probeOf(pushed)?.openReadings).toEqual([BEFORE_FETCH]);
  });

  it('drops what the fetch already covered', () => {
    const beforeTheFetch = addPushedReadings(
      NO_PUSHED_READINGS,
      [BEFORE_FETCH],
      null,
    );
    const pushed = addPushedReadings(beforeTheFetch, [AFTER_FETCH], FETCHED_TO);
    expect(probeOf(pushed)?.openReadings).toEqual([AFTER_FETCH]);
  });

  it('adds each reading once, however often the latest set is seen', () => {
    const once = addPushedReadings(
      NO_PUSHED_READINGS,
      [AFTER_FETCH],
      FETCHED_TO,
    );
    const twice = addPushedReadings(once, [AFTER_FETCH], FETCHED_TO);
    const thrice = addPushedReadings(twice, [LATER], FETCHED_TO);
    expect(probeOf(thrice)?.openReadings).toEqual([AFTER_FETCH, LATER]);
  });

  it('returns the same map when nothing changed, so nothing redraws', () => {
    const pushed = addPushedReadings(
      NO_PUSHED_READINGS,
      [AFTER_FETCH],
      FETCHED_TO,
    );
    expect(addPushedReadings(pushed, [AFTER_FETCH], FETCHED_TO)).toBe(pushed);
  });

  it('folds a bucket once the probe moves past it', () => {
    const pushed = [
      reading(minutesAfterFetch(1), 2),
      reading(minutesAfterFetch(2), 4),
      reading(minutesAfterFetch(6), 9),
    ].reduce(
      (collected, next) => addPushedReadings(collected, [next], FETCHED_TO),
      NO_PUSHED_READINGS,
    );
    expect(probeOf(pushed)?.closedBuckets).toEqual([
      {
        at: FETCHED_TO,
        averageC: 3,
        lowestC: 2,
        highestC: 4,
        sampleCount: 2,
      },
    ]);
    expect(
      probeOf(pushed)?.openReadings.map((kept) => kept.temperature),
    ).toEqual([9]);
  });

  it('keeps no more than a day of buckets when nothing refetches for longer', () => {
    let pushed = NO_PUSHED_READINGS;
    for (let minute = 1; minute <= 30 * 60; minute += 1) {
      pushed = addPushedReadings(
        pushed,
        [reading(minutesAfterFetch(minute))],
        FETCHED_TO,
      );
    }
    const probe = probeOf(pushed);
    expect(probe?.closedBuckets.length).toBeLessThanOrEqual(BUCKETS_PER_DAY);
    expect(probe?.closedBuckets[0]?.at).toBe(minutesAfterFetch(6 * 60));
    expect(probe?.openReadings.length).toBeLessThanOrEqual(5);
  });
});

describe('dropWhatTheFetchCovered', () => {
  it('drops a closed bucket the fetch reached into and keeps the readings after it', () => {
    const pushed = [
      reading(minutesAfterFetch(1)),
      reading(minutesAfterFetch(6)),
      reading(minutesAfterFetch(7)),
    ].reduce(
      (collected, next) => addPushedReadings(collected, [next], FETCHED_TO),
      NO_PUSHED_READINGS,
    );
    const trimmed = dropWhatTheFetchCovered(pushed, minutesAfterFetch(6.5));
    expect(probeOf(trimmed)?.closedBuckets).toEqual([]);
    expect(
      probeOf(trimmed)?.openReadings.map((kept) => kept.createdAt),
    ).toEqual([minutesAfterFetch(7)]);
  });

  it('forgets a probe the fetch covered entirely', () => {
    const pushed = addPushedReadings(NO_PUSHED_READINGS, [AFTER_FETCH], null);
    expect(dropWhatTheFetchCovered(pushed, minutesAfterFetch(1)).size).toBe(0);
  });
});
