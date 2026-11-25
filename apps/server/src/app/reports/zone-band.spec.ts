import { DeviceRole } from '@tempestas/domain';
import { findZoneBand } from './zone-band';

const THERMOSTAT = { kind: 'thermostat', onStale: 'hold' };

function rulesWith(
  rules: Record<string, unknown>,
  defaultSource = 'mean',
): unknown {
  return {
    enabledRoles: [],
    sensorPolicy: { default: { source: defaultSource } },
    rules,
    daylight: { start: '06:30', end: '18:30' },
    timezone: 'America/Vancouver',
  };
}

describe('findZoneBand', () => {
  it("bounds below by each heating rule's heat on-setpoint and above by the fan's cool on-setpoint", () => {
    const band = findZoneBand(
      rulesWith({
        heater: { ...THERMOSTAT, mode: 'heat', onAtC: 2, offAtC: 5 },
        heat_tape: {
          ...THERMOSTAT,
          mode: 'heat',
          onAtC: 4,
          offAtC: 6,
          sensor: { source: 'sensor:patji/pipes' },
        },
        exhaust_fan: { ...THERMOSTAT, mode: 'cool', onAtC: 30, offAtC: 29.5 },
      }),
    );
    expect(band).toEqual({
      lowerBounds: [
        { role: DeviceRole.Heater, setpointC: 2, sensorSource: 'mean' },
        {
          role: DeviceRole.HeatTape,
          setpointC: 4,
          sensorSource: 'sensor:patji/pipes',
        },
      ],
      upperBounds: [
        { role: DeviceRole.ExhaustFan, setpointC: 30, sensorSource: 'mean' },
      ],
    });
  });

  it('has no lower bound without a heating rule, and no upper bound without a cooling rule', () => {
    const band = findZoneBand(
      rulesWith({
        lights: {
          kind: 'daylight-thermostat',
          mode: 'heat',
          onAtC: 26,
          offAtC: 27,
          onStale: 'hold',
        },
        co2_generator: {
          kind: 'co2-burner',
          dayOffAtC: 28,
          nightOnBelowC: 3,
          co2OnPpm: 1400,
          co2OffPpm: 1500,
          onStale: 'hold',
        },
      }),
    );
    expect(band).toEqual({ lowerBounds: [], upperBounds: [] });
  });

  it('takes no bound from a fan set to heat', () => {
    const band = findZoneBand(
      rulesWith({
        exhaust_fan: { ...THERMOSTAT, mode: 'heat', onAtC: 10, offAtC: 12 },
      }),
    );
    expect(band.upperBounds).toEqual([]);
  });

  it('has no band at all when the rules do not parse', () => {
    expect(findZoneBand({ rules: 'typo' })).toEqual({
      lowerBounds: [],
      upperBounds: [],
    });
  });
});
