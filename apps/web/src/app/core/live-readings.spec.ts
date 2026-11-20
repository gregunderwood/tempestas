import { describe, expect, it } from 'vitest';
import type { Reading } from '@tempestas/domain';
import { mergeLatestReadings } from './live-readings';

const reading = (sensorId: string, temperature: number): Reading => ({
  id: `r-${sensorId}-${temperature}`,
  nodeId: 'patji',
  sensorId,
  temperature,
  humidity: null,
  co2: null,
  createdAt: '2026-11-20T21:14:00.000Z',
});

const temperaturesOf = (readings: Reading[]): number[] =>
  readings.map((merged) => merged.temperature);

describe('mergeLatestReadings', () => {
  it('replaces a fetched reading with the one pushed for the same sensor', () => {
    const merged = mergeLatestReadings([reading('pipes', 3)], {
      'patji/pipes': reading('pipes', 4),
    });
    expect(temperaturesOf(merged)).toEqual([4]);
  });

  it('keeps fetched sensors nothing was pushed for, and adds new ones', () => {
    const merged = mergeLatestReadings([reading('pipes', 3)], {
      'patji/air': reading('air', 7),
    });
    expect(temperaturesOf(merged)).toEqual([3, 7]);
  });
});
