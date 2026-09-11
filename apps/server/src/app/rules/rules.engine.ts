import {
  DeviceRole,
  type ClimateSample,
  type RuleDecision,
  type RuleReason,
  type RulesInput,
  type RulesThresholds,
} from '@tempestas/domain';

/**
 * The control law, as one pure function.
 *
 * RULE: nothing in this file may call `new Date()`, read a config file, or touch
 * a repository. Time enters as `minutesSinceMidnightLocal` - a number the caller
 * resolved through the zone's IANA timezone. That single constraint is what
 * makes the DST cases testable, and it is the most important structural decision
 * in the port: the Python original resolved local time from the host's *current*
 * UTC offset, so every historical query was an hour out across a DST boundary.
 *
 * The three rule bodies are fixed physics with hysteresis. There is deliberately
 * no rule DSL and no `Rule` entity - a predicate language with one user is a
 * liability when a mis-click controls a propane burner. The tripwire for
 * revisiting that: two rules needed on the SAME role with DIFFERENT bodies, or a
 * non-developer needing to author one.
 */

/** Evaluated in this order, every time, so decisions and logs are comparable. */
const EVALUATED_ROLES: readonly DeviceRole[] = [
  DeviceRole.Lights,
  DeviceRole.Co2Generator,
  DeviceRole.ExhaustFan,
];

export function evaluateRules(input: RulesInput): RuleDecision[] {
  const { thresholds } = input.config;
  const startMinutes = parseWallClock(thresholds.startTime);
  const endMinutes = parseWallClock(thresholds.endTime);
  const inWindow = isWithinWindow(
    input.minutesSinceMidnightLocal,
    startMinutes,
    endMinutes,
  );

  return EVALUATED_ROLES.map((role) => {
    // Ownership is explicit, never inferred from which devices exist. An empty
    // device list must not mean the same thing as "the other controller owns
    // this" on a system that runs a heater in winter.
    if (!input.enabledRoles.includes(role)) {
      return noop(role, 'role-not-owned', []);
    }

    const climate = input.climateByRole[role];

    // Both of these hold last state. Neither automatic alternative is safe:
    // failing everything off can freeze the greenhouse, forcing heat on can
    // cook it. The distinction exists so the stale case can shout.
    if (input.staleRoles.includes(role)) {
      return noop(role, 'sensor-stale', climate?.sourceNodeIds ?? []);
    }
    if (!climate) {
      return noop(role, 'no-sensor', []);
    }

    switch (role) {
      case DeviceRole.Lights:
        return {
          role,
          ...lights(climate, thresholds, inWindow),
          sourceNodeIds: climate.sourceNodeIds,
        };
      case DeviceRole.Co2Generator:
        return {
          role,
          ...co2Generator(climate, thresholds, inWindow),
          sourceNodeIds: climate.sourceNodeIds,
        };
      case DeviceRole.ExhaustFan:
        return {
          role,
          ...exhaustFan(climate, thresholds),
          sourceNodeIds: climate.sourceNodeIds,
        };
    }
  });
}

type Verdict = { desired: RuleDecision['desired']; reason: RuleReason };

/**
 * Lights are a heat source as well as light, which is why they have 1 °C of
 * hysteresis and why they are temperature-driven at all.
 *
 * Deliberate change from the Python original: it read
 * `if self._light() and self._lights()`, so deleting one light row silently
 * disabled the other. Each device now stands alone.
 */
function lights(
  climate: ClimateSample,
  t: RulesThresholds,
  inWindow: boolean,
): Verdict {
  if (!inWindow) {
    return { desired: 'off', reason: 'outside-window' };
  }
  if (climate.temperatureC < t.lightsOnTemp) {
    return { desired: 'on', reason: 'temp-below-setpoint' };
  }
  if (climate.temperatureC > t.lightsOffTemp) {
    return { desired: 'off', reason: 'temp-above-setpoint' };
  }
  return { desired: 'noop', reason: 'dead-band' };
}

/**
 * The CO2 generator wears two hats, and the two branches are genuinely
 * different rules rather than one rule with a modifier.
 *
 * By day it is an enrichment device: on only while it is cool enough to be
 * useful AND the concentration is still below target. By night it is the
 * greenhouse's heat source and CO2 is irrelevant - pure frost protection.
 *
 * Neither branch has hysteresis. All anti-cycling comes from the device's own
 * `onDelayDuration` (300 s as wired), enforced in `DevicesService`.
 */
function co2Generator(
  climate: ClimateSample,
  t: RulesThresholds,
  inWindow: boolean,
): Verdict {
  if (!inWindow) {
    // Night: CO2 is not consulted at all. A stale or dead CO2 sensor must never
    // be able to withhold heat on a cold night.
    return climate.temperatureC < t.co2NightOnTemp
      ? { desired: 'on', reason: 'frost-protection' }
      : { desired: 'off', reason: 'temp-above-setpoint' };
  }

  if (climate.temperatureC >= t.co2OffTemp) {
    return { desired: 'off', reason: 'temp-above-setpoint' };
  }

  // A null CO2 means UNKNOWN, never zero: the node reports validity honestly
  // and never substitutes a last-known-good value. Coercing to +Infinity keeps
  // the burner off, because a dead sensor stuck on a low reading would
  // otherwise run it indefinitely on a phantom "CO2 is low".
  const co2 =
    climate.co2Ppm === null ? Number.POSITIVE_INFINITY : climate.co2Ppm;

  // A dead band, as the other two roles have. Between the setpoints the
  // burner HOLDS rather than being forced off: that is what turns a few
  // seconds of burn per ignition into a useful run.
  if (co2 >= t.co2OffPpm) {
    return { desired: 'off', reason: 'co2-at-threshold' };
  }
  if (co2 < t.co2OnPpm) {
    return { desired: 'on', reason: 'co2-below-threshold' };
  }
  return { desired: 'noop', reason: 'dead-band' };
}

/** Time-independent: an overheating greenhouse needs venting at 3am too. */
function exhaustFan(climate: ClimateSample, t: RulesThresholds): Verdict {
  if (climate.temperatureC > t.exhaustOnTemp) {
    return { desired: 'on', reason: 'temp-above-setpoint' };
  }
  if (climate.temperatureC < t.exhaustOffTemp) {
    return { desired: 'off', reason: 'temp-below-setpoint' };
  }
  return { desired: 'noop', reason: 'dead-band' };
}

function noop(
  role: DeviceRole,
  reason: RuleReason,
  sourceNodeIds: string[],
): RuleDecision {
  return { role, desired: 'noop', reason, sourceNodeIds };
}

/** `"06:30"` -> 390. Throws rather than guessing: this value gates a burner. */
export function parseWallClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid wall-clock time "${value}"; expected HH:MM`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid wall-clock time "${value}"; expected HH:MM`);
  }
  return hours * 60 + minutes;
}

/**
 * Start inclusive, end exclusive, and midnight-crossing aware - a night window
 * of 18:30 to 06:30 is the normal case here, not an edge case.
 *
 * Equal start and end is a zero-length window and therefore never inside it.
 * That is the literal reading of inclusive/exclusive, and guessing "always"
 * instead would silently turn a mis-typed config into permanent daytime.
 */
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
