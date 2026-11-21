import {
  DeviceRole,
  type ClimateSample,
  type Co2BurnerRule,
  type DaylightWindow,
  type RoleRule,
  type RuleDecision,
  type RuleReason,
  type RulesInput,
  type StalePolicy,
} from '@tempestas/domain';
import { MINUTES_PER_HOUR } from '../common/time-units';

const LAST_HOUR_OF_DAY = 23;
const LAST_MINUTE_OF_HOUR = 59;
const WALL_CLOCK_PATTERN = /^(\d{1,2}):(\d{2})$/;

// Never the zone's jsonb key order, which Postgres rewrites; a spec asserts every role is here.
export const ROLE_ORDER: readonly DeviceRole[] = [
  DeviceRole.Lights,
  DeviceRole.Co2Generator,
  DeviceRole.ExhaustFan,
  DeviceRole.Heater,
  DeviceRole.HeatTape,
];

type Verdict = { desired: RuleDecision['desired']; reason: RuleReason };

// Pure: time enters as minutesSinceMidnightLocal, never as new Date(). See docs/Rules and Climate.md.
export function evaluateRules(input: RulesInput): RuleDecision[] {
  const { config } = input;
  const isOwned = (role: DeviceRole) => input.enabledRoles.includes(role);
  const roles = ROLE_ORDER.filter(
    (role) => config.rules[role] !== undefined || isOwned(role),
  );

  return roles.map((role) => {
    // Ownership is explicit: an empty device list must not read as "the other controller owns this".
    if (!isOwned(role)) {
      return createNoop(role, 'role-not-owned', []);
    }

    const rule = config.rules[role];
    if (!rule) {
      // parseZoneRulesConfig refuses this first; if it gets here the whole zone fails loudly.
      throw new Error(`Role "${role}" is enabled but has no rule`);
    }

    const climate = input.climateByRole[role];
    if (input.staleRoles.includes(role)) {
      return decideStale(role, rule.onStale, climate?.sourceNodeIds ?? []);
    }
    if (!climate) {
      return createNoop(role, 'no-sensor', []);
    }

    return {
      role,
      ...applyRule(
        rule,
        climate,
        input.minutesSinceMidnightLocal,
        config.daylight,
      ),
      sourceNodeIds: climate.sourceNodeIds,
    };
  });
}

function applyRule(
  rule: RoleRule,
  climate: ClimateSample,
  minutesSinceMidnight: number,
  daylight: DaylightWindow | undefined,
): Verdict {
  switch (rule.kind) {
    case 'thermostat':
      return decideThermostat(rule.mode, rule.onAtC, rule.offAtC, climate);
    case 'daylight-thermostat':
      return isDaytime(minutesSinceMidnight, daylight)
        ? decideThermostat(rule.mode, rule.onAtC, rule.offAtC, climate)
        : { desired: 'off', reason: 'outside-window' };
    case 'co2-burner':
      return decideCo2Burner(
        rule,
        climate,
        isDaytime(minutesSinceMidnight, daylight),
      );
  }
}

function decideStale(
  role: DeviceRole,
  policy: StalePolicy,
  sourceNodeIds: string[],
): RuleDecision {
  if (policy === 'hold') {
    return createNoop(role, 'sensor-stale', sourceNodeIds);
  }
  return { role, desired: policy, reason: 'stale-failsafe', sourceNodeIds };
}

// Strict comparisons, so the setpoints sit inside the dead band; changing state there makes a relay chatter.
function decideThermostat(
  mode: 'heat' | 'cool',
  onAtC: number,
  offAtC: number,
  climate: ClimateSample,
): Verdict {
  const temperatureC = climate.temperatureC;
  if (mode === 'heat') {
    if (temperatureC < onAtC) {
      return { desired: 'on', reason: 'temp-below-setpoint' };
    }
    if (temperatureC > offAtC) {
      return { desired: 'off', reason: 'temp-above-setpoint' };
    }
  } else {
    if (temperatureC > onAtC) {
      return { desired: 'on', reason: 'temp-above-setpoint' };
    }
    if (temperatureC < offAtC) {
      return { desired: 'off', reason: 'temp-below-setpoint' };
    }
  }
  return { desired: 'noop', reason: 'dead-band' };
}

function decideCo2Burner(
  rule: Co2BurnerRule,
  climate: ClimateSample,
  isDaytimeNow: boolean,
): Verdict {
  if (!isDaytimeNow) {
    // Night is frost protection only: a dead CO2 sensor must never withhold heat.
    return climate.temperatureC < rule.nightOnBelowC
      ? { desired: 'on', reason: 'frost-protection' }
      : { desired: 'off', reason: 'temp-above-setpoint' };
  }

  if (climate.temperatureC >= rule.dayOffAtC) {
    return { desired: 'off', reason: 'temp-above-setpoint' };
  }

  // A null CO2 is unknown, never zero: +Infinity keeps the burner off.
  const co2Ppm =
    climate.co2Ppm === null ? Number.POSITIVE_INFINITY : climate.co2Ppm;

  if (co2Ppm >= rule.co2OffPpm) {
    return { desired: 'off', reason: 'co2-at-threshold' };
  }
  if (co2Ppm < rule.co2OnPpm) {
    return { desired: 'on', reason: 'co2-below-threshold' };
  }
  return { desired: 'noop', reason: 'dead-band' };
}

function isDaytime(
  minutesSinceMidnight: number,
  daylight: DaylightWindow | undefined,
): boolean {
  if (!daylight) {
    // Guessing day or night would pick a burner's branch at random.
    throw new Error('This rule needs the zone to define a daylight window');
  }
  return isWithinWindow(
    minutesSinceMidnight,
    parseWallClock(daylight.start),
    parseWallClock(daylight.end),
  );
}

function createNoop(
  role: DeviceRole,
  reason: RuleReason,
  sourceNodeIds: string[],
): RuleDecision {
  return { role, desired: 'noop', reason, sourceNodeIds };
}

// Throws rather than guessing: this value gates a burner.
export function parseWallClock(value: string): number {
  const match = WALL_CLOCK_PATTERN.exec(value);
  if (!match) {
    throw invalidWallClockError(value);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > LAST_HOUR_OF_DAY || minutes > LAST_MINUTE_OF_HOUR) {
    throw invalidWallClockError(value);
  }
  return hours * MINUTES_PER_HOUR + minutes;
}

function invalidWallClockError(value: string): Error {
  return new Error(`Invalid wall-clock time "${value}"; expected HH:MM`);
}

// An equal start and end is an empty window, never "always": a typo must not mean permanent daytime.
export function isWithinWindow(
  minutes: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (startMinutes === endMinutes) {
    return false;
  }
  if (startMinutes < endMinutes) {
    return minutes >= startMinutes && minutes < endMinutes;
  }
  return minutes >= startMinutes || minutes < endMinutes;
}
