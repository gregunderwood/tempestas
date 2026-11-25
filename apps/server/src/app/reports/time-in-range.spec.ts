import { DeviceRole, type Reading } from '@tempestas/domain';
import type { HeldTemperatureBucketRow } from '../readings/readings.service';
import {
  summariseZoneTimeInRange,
  type PeriodWithExtreme,
  type ZoneTimeInRangeInput,
} from './time-in-range';
import type { ZoneBand } from './zone-band';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const NIGHT: PeriodWithExtreme = {
  kind: 'night',
  from: new Date('2026-11-23T02:00:00Z'),
  to: new Date('2026-11-23T03:00:00Z'),
  inProgress: false,
  extreme: null,
};

const HEAT_AND_FAN: ZoneBand = {
  lowerBounds: [{ role: DeviceRole.Heater, setpointC: 5, sensorSource: 'min' }],
  upperBounds: [
    { role: DeviceRole.ExhaustFan, setpointC: 30, sensorSource: 'max' },
  ],
};

function bucket(
  at: string,
  averageC: number,
  overrides: Partial<HeldTemperatureBucketRow> = {},
): HeldTemperatureBucketRow {
  return {
    nodeId: 'patji',
    sensorId: 'pipes',
    at: new Date(at),
    averageC,
    heldMs: FIVE_MINUTES_MS,
    ...overrides,
  };
}

function summarise(
  overrides: Partial<ZoneTimeInRangeInput>,
): ReturnType<typeof summariseZoneTimeInRange> {
  return summariseZoneTimeInRange({
    zone: {
      id: 'pumphouse-zone',
      slug: 'pumphouse',
      displayName: 'Pumphouse',
      timezone: 'America/Edmonton',
      nodeIds: ['patji'],
    },
    band: HEAT_AND_FAN,
    periods: [NIGHT],
    temperatureBuckets: [],
    ...overrides,
  });
}

describe('summariseZoneTimeInRange', () => {
  it('splits the held time into below, in range and above the band', () => {
    const [period] = summarise({
      temperatureBuckets: [
        bucket('2026-11-23T02:00:00Z', 4),
        bucket('2026-11-23T02:05:00Z', 5),
        bucket('2026-11-23T02:10:00Z', 30),
        bucket('2026-11-23T02:15:00Z', 31),
      ],
    }).periods;
    expect(period).toMatchObject({
      hoursBelow: 0.08,
      hoursInRange: 0.17,
      hoursAbove: 0.08,
      hoursWithoutReadings: 0.67,
    });
  });

  it('counts a gap in the readings as without readings, never as in range', () => {
    const [period] = summarise({
      temperatureBuckets: [
        bucket('2026-11-23T02:00:00Z', 10, { heldMs: 60_000 }),
      ],
    }).periods;
    expect(period.hoursInRange).toBe(0.02);
    expect(period.hoursWithoutReadings).toBe(0.98);
  });

  it("judges each bound by its own rule's sensor source", () => {
    const band: ZoneBand = {
      lowerBounds: [
        {
          role: DeviceRole.HeatTape,
          setpointC: 5,
          sensorSource: 'sensor:patji/pipes',
        },
      ],
      upperBounds: [],
    };
    const [period] = summarise({
      band,
      temperatureBuckets: [
        bucket('2026-11-23T02:00:00Z', 8),
        bucket('2026-11-23T02:00:00Z', 1, { sensorId: 'floor' }),
      ],
    }).periods;
    expect(period.hoursBelow).toBe(0);
    expect(period.hoursInRange).toBe(0.08);
  });

  it("falls back to the probe that trips the rule first when the rule's own probe is silent", () => {
    const band: ZoneBand = {
      lowerBounds: [
        { role: DeviceRole.Heater, setpointC: 5, sensorSource: 'node:braize' },
      ],
      upperBounds: [
        {
          role: DeviceRole.ExhaustFan,
          setpointC: 30,
          sensorSource: 'node:braize',
        },
      ],
    };
    const [period] = summarise({
      band,
      temperatureBuckets: [
        bucket('2026-11-23T02:00:00Z', 4),
        bucket('2026-11-23T02:00:00Z', 20, { sensorId: 'floor' }),
        bucket('2026-11-23T02:05:00Z', 31),
        bucket('2026-11-23T02:05:00Z', 20, { sensorId: 'floor' }),
      ],
    }).periods;
    expect(period.hoursBelow).toBe(0.08);
    expect(period.hoursAbove).toBe(0.08);
  });

  it('counts the zone as read for as long as any of its probes held', () => {
    const [period] = summarise({
      temperatureBuckets: [
        bucket('2026-11-23T02:00:00Z', 10, { heldMs: 60_000 }),
        bucket('2026-11-23T02:00:00Z', 10, {
          sensorId: 'floor',
          heldMs: FIVE_MINUTES_MS,
        }),
      ],
    }).periods;
    expect(period.hoursInRange).toBe(0.08);
  });

  it('has nothing below or above a zone with no band', () => {
    const [period] = summarise({
      band: { lowerBounds: [], upperBounds: [] },
      temperatureBuckets: [
        bucket('2026-11-23T02:00:00Z', -20),
        bucket('2026-11-23T02:05:00Z', 45),
      ],
    }).periods;
    expect(period).toMatchObject({
      hoursBelow: 0,
      hoursInRange: 0.17,
      hoursAbove: 0,
    });
  });

  it('leaves buckets outside the period to the period they belong to', () => {
    const [period] = summarise({
      temperatureBuckets: [
        bucket('2026-11-23T01:55:00Z', 4),
        bucket('2026-11-23T03:00:00Z', 4),
      ],
    }).periods;
    expect(period.hoursBelow).toBe(0);
    expect(period.hoursWithoutReadings).toBe(1);
  });

  it("carries the period's extreme reading, and the zone's band", () => {
    const coldest: Reading = {
      id: 'reading-1',
      nodeId: 'patji',
      sensorId: 'pipes',
      temperature: 1.5,
      humidity: null,
      co2: null,
      createdAt: '2026-11-23T02:40:00.000Z',
    };
    const summary = summarise({ periods: [{ ...NIGHT, extreme: coldest }] });
    expect(summary.lowerBounds).toEqual(HEAT_AND_FAN.lowerBounds);
    expect(summary.upperBounds).toEqual(HEAT_AND_FAN.upperBounds);
    expect(summary.periods[0]).toMatchObject({
      kind: 'night',
      from: '2026-11-23T02:00:00.000Z',
      to: '2026-11-23T03:00:00.000Z',
      inProgress: false,
      extreme: {
        temperatureC: 1.5,
        at: '2026-11-23T02:40:00.000Z',
        nodeId: 'patji',
        sensorId: 'pipes',
      },
    });
  });
});
