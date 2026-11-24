import type { Reading } from '@tempestas/domain';
import { addNewReadings } from './live-zone-history';

function reading(id: string, createdAt: string): Reading {
  return {
    id,
    nodeId: 'patji',
    sensorId: 'pipes',
    temperature: 4,
    humidity: null,
    co2: null,
    createdAt,
  };
}

const FETCHED_TO = '2026-11-20T21:00:00.000Z';
const BEFORE_FETCH = reading('r-before', '2026-11-20T20:59:50.000Z');
const AFTER_FETCH = reading('r-after', '2026-11-20T21:00:10.000Z');
const LATER = reading('r-later', '2026-11-20T21:00:20.000Z');

describe('addNewReadings', () => {
  it('keeps every reading while nothing has been fetched yet', () => {
    expect(addNewReadings([], [BEFORE_FETCH], null)).toEqual([BEFORE_FETCH]);
  });

  it('drops what the fetch already covered', () => {
    expect(addNewReadings([BEFORE_FETCH], [AFTER_FETCH], FETCHED_TO)).toEqual([
      AFTER_FETCH,
    ]);
  });

  it('adds each reading once, however often the latest set is seen', () => {
    const once = addNewReadings([], [AFTER_FETCH], FETCHED_TO);
    const twice = addNewReadings(once, [AFTER_FETCH, LATER], FETCHED_TO);
    expect(twice).toEqual([AFTER_FETCH, LATER]);
  });

  it('returns the same list when nothing changed, so nothing redraws', () => {
    const collected = [AFTER_FETCH];
    expect(addNewReadings(collected, [AFTER_FETCH], FETCHED_TO)).toBe(
      collected,
    );
  });
});
