import { DeviceRole } from '@tempestas/domain';
import {
  DEFAULT_FREEZE_WARNING_C,
  FALLBACK_SENSOR_SOURCE,
  findHeatOnBelowByRole,
  findOnBelowFor,
  findSensorSourceByRole,
  findSensorSourceFor,
  findThermostatOnAtByRole,
  resolveFreezeWarning,
} from './heating-setpoints';

function rulesWith(rules: Record<string, unknown>): unknown {
  return {
    enabledRoles: Object.keys(rules),
    sensorPolicy: { default: { source: 'min' } },
    rules,
    daylight: { start: '06:30', end: '18:30' },
    timezone: 'America/Edmonton',
  };
}

const HEAT_THERMOSTAT = {
  kind: 'thermostat',
  mode: 'heat',
  onAtC: 3,
  offAtC: 6,
  onStale: 'on',
};

describe('findHeatOnBelowByRole', () => {
  it("borrows each heating role's heat on-setpoint", () => {
    expect(
      findHeatOnBelowByRole(
        rulesWith({
          heater: HEAT_THERMOSTAT,
          heat_tape: { ...HEAT_THERMOSTAT, onAtC: 2, offAtC: 4 },
        }),
      ),
    ).toEqual({ [DeviceRole.Heater]: 3, [DeviceRole.HeatTape]: 2 });
  });

  it('ignores a daylight thermostat, which is off at night by design', () => {
    expect(
      findHeatOnBelowByRole(
        rulesWith({
          heater: { ...HEAT_THERMOSTAT, kind: 'daylight-thermostat' },
        }),
      ),
    ).toEqual({});
  });

  it('ignores a cooling thermostat and roles that do not heat', () => {
    expect(
      findHeatOnBelowByRole(
        rulesWith({
          heater: { ...HEAT_THERMOSTAT, mode: 'cool', onAtC: 30, offAtC: 28 },
          exhaust_fan: {
            ...HEAT_THERMOSTAT,
            mode: 'cool',
            onAtC: 30,
            offAtC: 28,
          },
        }),
      ),
    ).toEqual({});
  });

  it('finds nothing in rules that do not parse', () => {
    expect(findHeatOnBelowByRole({ rules: 'typo' })).toEqual({});
  });
});

describe('resolveFreezeWarning', () => {
  it('takes the highest heat on-setpoint', () => {
    expect(
      resolveFreezeWarning({
        [DeviceRole.Heater]: 3,
        [DeviceRole.HeatTape]: 2,
      }),
    ).toEqual({ belowC: 3, isFromRules: true });
  });

  it('uses the default when no rule has one', () => {
    expect(resolveFreezeWarning({})).toEqual({
      belowC: DEFAULT_FREEZE_WARNING_C,
      isFromRules: false,
    });
  });
});

describe('findOnBelowFor', () => {
  it("uses the role's setpoint, or the default without one, and says which", () => {
    const byRole = { [DeviceRole.Heater]: 4 };
    expect(findOnBelowFor(DeviceRole.Heater, byRole)).toEqual({
      onBelowC: 4,
      isFromRule: true,
    });
    expect(findOnBelowFor(DeviceRole.HeatTape, byRole)).toEqual({
      onBelowC: DEFAULT_FREEZE_WARNING_C,
      isFromRule: false,
    });
  });
});

describe('findSensorSourceByRole', () => {
  it("takes each heating role's own sensor, or the zone default", () => {
    expect(
      findSensorSourceByRole(
        rulesWith({
          heater: { ...HEAT_THERMOSTAT, sensor: { source: 'mean' } },
          heat_tape: HEAT_THERMOSTAT,
        }),
      ),
    ).toEqual({ [DeviceRole.Heater]: 'mean', [DeviceRole.HeatTape]: 'min' });
  });

  it('finds nothing in rules that do not parse', () => {
    expect(findSensorSourceByRole({ rules: 'typo' })).toEqual({});
  });
});

describe('findSensorSourceFor', () => {
  it("uses the role's source, or the coldest probe without one", () => {
    const byRole = { [DeviceRole.Heater]: 'max' as const };
    expect(findSensorSourceFor(DeviceRole.Heater, byRole)).toBe('max');
    expect(findSensorSourceFor(DeviceRole.HeatTape, byRole)).toBe(
      FALLBACK_SENSOR_SOURCE,
    );
  });
});

describe('findThermostatOnAtByRole', () => {
  it("borrows the on-setpoint of the asked roles' thermostats in the asked mode only", () => {
    const rules = rulesWith({
      heater: HEAT_THERMOSTAT,
      exhaust_fan: {
        ...HEAT_THERMOSTAT,
        mode: 'cool',
        onAtC: 30,
        offAtC: 29.5,
      },
    });
    expect(
      findThermostatOnAtByRole(rules, [DeviceRole.ExhaustFan], 'cool'),
    ).toEqual({ [DeviceRole.ExhaustFan]: 30 });
    expect(
      findThermostatOnAtByRole(rules, [DeviceRole.ExhaustFan], 'heat'),
    ).toEqual({});
  });
});

describe('findSensorSourceByRole for other roles', () => {
  it('reads the asked roles instead of the heating ones', () => {
    expect(
      findSensorSourceByRole(
        rulesWith({
          exhaust_fan: {
            ...HEAT_THERMOSTAT,
            mode: 'cool',
            onAtC: 30,
            offAtC: 29.5,
            sensor: { source: 'max' },
          },
        }),
        [DeviceRole.ExhaustFan],
      ),
    ).toEqual({ [DeviceRole.ExhaustFan]: 'max' });
  });
});
