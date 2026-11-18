import {
  DeviceRole,
  type RoleRuleKind,
  type StalePolicy,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import { parseWallClock } from './rules.engine';

/**
 * The gate between a zone's hand-edited `rules_config` jsonb and the engine.
 *
 * Nothing checked that column before, so a typo was whatever the engine made
 * of it: a misspelled setpoint read as `undefined`, every comparison against it
 * was false, and the role sat in its dead band forever. On a heater that is a
 * freeze, reported as "dead-band" - a perfectly calm-looking reason.
 *
 * So this is strict. Unknown keys are errors, not ignored, because the typo
 * that matters most is the one in an OPTIONAL field: a misspelled `sensor`
 * override would otherwise silently fall back to the zone default.
 *
 * Pure: no I/O, no clock. Errors carry the JSON path, so the log line says
 * which number to fix.
 */

export type ParsedRulesConfig =
  { ok: true; config: ZoneRulesConfig } | { ok: false; errors: string[] };

const ROLES: ReadonlySet<string> = new Set(Object.values(DeviceRole));
const STALE_POLICIES: ReadonlySet<StalePolicy> = new Set(['hold', 'on', 'off']);
/** The kinds that read the zone's daylight window, and so require one. */
const NEEDS_DAYLIGHT: ReadonlySet<RoleRuleKind> = new Set([
  'daylight-thermostat',
  'co2-burner',
]);
/**
 * A slug and a sensor id are each an MQTT topic segment: anything but `/`,
 * `+`, `#` and whitespace.
 */
const SOURCE = /^(mean|max|min|node:[^\s/+#]+|sensor:[^\s/+#]+\/[^\s/+#]+)$/;

const TOP_KEYS = [
  'enabledRoles',
  'sensorPolicy',
  'rules',
  'daylight',
  'timezone',
];
const BASE_RULE_KEYS = ['kind', 'onStale', 'sensor'];
const KIND_KEYS: Record<RoleRuleKind, string[]> = {
  thermostat: ['mode', 'onAtC', 'offAtC'],
  'daylight-thermostat': ['mode', 'onAtC', 'offAtC'],
  'co2-burner': ['dayOffAtC', 'nightOnBelowC', 'co2OnPpm', 'co2OffPpm'],
};

export function parseZoneRulesConfig(raw: unknown): ParsedRulesConfig {
  const errors: string[] = [];

  if (!isObject(raw)) {
    return { ok: false, errors: ['rules_config must be an object'] };
  }
  unknownKeys(raw, TOP_KEYS, '', errors);

  if (typeof raw['timezone'] !== 'string' || raw['timezone'] === '') {
    errors.push('timezone must be an IANA zone name');
  }

  const enabled = raw['enabledRoles'];
  if (!Array.isArray(enabled)) {
    errors.push('enabledRoles must be an array');
  } else {
    enabled.forEach((role, i) => {
      if (typeof role !== 'string' || !ROLES.has(role)) {
        errors.push(`enabledRoles[${i}] "${String(role)}" is not a role`);
      }
    });
  }

  const policy = raw['sensorPolicy'];
  if (!isObject(policy)) {
    errors.push('sensorPolicy must be an object');
  } else {
    unknownKeys(policy, ['default'], 'sensorPolicy.', errors);
    checkSensorPolicy(policy['default'], 'sensorPolicy.default', errors);
  }

  const daylight = raw['daylight'];
  if (daylight !== undefined) {
    checkDaylight(daylight, errors);
  }

  const rules = raw['rules'];
  if (!isObject(rules)) {
    errors.push('rules must be an object');
  } else {
    for (const [role, rule] of Object.entries(rules)) {
      if (!ROLES.has(role)) {
        errors.push(`rules.${role} is not a role`);
        continue;
      }
      checkRule(rule, `rules.${role}`, daylight !== undefined, errors);
    }
    if (Array.isArray(enabled)) {
      for (const role of enabled) {
        if (typeof role === 'string' && ROLES.has(role) && !(role in rules)) {
          // An owned role with no rule would be evaluated against nothing.
          errors.push(`enabled role "${role}" has no rule`);
        }
      }
    }
  }

  return errors.length === 0
    ? { ok: true, config: raw as unknown as ZoneRulesConfig }
    : { ok: false, errors };
}

function checkRule(
  rule: unknown,
  path: string,
  hasDaylight: boolean,
  errors: string[],
): void {
  if (!isObject(rule)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const kind = rule['kind'];
  if (typeof kind !== 'string' || !(kind in KIND_KEYS)) {
    errors.push(
      `${path}.kind "${String(kind)}" is not one of ${Object.keys(KIND_KEYS).join(', ')}`,
    );
    return;
  }
  const typedKind = kind as RoleRuleKind;
  unknownKeys(
    rule,
    [...BASE_RULE_KEYS, ...KIND_KEYS[typedKind]],
    `${path}.`,
    errors,
  );

  if (!STALE_POLICIES.has(rule['onStale'] as StalePolicy)) {
    // Required rather than defaulted: what a heater does when its thermometer
    // dies is a decision somebody has to have made, per environment.
    errors.push(`${path}.onStale must be "hold", "on" or "off"`);
  }
  if (rule['sensor'] !== undefined) {
    checkSensorPolicy(rule['sensor'], `${path}.sensor`, errors);
  }
  if (NEEDS_DAYLIGHT.has(typedKind) && !hasDaylight) {
    errors.push(`${path} is a ${kind} rule, which needs a daylight window`);
  }

  switch (typedKind) {
    case 'thermostat':
    case 'daylight-thermostat':
      checkThermostat(rule, path, errors);
      return;
    case 'co2-burner':
      checkCo2Burner(rule, path, errors);
      return;
  }
}

/**
 * The band has to point the right way and have width. A heat thermostat with
 * on >= off has no dead band at all: it flips on every reading that crosses
 * one number, and a relay switching a 120 V heater coil does not survive that
 * for a winter.
 */
function checkThermostat(
  rule: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const mode = rule['mode'];
  if (mode !== 'heat' && mode !== 'cool') {
    errors.push(`${path}.mode must be "heat" or "cool"`);
  }
  const on = finite(rule['onAtC'], `${path}.onAtC`, errors);
  const off = finite(rule['offAtC'], `${path}.offAtC`, errors);
  if (on === null || off === null) return;

  if (mode === 'heat' && !(on < off)) {
    errors.push(
      `${path}: a heat thermostat needs onAtC (${on}) below offAtC (${off})`,
    );
  }
  if (mode === 'cool' && !(on > off)) {
    errors.push(
      `${path}: a cool thermostat needs onAtC (${on}) above offAtC (${off})`,
    );
  }
}

function checkCo2Burner(
  rule: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  finite(rule['dayOffAtC'], `${path}.dayOffAtC`, errors);
  finite(rule['nightOnBelowC'], `${path}.nightOnBelowC`, errors);
  const on = finite(rule['co2OnPpm'], `${path}.co2OnPpm`, errors);
  const off = finite(rule['co2OffPpm'], `${path}.co2OffPpm`, errors);
  if (on !== null && off !== null && !(on < off)) {
    // The dead band exists because a single setpoint made the burner re-ignite
    // every few seconds. Zero width is that bug back.
    errors.push(`${path}: co2OnPpm (${on}) must be below co2OffPpm (${off})`);
  }
}

function checkSensorPolicy(
  policy: unknown,
  path: string,
  errors: string[],
): void {
  if (!isObject(policy)) {
    errors.push(`${path} must be an object`);
    return;
  }
  unknownKeys(policy, ['source', 'maxAgeMs'], `${path}.`, errors);
  const source = policy['source'];
  if (typeof source !== 'string' || !SOURCE.test(source)) {
    errors.push(
      `${path}.source "${String(source)}" must be mean, max, min, node:<slug> or sensor:<slug>/<id>`,
    );
  }
  const maxAge = policy['maxAgeMs'];
  if (maxAge !== undefined && !(typeof maxAge === 'number' && maxAge > 0)) {
    errors.push(`${path}.maxAgeMs must be a positive number of milliseconds`);
  }
}

function checkDaylight(daylight: unknown, errors: string[]): void {
  if (!isObject(daylight)) {
    errors.push('daylight must be an object');
    return;
  }
  unknownKeys(daylight, ['start', 'end'], 'daylight.', errors);
  for (const key of ['start', 'end']) {
    try {
      parseWallClock(String(daylight[key]));
    } catch {
      errors.push(`daylight.${key} must be HH:MM`);
    }
  }
}

function finite(value: unknown, path: string, errors: string[]): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  errors.push(`${path} must be a number`);
  return null;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${prefix}${key} is not a recognised setting`);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
