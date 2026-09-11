import {
  DeviceRole,
  type ClimateSample,
  type RuleDecision,
  type RulesThresholds,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import { evaluateRules, isWithinWindow, parseWallClock } from './rules.engine';

/** The constants as actually running in the greenhouse. */
const THRESHOLDS: RulesThresholds = {
  startTime: '06:30',
  endTime: '18:30',
  lightsOnTemp: 26,
  lightsOffTemp: 27,
  co2OffTemp: 26,
  co2NightOnTemp: 3,
  exhaustOnTemp: 30,
  exhaustOffTemp: 29.5,
  co2OnPpm: 1400,
  co2OffPpm: 1500,
};

const NOON = 12 * 60;
const MIDNIGHT_THIRTY = 30;

function config(thresholds: Partial<RulesThresholds> = {}): ZoneRulesConfig {
  return {
    enabledRoles: [
      DeviceRole.Lights,
      DeviceRole.Co2Generator,
      DeviceRole.ExhaustFan,
    ],
    sensorPolicy: { default: { source: 'mean' } },
    thresholds: { ...THRESHOLDS, ...thresholds },
    timezone: 'America/Vancouver',
  };
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
  };
}

interface Scenario {
  minutes?: number;
  temperatureC?: number;
  co2Ppm?: number | null;
  roles?: DeviceRole[];
  stale?: DeviceRole[];
  noClimate?: boolean;
  thresholds?: Partial<RulesThresholds>;
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
    config: { ...config(scenario.thresholds), enabledRoles: roles },
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
