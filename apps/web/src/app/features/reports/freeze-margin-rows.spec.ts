import {
  DeviceRole,
  type FreezeMarginNight,
  type ZoneFreezeMargin,
} from '@tempestas/domain';
import {
  buildNightRows,
  countNightsOfConcern,
  describeWarning,
} from './freeze-margin-rows';

function freezeNight(
  overrides: Partial<FreezeMarginNight> = {},
): FreezeMarginNight {
  return {
    from: '2026-11-23T00:00:00.000Z',
    to: '2026-11-23T14:00:00.000Z',
    inProgress: false,
    coldest: {
      temperatureC: 1.46,
      at: '2026-11-23T12:05:00.000Z',
      nodeId: 'patji',
      sensorId: 'pipe',
    },
    heating: [
      {
        deviceId: 'heater',
        deviceName: 'Heater',
        role: DeviceRole.Heater,
        state: 'on',
        onBelowC: 3,
      },
      {
        deviceId: 'tape',
        deviceName: 'Heat tape',
        role: DeviceRole.HeatTape,
        state: 'unknown',
        onBelowC: 2,
      },
    ],
    hoursBelowWarning: 2.5,
    hoursWithReadings: 14,
    concern: null,
    ...overrides,
  };
}

function pumphouse(
  nights: FreezeMarginNight[],
  overrides: Partial<ZoneFreezeMargin> = {},
): ZoneFreezeMargin {
  return {
    zoneId: 'pumphouse-zone',
    zoneSlug: 'pumphouse',
    zoneName: 'Pumphouse',
    timezone: 'America/Regina',
    warningBelowC: 3,
    isWarningFromRules: true,
    nights,
    ...overrides,
  };
}

describe('buildNightRows', () => {
  it('describes the coldest moment and the heat then, in the zone timezone', () => {
    const [row] = buildNightRows(pumphouse([freezeNight()]));
    expect(row).toEqual({
      from: '2026-11-23T00:00:00.000Z',
      label: 'Sun 22 Nov',
      coldest: '1.5 °C at 06:05',
      heating: 'Heater on, Heat tape unknown',
      hoursBelow: '2.5 h',
      concern: null,
    });
  });

  it('marks the night still running', () => {
    const [row] = buildNightRows(
      pumphouse([freezeNight({ inProgress: true })]),
    );
    expect(row.label).toBe('Sun 22 Nov (tonight)');
  });

  it('says so for a night without readings', () => {
    const [row] = buildNightRows(
      pumphouse([freezeNight({ coldest: null, heating: [] })]),
    );
    expect(row).toMatchObject({
      coldest: 'No readings',
      heating: '—',
      hoursBelow: '—',
    });
  });

  it('names each heat source that was owed and off, or not heard from', () => {
    const [heaterOff, tapeUnknown] = buildNightRows(
      pumphouse([
        freezeNight({
          concern: 'heat-off-while-cold',
          heating: [
            { ...freezeNight().heating[0], state: 'off' },
            freezeNight().heating[1],
          ],
        }),
        freezeNight({ concern: 'heat-unknown-while-cold' }),
      ]),
    );
    expect(heaterOff.concern).toBe(
      'Heater was off at the coldest moment, below its 3 °C on-setpoint.',
    );
    expect(tapeUnknown.concern).toBe(
      'Nothing was heard from Heat tape at the coldest moment, below its 2 °C on-setpoint.',
    );
  });

  it('says when the heat was on and still not keeping up', () => {
    const [row] = buildNightRows(
      pumphouse([freezeNight({ concern: 'cold-despite-heat' })]),
    );
    expect(row.concern).toBe(
      'The heat was on and it still came within 1 °C of freezing.',
    );
  });

  it('falls back to UTC, and says so, for a zone name the browser does not know', () => {
    const [row] = buildNightRows(
      pumphouse([freezeNight()], { timezone: 'Not/AZone' }),
    );
    expect(row.label).toBe('Mon 23 Nov UTC');
    expect(row.coldest).toBe('1.5 °C at 12:05 UTC');
  });
});

describe('countNightsOfConcern', () => {
  it('counts only the flagged nights', () => {
    expect(
      countNightsOfConcern(
        pumphouse([
          freezeNight(),
          freezeNight({ concern: 'heat-off-while-cold' }),
        ]),
      ),
    ).toBe(1);
  });
});

describe('describeWarning', () => {
  it('says where the warning temperature came from', () => {
    expect(describeWarning(pumphouse([]))).toBe(
      'Warning below 3 °C, the highest heat on-setpoint in its rules',
    );
    expect(describeWarning(pumphouse([], { isWarningFromRules: false }))).toBe(
      'Warning below 3 °C, a default: no heating rule here sets one',
    );
  });
});
