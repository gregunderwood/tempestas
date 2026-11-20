// Here rather than beside the conversion: the TypeORM CLI loads every
// file matching migrations/[0-9]*, and specs in that folder risk joining them.

import { parseZoneRulesConfig } from '../../app/rules/rules-config';
import { toLegacy, toRuleKinds } from '../rule-kinds-conversion';

/** The greenhouse zone exactly as it sits on elantris, read 2026-11-17. */
const LIVE_GREENHOUSE = {
  timezone: 'America/Vancouver',
  thresholds: {
    endTime: '18:30',
    co2OnPpm: 1400,
    co2OffPpm: 1500,
    startTime: '06:30',
    co2OffTemp: 28,
    lightsOnTemp: 26,
    exhaustOnTemp: 30,
    lightsOffTemp: 27,
    co2NightOnTemp: 3,
    exhaustOffTemp: 29.5,
  },
  enabledRoles: ['co2_generator'],
  sensorPolicy: { default: { source: 'mean', maxAgeMs: 120000 } },
};

describe('RuleKindsPerRole', () => {
  // The output of a migration must be something the server will evaluate, or
  // the greenhouse stops being controlled the moment it runs.
  it('turns the live greenhouse into a config the server accepts', () => {
    expect(parseZoneRulesConfig(toRuleKinds(LIVE_GREENHOUSE))).toMatchObject({
      ok: true,
    });
  });

  it('carries every number across to the rule that uses it', () => {
    expect(toRuleKinds(LIVE_GREENHOUSE)).toEqual({
      enabledRoles: ['co2_generator'],
      sensorPolicy: { default: { source: 'mean', maxAgeMs: 120000 } },
      daylight: { start: '06:30', end: '18:30' },
      rules: {
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
        exhaust_fan: {
          kind: 'thermostat',
          mode: 'cool',
          onAtC: 30,
          offAtC: 29.5,
          onStale: 'hold',
        },
      },
      timezone: 'America/Vancouver',
    });
  });

  it('moves a per-role sensor override onto that role and nowhere else', () => {
    const converted = toRuleKinds({
      ...LIVE_GREENHOUSE,
      sensorPolicy: {
        default: { source: 'mean' },
        byRole: { co2_generator: { source: 'node:elantris' } },
      },
    });
    expect(converted.rules['co2_generator']['sensor']).toEqual({
      source: 'node:elantris',
    });
    expect(converted.rules['lights']).not.toHaveProperty('sensor');
    expect(converted.sensorPolicy).toEqual({ default: { source: 'mean' } });
  });

  it('round-trips, so down undoes up exactly', () => {
    expect(toLegacy(toRuleKinds(LIVE_GREENHOUSE))).toEqual(LIVE_GREENHOUSE);

    const withOverride = {
      ...LIVE_GREENHOUSE,
      sensorPolicy: {
        default: { source: 'mean' },
        byRole: { co2_generator: { source: 'node:elantris' } },
      },
    };
    expect(toLegacy(toRuleKinds(withOverride))).toEqual(withOverride);
  });

  // There is no lights setpoint to restore for a pumphouse, and inventing
  // greenhouse numbers for it would be worse than refusing.
  it('refuses to take a zone back that the old shape cannot express', () => {
    expect(
      toLegacy({
        enabledRoles: ['heater'],
        sensorPolicy: { default: { source: 'min' } },
        rules: {
          heater: {
            kind: 'thermostat',
            mode: 'heat',
            onAtC: 2,
            offAtC: 5,
            onStale: 'on',
          },
        },
        timezone: 'America/Vancouver',
      }),
    ).toBeNull();
  });
});
