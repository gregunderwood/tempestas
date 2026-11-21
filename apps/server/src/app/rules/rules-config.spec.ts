import { parseZoneRulesConfig } from './rules-config';

// Plain JSON, the way it sits in the column.
function pumphouse(): Record<string, unknown> {
  return {
    enabledRoles: ['heater', 'heat_tape'],
    sensorPolicy: { default: { source: 'min', maxAgeMs: 120000 } },
    rules: {
      heat_tape: {
        kind: 'thermostat',
        mode: 'heat',
        onAtC: 4,
        offAtC: 6,
        onStale: 'on',
      },
      heater: {
        kind: 'thermostat',
        mode: 'heat',
        onAtC: 2,
        offAtC: 5,
        onStale: 'on',
      },
    },
    timezone: 'America/Vancouver',
  };
}

// Exactly as the migration writes the live zone.
function greenhouse(): Record<string, unknown> {
  return {
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
  };
}

function errorsOf(mutate: (config: Record<string, any>) => void): string[] {
  const config = pumphouse() as Record<string, any>;
  mutate(config);
  const parsed = parseZoneRulesConfig(config);
  return parsed.ok ? [] : parsed.errors;
}

describe('parseZoneRulesConfig accepts', () => {
  it('the pumphouse', () => {
    expect(parseZoneRulesConfig(pumphouse())).toMatchObject({ ok: true });
  });

  it('the greenhouse as migrated', () => {
    expect(parseZoneRulesConfig(greenhouse())).toMatchObject({ ok: true });
  });

  // The greenhouse keeps its lights and fan settings without owning them.
  it('a rule for a role the zone does not own', () => {
    expect(errorsOf((config) => (config['enabledRoles'] = ['heater']))).toEqual(
      [],
    );
  });

  it('a role pinned to one probe', () => {
    expect(
      errorsOf(
        (config) =>
          (config['rules'].heat_tape.sensor = {
            source: 'sensor:pumphouse/pipes',
          }),
      ),
    ).toEqual([]);
  });

  it('a per-role sensor override, including a pinned node', () => {
    expect(
      errorsOf(
        (config) =>
          (config['rules'].heater.sensor = { source: 'node:pumphouse' }),
      ),
    ).toEqual([]);
  });
});

describe('parseZoneRulesConfig refuses', () => {
  it('something that is not an object at all', () => {
    expect(parseZoneRulesConfig(null)).toEqual({
      ok: false,
      errors: ['rules_config must be an object'],
    });
    expect(parseZoneRulesConfig([])).toMatchObject({ ok: false });
  });

  // Read as undefined, every comparison is false and the role sits in its dead band forever.
  it('a misspelled setpoint, naming where it is', () => {
    expect(
      errorsOf((config) => {
        delete config['rules'].heater.onAtC;
        config['rules'].heater.onAtc = 2;
      }),
    ).toEqual([
      'rules.heater.onAtc is not a recognised setting',
      'rules.heater.onAtC must be a number',
    ]);
  });

  // An optional field misspelled would otherwise silently fall back.
  it('a misspelled optional field', () => {
    expect(
      errorsOf((config) => (config['rules'].heater.sensr = { source: 'min' })),
    ).toEqual(['rules.heater.sensr is not a recognised setting']);
  });

  it('an unknown top-level key, such as the old thresholds', () => {
    expect(errorsOf((config) => (config['thresholds'] = {}))).toEqual([
      'thresholds is not a recognised setting',
    ]);
  });

  it('a setpoint that is not a finite number', () => {
    expect(
      errorsOf((config) => (config['rules'].heater.offAtC = '5')),
    ).toContain('rules.heater.offAtC must be a number');
    expect(
      errorsOf((config) => (config['rules'].heater.offAtC = Infinity)),
    ).toContain('rules.heater.offAtC must be a number');
  });

  it.each([
    [5, 2],
    [3, 3],
  ])(
    'a heat thermostat whose band is backwards or empty (%s/%s)',
    (on, off) => {
      const errors = errorsOf((config) => {
        config['rules'].heater.onAtC = on;
        config['rules'].heater.offAtC = off;
      });
      expect(errors).toEqual([
        `rules.heater: a heat thermostat needs onAtC (${on}) below offAtC (${off})`,
      ]);
    },
  );

  it('a cool thermostat whose band is backwards', () => {
    const errors = errorsOf((config) => {
      config['rules'].heater.mode = 'cool';
    });
    expect(errors).toEqual([
      'rules.heater: a cool thermostat needs onAtC (2) above offAtC (5)',
    ]);
  });

  it('a mode that is neither heat nor cool', () => {
    expect(
      errorsOf((config) => (config['rules'].heater.mode = 'warm')),
    ).toEqual(['rules.heater.mode must be "heat" or "cool"']);
  });

  it('a rule with no stale policy', () => {
    expect(errorsOf((config) => delete config['rules'].heater.onStale)).toEqual(
      ['rules.heater.onStale must be "hold", "on" or "off"'],
    );
  });

  it('a kind that is not on the menu', () => {
    expect(errorsOf((config) => (config['rules'].heater.kind = 'pid'))).toEqual(
      [
        'rules.heater.kind "pid" is not one of thermostat, daylight-thermostat, co2-burner',
      ],
    );
  });

  it('a rule for something that is not a role', () => {
    expect(
      errorsOf(
        (config) => (config['rules'].sprinkler = config['rules'].heater),
      ),
    ).toEqual(['rules.sprinkler is not a role']);
  });

  it('a rule that is not an object', () => {
    expect(errorsOf((config) => (config['rules'].heater = 'on'))).toEqual([
      'rules.heater must be an object',
    ]);
  });

  it('an owned role with no rule', () => {
    expect(errorsOf((config) => delete config['rules'].heater)).toEqual([
      'enabled role "heater" has no rule',
    ]);
  });

  it('an owned role that is not a role', () => {
    expect(
      errorsOf(
        (config) => (config['enabledRoles'] = ['heater', 'heat_tape', 'pump']),
      ),
    ).toEqual(['enabledRoles[2] "pump" is not a role']);
  });

  it('missing top-level sections', () => {
    expect(parseZoneRulesConfig({})).toEqual({
      ok: false,
      errors: [
        'timezone must be an IANA zone name',
        'enabledRoles must be an array',
        'sensorPolicy must be an object',
        'rules must be an object',
      ],
    });
  });

  // The sandbox seed had this for months, working only because anything unknown fell through to mean.
  it('a sensor source that is not one of the five', () => {
    expect(
      errorsOf(
        (config) => (config['sensorPolicy'].default.source = 'zone-mean'),
      ),
    ).toEqual([
      'sensorPolicy.default.source "zone-mean" must be mean, max, min, node:<slug> or sensor:<slug>/<id>',
    ]);
  });

  it.each([
    'sensor:pumphouse',
    'sensor:pumphouse/',
    'sensor:/pipes',
    'sensor:a/b/c',
  ])('a sensor source %s that does not name exactly one sensor', (source) => {
    expect(
      errorsOf((config) => (config['sensorPolicy'].default.source = source)),
    ).toHaveLength(1);
  });

  it('a node source that is not a topic segment', () => {
    expect(
      errorsOf(
        (config) => (config['sensorPolicy'].default.source = 'node:a/b'),
      ),
    ).toHaveLength(1);
  });

  it.each([0, -1, '120000'])('a maxAgeMs of %s', (maxAgeMs) => {
    expect(
      errorsOf(
        (config) => (config['sensorPolicy'].default.maxAgeMs = maxAgeMs),
      ),
    ).toEqual([
      'sensorPolicy.default.maxAgeMs must be a positive number of milliseconds',
    ]);
  });

  it('a sensor policy that is not an object, or has extra keys', () => {
    expect(
      errorsOf((config) => (config['sensorPolicy'].default = 'min')),
    ).toEqual(['sensorPolicy.default must be an object']);
    expect(errorsOf((config) => (config['sensorPolicy'].byRole = {}))).toEqual([
      'sensorPolicy.byRole is not a recognised setting',
    ]);
  });
});

describe('the daylight window', () => {
  // Guessing day or night would pick a burner's branch at random.
  it('is required by every rule that reads it', () => {
    const config = greenhouse();
    delete config['daylight'];
    const parsed = parseZoneRulesConfig(config);
    expect(parsed.ok === false && parsed.errors).toEqual([
      'rules.lights is a daylight-thermostat rule, which needs a daylight window',
      'rules.co2_generator is a co2-burner rule, which needs a daylight window',
    ]);
  });

  it.each([
    [{ start: '6:3', end: '18:30' }, ['daylight.start must be HH:MM']],
    [{ start: '06:30' }, ['daylight.end must be HH:MM']],
    [
      { start: '06:30', end: '18:30', dusk: '19:00' },
      ['daylight.dusk is not a recognised setting'],
    ],
    ['06:30-18:30', ['daylight must be an object']],
  ])('refuses %j', (daylight, expected) => {
    expect(errorsOf((config) => (config['daylight'] = daylight))).toEqual(
      expected,
    );
  });
});

describe('the CO2 burner', () => {
  // Zero width is the re-ignite-every-few-seconds bug the band was added for.
  it('refuses a CO2 band that is empty', () => {
    const config = greenhouse() as Record<string, any>;
    config['rules'].co2_generator.co2OnPpm = 1500;
    const parsed = parseZoneRulesConfig(config);
    expect(parsed.ok === false && parsed.errors).toEqual([
      'rules.co2_generator: co2OnPpm (1500) must be below co2OffPpm (1500)',
    ]);
  });

  it('refuses a missing temperature setpoint', () => {
    const config = greenhouse() as Record<string, any>;
    delete config['rules'].co2_generator.nightOnBelowC;
    const parsed = parseZoneRulesConfig(config);
    expect(parsed.ok === false && parsed.errors).toEqual([
      'rules.co2_generator.nightOnBelowC must be a number',
    ]);
  });
});
