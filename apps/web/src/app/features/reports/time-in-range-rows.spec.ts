import {
  DeviceRole,
  type PeriodExtreme,
  type TimeInRangePeriod,
  type ZoneTimeInRange,
} from '@tempestas/domain';
import {
  buildPeriodRows,
  describeLowerBound,
  describeUpperBound,
  summariseShareInRange,
} from './time-in-range-rows';

const NIGHT_LOW: PeriodExtreme = {
  temperatureC: 1.46,
  at: '2026-11-23T12:05:00.000Z',
  nodeId: 'patji',
  sensorId: 'pipes',
};

function period(overrides: Partial<TimeInRangePeriod> = {}): TimeInRangePeriod {
  return {
    kind: 'night',
    from: '2026-11-23T01:00:00.000Z',
    to: '2026-11-23T13:00:00.000Z',
    inProgress: false,
    hoursBelow: 1,
    hoursInRange: 8,
    hoursAbove: 0,
    hoursWithoutReadings: 3,
    extreme: NIGHT_LOW,
    ...overrides,
  };
}

function pumphouse(
  periods: TimeInRangePeriod[],
  overrides: Partial<ZoneTimeInRange> = {},
): ZoneTimeInRange {
  return {
    zoneId: 'pumphouse-zone',
    zoneSlug: 'pumphouse',
    zoneName: 'Pumphouse',
    timezone: 'America/Regina',
    nodeIds: ['patji'],
    lowerBounds: [
      { role: DeviceRole.Heater, setpointC: 2, sensorSource: 'min' },
      {
        role: DeviceRole.HeatTape,
        setpointC: 4,
        sensorSource: 'sensor:patji/pipes',
      },
    ],
    upperBounds: [],
    periods,
    ...overrides,
  };
}

describe('buildPeriodRows', () => {
  it("labels a night by the date it began, with its low in the zone's time", () => {
    const [row] = buildPeriodRows(pumphouse([period()]));
    expect(row.label).toBe('Sun 22 Nov, night');
    expect(row.extreme).toBe('Low 1.5 °C at 06:05');
  });

  it('labels the running day and gives its high', () => {
    const [row] = buildPeriodRows(
      pumphouse([
        period({
          kind: 'day',
          inProgress: true,
          extreme: { ...NIGHT_LOW, temperatureC: 12 },
        }),
      ]),
    );
    expect(row.label).toBe('Sun 22 Nov, day (today)');
    expect(row.extreme).toBe('High 12.0 °C at 06:05');
  });

  it('shows the hours, and the share of the period with no readings', () => {
    const [row] = buildPeriodRows(pumphouse([period()]));
    expect(row).toMatchObject({
      below: '1.0 h',
      inRange: '8.0 h',
      withoutReadings: '25%',
    });
  });

  it('leaves a side with no bound empty rather than showing no hours there', () => {
    const [row] = buildPeriodRows(pumphouse([period()]));
    expect(row.above).toBe('—');
  });

  it('says when a period had no readings at all', () => {
    const [row] = buildPeriodRows(pumphouse([period({ extreme: null })]));
    expect(row.extreme).toBe('No readings');
  });
});

describe('describeLowerBound and describeUpperBound', () => {
  it('names every rule that bounds the zone, and the sensor it reads', () => {
    expect(describeLowerBound(pumphouse([]))).toBe(
      "Below: under the heater's 2 °C on-setpoint, read from the coldest probe, or the heat tape's 4 °C on-setpoint, read from patji/pipes only.",
    );
  });

  it('says so when a side has no bound, instead of inventing one', () => {
    expect(describeUpperBound(pumphouse([]))).toBe(
      'No upper bound: no exhaust fan rule here.',
    );
    expect(describeLowerBound(pumphouse([], { lowerBounds: [] }))).toBe(
      'No lower bound: no heater or heat tape rule here.',
    );
  });
});

describe('summariseShareInRange', () => {
  it('gives nights and days apart, as shares of the hours with readings', () => {
    const zone = pumphouse(
      [
        period(),
        period({ hoursBelow: 0, hoursInRange: 9 }),
        period({ kind: 'day', hoursBelow: 0, hoursInRange: 12 }),
      ],
      {
        upperBounds: [
          { role: DeviceRole.ExhaustFan, setpointC: 30, sensorSource: 'max' },
        ],
      },
    );
    expect(summariseShareInRange(zone)).toEqual([
      'Nights: 94% in range, 6% below, 0% above',
      'Days: 100% in range, 0% below, 0% above',
    ]);
  });

  it('leaves out a kind with no readings, and a side with no bound', () => {
    const zone = pumphouse([
      period(),
      period({
        kind: 'day',
        hoursBelow: 0,
        hoursInRange: 0,
        hoursWithoutReadings: 12,
      }),
    ]);
    expect(summariseShareInRange(zone)).toEqual([
      'Nights: 89% in range, 11% below',
    ]);
  });
});
