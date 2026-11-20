import { describe, expect, it } from 'vitest';
import type { Reading } from '@tempestas/domain';
import { mergeLatestReadings } from './live-readings';

const reading = (
  sensorId: string,
  temperature: number,
  createdAt = '2026-11-20T21:14:00.000Z',
): Reading => ({
  id: `r-${sensorId}-${temperature}`,
  nodeId: 'patji',
  sensorId,
  temperature,
  humidity: null,
  co2: null,
  createdAt,
});

const temperaturesOf = (readings: Reading[]): number[] =>
  readings.map((merged) => merged.temperature);

describe('mergeLatestReadings', () => {
  it('replaces a fetched reading with a newer one pushed for the same sensor', () => {
    const merged = mergeLatestReadings(
      [reading('pipes', 3, '2026-11-20T21:13:00.000Z')],
      { 'patji/pipes': reading('pipes', 4, '2026-11-20T21:14:00.000Z') },
    );
    expect(temperaturesOf(merged)).toEqual([4]);
  });

  it('keeps a fetched reading newer than one pushed before the socket dropped', () => {
    const merged = mergeLatestReadings(
      [reading('pipes', 3, '2026-11-20T21:14:00.000Z')],
      { 'patji/pipes': reading('pipes', 4, '2026-11-20T21:09:00.000Z') },
    );
    expect(temperaturesOf(merged)).toEqual([3]);
  });

  it('keeps fetched sensors nothing was pushed for, and adds new ones', () => {
    const merged = mergeLatestReadings([reading('pipes', 3)], {
      'patji/air': reading('air', 7),
    });
    expect(temperaturesOf(merged)).toEqual([3, 7]);
  });
});
