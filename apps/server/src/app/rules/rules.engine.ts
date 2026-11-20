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
 * The rule bodies are a fixed menu - `RoleRule['kind']` - chosen per role by
 * the zone's config, which supplies only numbers. There is deliberately no rule
 * DSL: a predicate language with one user is a liability when a mis-click
 * controls a propane burner. A new environment picks from the menu; a new kind
 * of rule is a code change with tests.
 */

/**
 * Evaluated in this order, every time, so decisions and logs are comparable.
 * Never the order of the zone's `rules` object: Postgres reorders jsonb keys.
 * Every role the enum has must appear here, or a zone that configures it is
 * silently never evaluated - a spec asserts that.
 */
export const ROLE_ORDER: readonly DeviceRole[] = [
  DeviceRole.Lights,
  DeviceRole.Co2Generator,
  DeviceRole.ExhaustFan,
  DeviceRole.Heater,
  DeviceRole.HeatTape,
];

export function evaluateRules(input: RulesInput): RuleDecision[] {
  const { config } = input;
  // A role is decided if the zone owns it or carries a rule for it, so an
  // unowned role still reports `role-not-owned` rather than vanishing.
  const roles = ROLE_ORDER.filter(
    (role) =>
      config.rules[role] !== undefined || input.enabledRoles.includes(role),
  );

  return roles.map((role) => {
    // Ownership is explicit, never inferred from which devices exist. An empty
    // device list must not mean the same thing as "the other controller owns
    // this" on a system that runs a heater in winter.
    if (!input.enabledRoles.includes(role)) {
      return noop(role, 'role-not-owned', []);
    }

    const rule = config.rules[role];
    if (!rule) {
      // parseZoneRulesConfig refuses this before it can get here. If it ever
      // does, the whole zone fails loudly rather than one owned role quietly
      // doing nothing.
      throw new Error(`Role "${role}" is enabled but has no rule`);
    }

    const climate = input.climateByRole[role];

    if (input.staleRoles.includes(role)) {
      return onStale(role, rule.onStale, climate?.sourceNodeIds ?? []);
    }
    if (!climate) {
      return noop(role, 'no-sensor', []);
    }

    return {
      role,
      ...apply(rule, climate, input.minutesSinceMidnightLocal, config.daylight),
      sourceNodeIds: climate.sourceNodeIds,
    };
  });
}

type Verdict = { desired: RuleDecision['desired']; reason: RuleReason };

function apply(
  rule: RoleRule,
  climate: ClimateSample,
  minutes: number,
  daylight: DaylightWindow | undefined,
): Verdict {
  switch (rule.kind) {
    case 'thermostat':
      return thermostat(rule.mode, rule.onAtC, rule.offAtC, climate);
    case 'daylight-thermostat':
      // Outside the window it is off however cold it is - the greenhouse
      // lights are a heat source, but never at night.
      return isDaytime(minutes, daylight)
        ? thermostat(rule.mode, rule.onAtC, rule.offAtC, climate)
        : { desired: 'off', reason: 'outside-window' };
    case 'co2-burner':
      return co2Burner(rule, climate, isDaytime(minutes, daylight));
  }
}

/**
 * Stale sensors. `hold` is a no-op, exactly as before rule kinds existed;
 * `on`/`off` drive the role and say why. All three are an incident: the
 * caller logs ERROR and raises the banner for every stale role regardless.
 */
function onStale(
  role: DeviceRole,
  policy: StalePolicy,
  sourceNodeIds: string[],
): RuleDecision {
  if (policy === 'hold') {
    return noop(role, 'sensor-stale', sourceNodeIds);
  }
  return { role, desired: policy, reason: 'stale-failsafe', sourceNodeIds };
}

/**
 * A dead band, with every comparison strict so the setpoints themselves hold.
 * Inside the band the answer is `noop`, not a guess: changing state there is
 * what makes a relay chatter.
 */
function thermostat(
  mode: 'heat' | 'cool',
  onAtC: number,
  offAtC: number,
  climate: ClimateSample,
): Verdict {
  const t = climate.temperatureC;
  if (mode === 'heat') {
    if (t < onAtC) return { desired: 'on', reason: 'temp-below-setpoint' };
    if (t > offAtC) return { desired: 'off', reason: 'temp-above-setpoint' };
  } else {
    if (t > onAtC) return { desired: 'on', reason: 'temp-above-setpoint' };
    if (t < offAtC) return { desired: 'off', reason: 'temp-below-setpoint' };
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
 * Neither temperature branch has hysteresis. Anti-cycling comes from the
 * device's own `onDelayDuration` (300 s as wired), enforced in `DevicesService`.
 */
function co2Burner(
  rule: Co2BurnerRule,
  climate: ClimateSample,
  daytime: boolean,
): Verdict {
  if (!daytime) {
    // Night: CO2 is not consulted at all. A stale or dead CO2 sensor must never
    // be able to withhold heat on a cold night.
    return climate.temperatureC < rule.nightOnBelowC
      ? { desired: 'on', reason: 'frost-protection' }
      : { desired: 'off', reason: 'temp-above-setpoint' };
  }

  if (climate.temperatureC >= rule.dayOffAtC) {
    return { desired: 'off', reason: 'temp-above-setpoint' };
  }

  // A null CO2 means UNKNOWN, never zero: the node reports validity honestly
  // and never substitutes a last-known-good value. Coercing to +Infinity keeps
  // the burner off, because a dead sensor stuck on a low reading would
  // otherwise run it indefinitely on a phantom "CO2 is low".
  const co2 =
    climate.co2Ppm === null ? Number.POSITIVE_INFINITY : climate.co2Ppm;

  // Between the setpoints the burner HOLDS rather than being forced off: that
  // is what turns a few seconds of burn per ignition into a useful run.
  if (co2 >= rule.co2OffPpm) {
    return { desired: 'off', reason: 'co2-at-threshold' };
  }
  if (co2 < rule.co2OnPpm) {
    return { desired: 'on', reason: 'co2-below-threshold' };
  }
  return { desired: 'noop', reason: 'dead-band' };
}

function isDaytime(
  minutes: number,
  daylight: DaylightWindow | undefined,
): boolean {
  if (!daylight) {
    // parseZoneRulesConfig requires a window for every kind that reads one.
    // Guessing day or night here would pick a burner's branch at random.
    throw new Error('This rule needs the zone to define a daylight window');
  }
  return isWithinWindow(
    minutes,
    parseWallClock(daylight.start),
    parseWallClock(daylight.end),
  );
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
