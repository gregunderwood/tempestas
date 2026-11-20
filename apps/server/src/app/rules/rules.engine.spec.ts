import {
  DeviceRole,
  type ClimateSample,
  type RuleDecision,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import {
  ROLE_ORDER,
  evaluateRules,
  isWithinWindow,
  parseWallClock,
} from './rules.engine';

/**
 * The greenhouse as actually configured, in rule-kind form. Every expectation
 * table in this file predates rule kinds and is unchanged: that is the proof
 * the conversion moved the numbers without moving the behaviour.
 *
 * `dayOffAtC` is 26 here, as the tables were written against, though the live
 * zone runs 28.
 */
const GREENHOUSE: ZoneRulesConfig = {
  enabledRoles: [
    DeviceRole.Lights,
    DeviceRole.Co2Generator,
    DeviceRole.ExhaustFan,
  ],
  sensorPolicy: { default: { source: 'mean' } },
  daylight: { start: '06:30', end: '18:30' },
  rules: {
    [DeviceRole.Lights]: {
      kind: 'daylight-thermostat',
      mode: 'heat',
      onAtC: 26,
      offAtC: 27,
      onStale: 'hold',
    },
    [DeviceRole.Co2Generator]: {
      kind: 'co2-burner',
      dayOffAtC: 26,
      nightOnBelowC: 3,
      co2OnPpm: 1400,
      co2OffPpm: 1500,
      onStale: 'hold',
    },
    [DeviceRole.ExhaustFan]: {
      kind: 'thermostat',
      mode: 'cool',
      onAtC: 30,
      offAtC: 29.5,
      onStale: 'hold',
    },
  },
  timezone: 'America/Vancouver',
};

const NOON = 12 * 60;
const MIDNIGHT_THIRTY = 30;

function config(): ZoneRulesConfig {
  return GREENHOUSE;
}

function climate(
  temperatureC: number,
  co2Ppm: number | null = 800,
): ClimateSample {
  return {
    temperatureC,
    co2Ppm,
    observedAt: '2026-01-10T12:00:00.000Z',
    sourceNodeIds: ['elantris'],
    sourceSensorIds: ['elantris/scd4x-0'],
  };
}

interface Scenario {
  minutes?: number;
  temperatureC?: number;
  co2Ppm?: number | null;
  roles?: DeviceRole[];
  stale?: DeviceRole[];
  noClimate?: boolean;
}

function decide(role: DeviceRole, scenario: Scenario = {}): RuleDecision {
  // `'co2Ppm' in scenario`, not `?? 800`: an explicit null IS the case under
  // test in the most important assertion in this file.
  const sample = climate(
    scenario.temperatureC ?? 20,
    'co2Ppm' in scenario ? (scenario.co2Ppm as number | null) : 800,
  );
  const roles = scenario.roles ?? [
    DeviceRole.Lights,
    DeviceRole.Co2Generator,
    DeviceRole.ExhaustFan,
  ];
  const decisions = evaluateRules({
    minutesSinceMidnightLocal: scenario.minutes ?? NOON,
    config: { ...config(), enabledRoles: roles },
    enabledRoles: roles,
    climateByRole: scenario.noClimate
      ? {}
      : {
          [DeviceRole.Lights]: sample,
          [DeviceRole.Co2Generator]: sample,
          [DeviceRole.ExhaustFan]: sample,
        },
    staleRoles: scenario.stale ?? [],
  });
  const decision = decisions.find((d) => d.role === role);
  if (!decision) throw new Error(`no decision for ${role}`);
  return decision;
}

describe('evaluateRules shape', () => {
  it('always decides every role, in a fixed order', () => {
    const decisions = evaluateRules({
      minutesSinceMidnightLocal: NOON,
      config: config(),
      enabledRoles: [],
      climateByRole: {},
      staleRoles: [],
    });
    expect(decisions.map((d) => d.role)).toEqual([
      DeviceRole.Lights,
      DeviceRole.Co2Generator,
      DeviceRole.ExhaustFan,
    ]);
  });

  // Ownership is explicit, never inferred from which devices exist: "no lights
  // device" must not mean the same thing as "the other Pi owns lights".
  it('no-ops a role this deployment does not own, whatever the climate says', () => {
    const decision = decide(DeviceRole.Lights, {
      temperatureC: 5,
      roles: [DeviceRole.Co2Generator],
    });
    expect(decision).toEqual({
      role: DeviceRole.Lights,
      desired: 'noop',
      reason: 'role-not-owned',
      sourceNodeIds: [],
    });
  });

  it('no-ops a role with no sensor at all', () => {
    expect(decide(DeviceRole.Co2Generator, { noClimate: true })).toMatchObject({
      desired: 'noop',
      reason: 'no-sensor',
    });
  });

  // Holding last state, but distinguishable from "no sensor" so it can shout.
  it('no-ops a stale role and keeps its provenance', () => {
    expect(
      decide(DeviceRole.Co2Generator, { stale: [DeviceRole.Co2Generator] }),
    ).toEqual({
      role: DeviceRole.Co2Generator,
      desired: 'noop',
      reason: 'sensor-stale',
      sourceNodeIds: ['elantris'],
    });
  });

  it('carries provenance onto a real decision, so a log can say which sensor', () => {
    expect(
      decide(DeviceRole.Co2Generator, { temperatureC: 20 }).sourceNodeIds,
    ).toEqual(['elantris']);
  });
});

describe('lights - a heat source with 1 °C hysteresis', () => {
  it.each([
    [25.9, 'on', 'temp-below-setpoint'],
    [26.0, 'noop', 'dead-band'],
    [27.0, 'noop', 'dead-band'],
    [27.1, 'off', 'temp-above-setpoint'],
  ])('at %s °C is %s (%s)', (temperatureC, desired, reason) => {
    expect(decide(DeviceRole.Lights, { temperatureC })).toMatchObject({
      desired,
      reason,
    });
  });

  it('is unconditionally off outside the window, however cold it is', () => {
    expect(
      decide(DeviceRole.Lights, { minutes: MIDNIGHT_THIRTY, temperatureC: -5 }),
    ).toMatchObject({
      desired: 'off',
      reason: 'outside-window',
    });
  });
});

describe('the day window - start inclusive, end exclusive', () => {
  // Observed through the lights rule at 20 °C: inside the window it turns on,
  // outside it reports outside-window.
  it.each([
    [6 * 60 + 29, 'outside-window'],
    [6 * 60 + 30, 'temp-below-setpoint'],
    [18 * 60 + 29, 'temp-below-setpoint'],
    [18 * 60 + 30, 'outside-window'],
  ])('at minute %s the reason is %s', (minutes, reason) => {
    expect(
      decide(DeviceRole.Lights, { minutes, temperatureC: 20 }).reason,
    ).toBe(reason);
  });
});

describe('CO2 generator - enrichment by day, heat by night', () => {
  // A dead band, as lights and the exhaust fan have. Measured with a real
  // burner: a single setpoint cut at 1509 ppm and wanted back on at 1494, so
  // every cycle would have been an ignition for seconds of burn.
  it.each([
    [25, 800, 'on', 'co2-below-threshold'],
    [25, 1399, 'on', 'co2-below-threshold'],
    // Inside the band it HOLDS. Forcing off here is what produced the chatter.
    [25, 1400, 'noop', 'dead-band'],
    [25, 1450, 'noop', 'dead-band'],
    [25, 1499, 'noop', 'dead-band'],
    [25, 1500, 'off', 'co2-at-threshold'],
    [25, 2000, 'off', 'co2-at-threshold'],
    [25.9, 800, 'on', 'co2-below-threshold'],
    // Temperature is checked first, so it wins even deep in the on region.
    [26, 100, 'off', 'temp-above-setpoint'],
  ])(
    'by day at %s °C and %s ppm is %s (%s)',
    (temperatureC, co2Ppm, desired, reason) => {
      expect(
        decide(DeviceRole.Co2Generator, { temperatureC, co2Ppm }),
      ).toMatchObject({
        desired,
        reason,
      });
    },
  );

  // THE assertion that matters most in this file. A dead sensor stuck on a low
  // reading would otherwise run a propane burner indefinitely on a phantom
  // "CO2 is low".
  it('stays OFF by day when CO2 is unknown, even though it is cool enough', () => {
    expect(
      decide(DeviceRole.Co2Generator, { temperatureC: 25, co2Ppm: null }),
    ).toMatchObject({
      desired: 'off',
      reason: 'co2-at-threshold',
    });
  });

  it.each([
    [2, 'on', 'frost-protection'],
    [2.9, 'on', 'frost-protection'],
    [3, 'off', 'temp-above-setpoint'],
  ])('by night at %s °C is %s (%s)', (temperatureC, desired, reason) => {
    expect(
      decide(DeviceRole.Co2Generator, {
        minutes: MIDNIGHT_THIRTY,
        temperatureC,
      }),
    ).toMatchObject({ desired, reason });
  });

  // The night branch is the heater, and it must never consult CO2. A stale or
  // dead CO2 sensor withholding heat on a cold night is how plants die.
  it('heats at night with an unknown CO2', () => {
    expect(
      decide(DeviceRole.Co2Generator, {
        minutes: MIDNIGHT_THIRTY,
        temperatureC: 1,
        co2Ppm: null,
      }),
    ).toMatchObject({ desired: 'on', reason: 'frost-protection' });
  });

  // High CO2 at night is expected and harmless here: the greenhouse leaks, and
  // this generator has never pushed it past ~2500 ppm.
  it('heats at night even at 5000 ppm', () => {
    expect(
      decide(DeviceRole.Co2Generator, {
        minutes: MIDNIGHT_THIRTY,
        temperatureC: 1,
        co2Ppm: 5000,
      }),
    ).toMatchObject({ desired: 'on', reason: 'frost-protection' });
  });
});

describe('exhaust fan - time-independent', () => {
  it.each([
    [30.1, 'on', 'temp-above-setpoint'],
    [30.0, 'noop', 'dead-band'],
    [29.5, 'noop', 'dead-band'],
    [29.4, 'off', 'temp-below-setpoint'],
  ])('at %s °C is %s (%s)', (temperatureC, desired, reason) => {
    expect(decide(DeviceRole.ExhaustFan, { temperatureC })).toMatchObject({
      desired,
      reason,
    });
  });

  it('still vents at 3am, because an overheating greenhouse does not read a clock', () => {
    expect(
      decide(DeviceRole.ExhaustFan, { minutes: 3 * 60, temperatureC: 31 }),
    ).toMatchObject({ desired: 'on' });
  });
});

describe('parseWallClock', () => {
  it.each([
    ['00:00', 0],
    ['06:30', 390],
    ['18:30', 1110],
    ['23:59', 1439],
  ])('parses %s to %s', (value, minutes) => {
    expect(parseWallClock(value)).toBe(minutes);
  });

  // It gates a burner, so it refuses rather than guessing.
  it.each(['6:3', '24:00', '12:60', '0630', 'abc', ''])(
    'throws on %s',
    (value) => {
      expect(() => parseWallClock(value)).toThrow(/Invalid wall-clock time/);
    },
  );
});

describe('isWithinWindow', () => {
  it('is start-inclusive and end-exclusive', () => {
    expect(isWithinWindow(390, 390, 1110)).toBe(true);
    expect(isWithinWindow(1110, 390, 1110)).toBe(false);
  });

  // A night window is the normal case here, not an edge case.
  it('handles a window that crosses midnight', () => {
    expect(isWithinWindow(23 * 60, 1110, 390)).toBe(true);
    expect(isWithinWindow(30, 1110, 390)).toBe(true);
    expect(isWithinWindow(12 * 60, 1110, 390)).toBe(false);
  });

  // Guessing "always" would turn a mistyped config into permanent daytime.
  it('treats an equal start and end as a zero-length window', () => {
    expect(isWithinWindow(0, 0, 0)).toBe(false);
    expect(isWithinWindow(600, 600, 600)).toBe(false);
  });
});

/** The pumphouse as planned: freeze protection, and heat on when blind. */
const PUMPHOUSE: ZoneRulesConfig = {
  enabledRoles: [DeviceRole.Heater, DeviceRole.HeatTape],
  sensorPolicy: { default: { source: 'min', maxAgeMs: 120_000 } },
  rules: {
    [DeviceRole.HeatTape]: {
      kind: 'thermostat',
      mode: 'heat',
      onAtC: 4,
      offAtC: 6,
      onStale: 'on',
    },
    [DeviceRole.Heater]: {
      kind: 'thermostat',
      mode: 'heat',
      onAtC: 2,
      offAtC: 5,
      onStale: 'on',
    },
  },
  timezone: 'America/Vancouver',
};

function pumphouse(
  role: DeviceRole,
  temperatureC: number,
  overrides: {
    stale?: boolean;
    minutes?: number;
    config?: ZoneRulesConfig;
  } = {},
): RuleDecision {
  const sample = climate(temperatureC, null);
  const decisions = evaluateRules({
    minutesSinceMidnightLocal: overrides.minutes ?? NOON,
    config: overrides.config ?? PUMPHOUSE,
    enabledRoles: (overrides.config ?? PUMPHOUSE).enabledRoles,
    climateByRole: {
      [DeviceRole.Heater]: sample,
      [DeviceRole.HeatTape]: sample,
    },
    staleRoles: overrides.stale ? [DeviceRole.Heater, DeviceRole.HeatTape] : [],
  });
  const decision = decisions.find((d) => d.role === role);
  if (!decision) throw new Error(`no decision for ${role}`);
  return decision;
}

describe('a heat thermostat - the pumphouse', () => {
  it('decides only the roles the zone has, in the fixed order', () => {
    const decisions = evaluateRules({
      minutesSinceMidnightLocal: NOON,
      config: PUMPHOUSE,
      enabledRoles: PUMPHOUSE.enabledRoles,
      climateByRole: {},
      staleRoles: [],
    });
    expect(decisions.map((d) => d.role)).toEqual([
      DeviceRole.Heater,
      DeviceRole.HeatTape,
    ]);
  });

  it.each([
    [3.9, 'on', 'temp-below-setpoint'],
    [4.0, 'noop', 'dead-band'],
    [6.0, 'noop', 'dead-band'],
    [6.1, 'off', 'temp-above-setpoint'],
  ])('heat tape at %s °C is %s (%s)', (temperatureC, desired, reason) => {
    expect(pumphouse(DeviceRole.HeatTape, temperatureC)).toMatchObject({
      desired,
      reason,
    });
  });

  it.each([
    [1.9, 'on', 'temp-below-setpoint'],
    [2.0, 'noop', 'dead-band'],
    [5.0, 'noop', 'dead-band'],
    [5.1, 'off', 'temp-above-setpoint'],
  ])('heater at %s °C is %s (%s)', (temperatureC, desired, reason) => {
    expect(pumphouse(DeviceRole.Heater, temperatureC)).toMatchObject({
      desired,
      reason,
    });
  });

  // A pipe freezes at 3am as readily as at noon.
  it('never reads the clock', () => {
    expect(pumphouse(DeviceRole.Heater, 1, { minutes: 3 * 60 })).toMatchObject({
      desired: 'on',
    });
  });

  // CO2 is null throughout this block: a thermostat must not care.
  it('ignores an unknown CO2', () => {
    expect(pumphouse(DeviceRole.HeatTape, 0).desired).toBe('on');
  });
});

describe('onStale - what a role does when its sensors go quiet', () => {
  // THE pumphouse case. Holding would leave a heater that was off when the
  // probes died off however cold it got; "on" costs electricity, "off" costs
  // the pipes.
  it('turns a role ON when told to, and says it was the stale policy', () => {
    expect(pumphouse(DeviceRole.Heater, 20, { stale: true })).toEqual({
      role: DeviceRole.Heater,
      desired: 'on',
      reason: 'stale-failsafe',
      sourceNodeIds: ['elantris'],
    });
  });

  // The last-known reading is warm and says "off"; stale means it is not
  // believed, whatever it says.
  it('ignores the last-known temperature entirely', () => {
    expect(pumphouse(DeviceRole.HeatTape, 30, { stale: true }).desired).toBe(
      'on',
    );
  });

  it('turns a role OFF when told to', () => {
    const config: ZoneRulesConfig = {
      ...PUMPHOUSE,
      rules: {
        ...PUMPHOUSE.rules,
        [DeviceRole.Heater]: {
          ...PUMPHOUSE.rules[DeviceRole.Heater]!,
          onStale: 'off',
        },
      },
    };
    expect(
      pumphouse(DeviceRole.Heater, 0, { stale: true, config }),
    ).toMatchObject({
      desired: 'off',
      reason: 'stale-failsafe',
    });
  });

  it('holds when told to hold, as the greenhouse always has', () => {
    expect(
      decide(DeviceRole.Co2Generator, { stale: [DeviceRole.Co2Generator] }),
    ).toMatchObject({ desired: 'noop', reason: 'sensor-stale' });
  });

  // Ownership comes first: a stale sensor must not drive a role this zone
  // does not control.
  it('never drives an unowned role, stale or not', () => {
    expect(
      pumphouse(DeviceRole.Heater, 0, {
        stale: true,
        config: { ...PUMPHOUSE, enabledRoles: [DeviceRole.HeatTape] },
      }),
    ).toMatchObject({ desired: 'noop', reason: 'role-not-owned' });
  });
});

describe('a config the validator should have refused', () => {
  // Unreachable through RulesService, which parses first. If it is ever
  // reached, the zone fails loudly rather than an owned role doing nothing.
  it('throws for an enabled role with no rule', () => {
    expect(() =>
      pumphouse(DeviceRole.Heater, 0, {
        config: { ...PUMPHOUSE, rules: {} },
      }),
    ).toThrow(/enabled but has no rule/);
  });

  // Guessing day or night would pick a burner branch at random.
  it('throws for a day-dependent rule with no daylight window', () => {
    const { daylight: _omitted, ...noDaylight } = GREENHOUSE;
    expect(() =>
      evaluateRules({
        minutesSinceMidnightLocal: NOON,
        config: noDaylight,
        enabledRoles: noDaylight.enabledRoles,
        climateByRole: { [DeviceRole.Lights]: climate(20) },
        staleRoles: [],
      }),
    ).toThrow(/daylight window/);
  });
});

describe('ROLE_ORDER', () => {
  // A role missing from the order is a role no zone can ever evaluate, and
  // nothing else would say so.
  it('contains every role exactly once', () => {
    expect([...ROLE_ORDER].sort()).toEqual(Object.values(DeviceRole).sort());
  });
});
