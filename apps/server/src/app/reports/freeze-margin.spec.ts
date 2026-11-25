import { DeviceRole, type Reading } from '@tempestas/domain';
import type { Span } from '../devices/relay-spans';
import type { TemperatureBucketRow } from '../readings/readings.service';
import {
  summariseZoneFreezeMargin,
  type HeatingDevice,
  type NightWithColdest,
  type ZoneFreezeMarginInput,
} from './freeze-margin';
import { DEFAULT_FREEZE_WARNING_C } from './heating-setpoints';

const NIGHT_FROM = new Date('2026-11-23T00:00:00Z');
const NIGHT_TO = new Date('2026-11-23T14:00:00Z');
const COLDEST_AT = new Date('2026-11-23T12:00:00Z');
const BUCKET_MINUTES = 10;

const HEATER: HeatingDevice = {
  id: 'heater-device',
  name: 'Pumphouse heater',
  role: DeviceRole.Heater,
  zoneId: 'pumphouse-zone',
};
const HEAT_TAPE: HeatingDevice = {
  id: 'tape-device',
  name: 'Heat tape',
  role: DeviceRole.HeatTape,
  zoneId: 'pumphouse-zone',
};

function coldestReading(temperature: number): Reading {
  return {
    id: 'reading-1',
    nodeId: 'patji',
    sensorId: 'pipe',
    temperature,
    humidity: null,
    co2: null,
    createdAt: COLDEST_AT.toISOString(),
  };
}

function night(coldest: Reading | null): NightWithColdest {
  return { from: NIGHT_FROM, to: NIGHT_TO, inProgress: false, coldest };
}

function spanAcrossNight(deviceId: string, state: Span['state']): Span {
  return {
    deviceId,
    state,
    fromMs: NIGHT_FROM.getTime(),
    toMs: NIGHT_TO.getTime(),
    ending: 'transition',
  };
}

function bucket(
  at: string,
  sensorId: string,
  lowestC: number,
): TemperatureBucketRow {
  return {
    nodeId: 'patji',
    sensorId,
    at: new Date(at),
    averageC: lowestC,
    lowestC,
    highestC: lowestC,
    sampleCount: 1,
  };
}

function summarise(
  overrides: Partial<ZoneFreezeMarginInput>,
): ReturnType<typeof summariseZoneFreezeMargin> {
  return summariseZoneFreezeMargin({
    zone: {
      id: 'pumphouse-zone',
      slug: 'pumphouse',
      displayName: 'Pumphouse',
      timezone: 'America/Edmonton',
      nodeIds: ['patji'],
    },
    heatOnBelowByRole: { [DeviceRole.Heater]: 3, [DeviceRole.HeatTape]: 2 },
    sensorSourceByRole: {
      [DeviceRole.Heater]: 'min',
      [DeviceRole.HeatTape]: 'min',
    },
    devices: [HEATER, HEAT_TAPE],
    nights: [night(coldestReading(1.5))],
    temperatureBuckets: [],
    bucketMinutes: BUCKET_MINUTES,
    spans: [],
    ...overrides,
  });
}

function concernFor(coldestC: number, heaterState: Span['state']): unknown {
  const [onlyNight] = summarise({
    devices: [HEATER],
    nights: [night(coldestReading(coldestC))],
    spans: [spanAcrossNight(HEATER.id, heaterState)],
  }).nights;
  return onlyNight.concern;
}

describe('summariseZoneFreezeMargin', () => {
  it('reports the coldest reading and each heat source at that moment', () => {
    const [onlyNight] = summarise({
      spans: [
        spanAcrossNight(HEATER.id, 'on'),
        spanAcrossNight(HEAT_TAPE.id, 'on'),
      ],
    }).nights;
    expect(onlyNight.coldest).toEqual({
      temperatureC: 1.5,
      at: COLDEST_AT.toISOString(),
      nodeId: 'patji',
      sensorId: 'pipe',
    });
    expect(onlyNight.heating).toEqual([
      {
        deviceId: HEATER.id,
        deviceName: HEATER.name,
        role: DeviceRole.Heater,
        state: 'on',
        onBelowC: 3,
        isOnBelowFromRule: true,
        isHeatOwed: true,
      },
      {
        deviceId: HEAT_TAPE.id,
        deviceName: HEAT_TAPE.name,
        role: DeviceRole.HeatTape,
        state: 'on',
        onBelowC: 2,
        isOnBelowFromRule: true,
        isHeatOwed: true,
      },
    ]);
    expect(onlyNight.concern).toBeNull();
  });

  it('says unknown, never off, for a heat source with no history at the coldest moment', () => {
    const [onlyNight] = summarise({ devices: [HEATER] }).nights;
    expect(onlyNight.heating[0].state).toBe('unknown');
    expect(onlyNight.concern).toBe('heat-unknown-while-cold');
  });

  it('flags heat that was off while it was below its on-setpoint', () => {
    expect(concernFor(2, 'off')).toBe('heat-off-while-cold');
  });

  it('does not flag heat that was off above its on-setpoint', () => {
    expect(concernFor(4, 'off')).toBeNull();
  });

  it('flags heat that was on but the temperature still came within the alarm margin of freezing', () => {
    expect(concernFor(0.5, 'on')).toBe('cold-despite-heat');
  });

  it('puts off ahead of unknown when both are called for', () => {
    const [onlyNight] = summarise({
      nights: [night(coldestReading(1))],
      spans: [spanAcrossNight(HEATER.id, 'off')],
    }).nights;
    expect(onlyNight.concern).toBe('heat-off-while-cold');
  });

  it('only owes heat from a source whose own setpoint was crossed', () => {
    const [onlyNight] = summarise({
      nights: [night(coldestReading(2.5))],
      spans: [
        spanAcrossNight(HEATER.id, 'on'),
        spanAcrossNight(HEAT_TAPE.id, 'off'),
      ],
    }).nights;
    expect(onlyNight.concern).toBeNull();
  });

  it("judges heat by its rule's own sensor source, not the coldest probe", () => {
    const [onlyNight] = summarise({
      devices: [HEATER],
      sensorSourceByRole: { [DeviceRole.Heater]: 'mean' },
      nights: [night(coldestReading(1.5))],
      temperatureBuckets: [
        bucket('2026-11-23T12:00:00Z', 'pipe', 1.5),
        bucket('2026-11-23T12:00:00Z', 'air', 5.5),
      ],
      spans: [spanAcrossNight(HEATER.id, 'off')],
    }).nights;
    expect(onlyNight.heating[0].isHeatOwed).toBe(false);
    expect(onlyNight.concern).toBeNull();
  });

  it("flags heat whose rule's own sensor source was below its on-setpoint", () => {
    const [onlyNight] = summarise({
      devices: [HEATER],
      sensorSourceByRole: { [DeviceRole.Heater]: 'mean' },
      nights: [night(coldestReading(1.5))],
      temperatureBuckets: [
        bucket('2026-11-23T12:00:00Z', 'pipe', 1.5),
        bucket('2026-11-23T12:00:00Z', 'air', 2.5),
        bucket('2026-11-23T11:50:00Z', 'air', 9),
      ],
      spans: [spanAcrossNight(HEATER.id, 'off')],
    }).nights;
    expect(onlyNight.heating[0].isHeatOwed).toBe(true);
    expect(onlyNight.concern).toBe('heat-off-while-cold');
  });

  it('falls back to the coldest probe when the rule follows a probe that was silent at the coldest moment', () => {
    const [onlyNight] = summarise({
      devices: [HEATER],
      sensorSourceByRole: { [DeviceRole.Heater]: 'node:braize' },
      nights: [night(coldestReading(0.5))],
      spans: [spanAcrossNight(HEATER.id, 'off')],
    }).nights;
    expect(onlyNight.heating[0].isHeatOwed).toBe(true);
    expect(onlyNight.concern).toBe('heat-off-while-cold');
  });

  it('says when a heat source is judged against the default warning, not a setpoint of its own', () => {
    const [onlyNight] = summarise({
      devices: [HEATER],
      heatOnBelowByRole: { [DeviceRole.HeatTape]: 2 },
    }).nights;
    expect(onlyNight.heating[0]).toMatchObject({
      onBelowC: DEFAULT_FREEZE_WARNING_C,
      isOnBelowFromRule: false,
    });
  });

  it('counts hours below the warning from the coldest probe in each bucket', () => {
    const [onlyNight] = summarise({
      temperatureBuckets: [
        bucket('2026-11-23T01:00:00Z', 'pipe', 2.5),
        bucket('2026-11-23T01:00:00Z', 'air', 4),
        bucket('2026-11-23T01:10:00Z', 'pipe', 3.5),
        bucket('2026-11-23T01:10:00Z', 'air', 2.9),
        bucket('2026-11-23T01:20:00Z', 'pipe', 5),
        bucket('2026-11-22T23:50:00Z', 'pipe', -5),
      ],
    }).nights;
    expect(onlyNight.hoursBelowWarning).toBe(0.33);
    expect(onlyNight.hoursWithReadings).toBe(0.5);
  });

  it('reports a night without readings as such, with no concern', () => {
    const [onlyNight] = summarise({ nights: [night(null)] }).nights;
    expect(onlyNight).toMatchObject({
      coldest: null,
      heating: [],
      hoursBelowWarning: 0,
      hoursWithReadings: 0,
      concern: null,
    });
  });

  it('takes the warning from the rules, and says so', () => {
    expect(summarise({})).toMatchObject({
      warningBelowC: 3,
      isWarningFromRules: true,
    });
    expect(summarise({ heatOnBelowByRole: {} })).toMatchObject({
      warningBelowC: DEFAULT_FREEZE_WARNING_C,
      isWarningFromRules: false,
    });
  });
});
