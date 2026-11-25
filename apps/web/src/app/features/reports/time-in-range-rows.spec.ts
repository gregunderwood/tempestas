import {
  DeviceRole,
  type PeriodExtreme,
  type PeriodExtremes,
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
  value: 1.46,
  at: '2026-11-23T12:05:00.000Z',
  nodeId: 'patji',
  sensorId: 'pipes',
};
const NIGHT_EXTREMES: PeriodExtremes = {
  temperature: NIGHT_LOW,
  humidity: null,
  co2: null,
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
    extremes: NIGHT_EXTREMES,
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
    expect(row.extremes).toEqual(['Low 1.5 °C at 06:05']);
  });

  it('labels the running day and gives its highs, one line per metric reported', () => {
    const [row] = buildPeriodRows(
      pumphouse([
        period({
          kind: 'day',
          inProgress: true,
          extremes: {
            temperature: { ...NIGHT_LOW, value: 12 },
            humidity: { ...NIGHT_LOW, value: 81.6 },
            co2: { ...NIGHT_LOW, value: 1450 },
          },
        }),
      ]),
    );
    expect(row.label).toBe('Sun 22 Nov, day (today)');
    expect(row.extremes).toEqual([
      'High 12.0 °C at 06:05',
      'High 82% humidity at 06:05',
      'High 1450 ppm CO₂ at 06:05',
    ]);
  });

  it('shows the hours, and the share of the period with no readings', () => {
    const [row] = buildPeriodRows(pumphouse([period()]));
    expect(row).toMatchObject({
      below: '1.0 h',
      inRange: '8.0 h',
      withoutReadings: '25%',
    });
  });

  it('says when a period had no readings at all', () => {
    const [row] = buildPeriodRows(
      pumphouse([
        period({
          extremes: { temperature: null, humidity: null, co2: null },
        }),
      ]),
    );
    expect(row.extremes).toEqual(['No readings']);
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
      'No upper bound: no always-on exhaust fan thermostat here.',
    );
    expect(describeLowerBound(pumphouse([], { lowerBounds: [] }))).toBe(
      'No lower bound: no always-on heater or heat tape thermostat here.',
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
