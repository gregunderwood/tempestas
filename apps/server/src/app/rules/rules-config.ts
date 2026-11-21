import {
  DeviceRole,
  type RoleRuleKind,
  type StalePolicy,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import { parseWallClock } from './rules.engine';

export type ParsedRulesConfig =
  { ok: true; config: ZoneRulesConfig } | { ok: false; errors: string[] };

type JsonObject = Record<string, unknown>;
type RuleCheck = (rule: JsonObject, path: string, errors: string[]) => void;

const KNOWN_ROLES: ReadonlySet<string> = new Set(Object.values(DeviceRole));
const STALE_POLICIES: ReadonlySet<StalePolicy> = new Set(['hold', 'on', 'off']);
const KINDS_NEEDING_DAYLIGHT: ReadonlySet<RoleRuleKind> = new Set([
  'daylight-thermostat',
  'co2-burner',
]);
// A slug and a sensor id are each an MQTT topic segment: anything but `/`, `+`, `#` and whitespace.
const SENSOR_SOURCE_PATTERN =
  /^(mean|max|min|node:[^\s/+#]+|sensor:[^\s/+#]+\/[^\s/+#]+)$/;

const TOP_LEVEL_KEYS = [
  'enabledRoles',
  'sensorPolicy',
  'rules',
  'daylight',
  'timezone',
];
const SENSOR_POLICY_KEYS = ['source', 'maxAgeMs'];
const DAYLIGHT_KEYS = ['start', 'end'];
const BASE_RULE_KEYS = ['kind', 'onStale', 'sensor'];
const RULE_KINDS: Record<RoleRuleKind, { keys: string[]; check: RuleCheck }> = {
  thermostat: {
    keys: ['mode', 'onAtC', 'offAtC'],
    check: checkThermostat,
  },
  'daylight-thermostat': {
    keys: ['mode', 'onAtC', 'offAtC'],
    check: checkThermostat,
  },
  'co2-burner': {
    keys: ['dayOffAtC', 'nightOnBelowC', 'co2OnPpm', 'co2OffPpm'],
    check: checkCo2Burner,
  },
};

// Strict on purpose: a typo read as undefined leaves a heater calmly in its dead band. See docs/Rules and Climate.md.
export function parseZoneRulesConfig(raw: unknown): ParsedRulesConfig {
  if (!isJsonObject(raw)) {
    return { ok: false, errors: ['rules_config must be an object'] };
  }

  const errors: string[] = [];
  reportUnknownKeys(raw, TOP_LEVEL_KEYS, '', errors);
  checkTimezone(raw['timezone'], errors);
  checkEnabledRoles(raw['enabledRoles'], errors);
  checkZoneSensorPolicy(raw['sensorPolicy'], errors);
  const daylight = raw['daylight'];
  if (daylight !== undefined) {
    checkDaylight(daylight, errors);
  }
  checkRules(raw['rules'], raw['enabledRoles'], daylight !== undefined, errors);

  return errors.length === 0
    ? { ok: true, config: raw as unknown as ZoneRulesConfig }
    : { ok: false, errors };
}

function checkTimezone(timezone: unknown, errors: string[]): void {
  if (typeof timezone !== 'string' || timezone === '') {
    errors.push('timezone must be an IANA zone name');
  }
}

function checkEnabledRoles(enabledRoles: unknown, errors: string[]): void {
  if (!Array.isArray(enabledRoles)) {
    errors.push('enabledRoles must be an array');
    return;
  }
  enabledRoles.forEach((role, index) => {
    if (!isKnownRole(role)) {
      errors.push(`enabledRoles[${index}] "${String(role)}" is not a role`);
    }
  });
}

function checkZoneSensorPolicy(sensorPolicy: unknown, errors: string[]): void {
  if (!isJsonObject(sensorPolicy)) {
    errors.push('sensorPolicy must be an object');
    return;
  }
  reportUnknownKeys(sensorPolicy, ['default'], 'sensorPolicy.', errors);
  checkSensorPolicy(sensorPolicy['default'], 'sensorPolicy.default', errors);
}

function checkRules(
  rules: unknown,
  enabledRoles: unknown,
  hasDaylight: boolean,
  errors: string[],
): void {
  if (!isJsonObject(rules)) {
    errors.push('rules must be an object');
    return;
  }
  for (const [role, rule] of Object.entries(rules)) {
    if (!KNOWN_ROLES.has(role)) {
      errors.push(`rules.${role} is not a role`);
      continue;
    }
    checkRule(rule, `rules.${role}`, hasDaylight, errors);
  }
  if (Array.isArray(enabledRoles)) {
    checkEveryOwnedRoleHasRule(enabledRoles, rules, errors);
  }
}

// An owned role with no rule would be evaluated against nothing.
function checkEveryOwnedRoleHasRule(
  enabledRoles: unknown[],
  rules: JsonObject,
  errors: string[],
): void {
  for (const role of enabledRoles) {
    if (isKnownRole(role) && !(role in rules)) {
      errors.push(`enabled role "${role}" has no rule`);
    }
  }
}

function checkRule(
  rule: unknown,
  path: string,
  hasDaylight: boolean,
  errors: string[],
): void {
  if (!isJsonObject(rule)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const kind = rule['kind'];
  if (typeof kind !== 'string' || !(kind in RULE_KINDS)) {
    errors.push(
      `${path}.kind "${String(kind)}" is not one of ${Object.keys(RULE_KINDS).join(', ')}`,
    );
    return;
  }
  const ruleKind = RULE_KINDS[kind as RoleRuleKind];
  reportUnknownKeys(
    rule,
    [...BASE_RULE_KEYS, ...ruleKind.keys],
    `${path}.`,
    errors,
  );

  if (!STALE_POLICIES.has(rule['onStale'] as StalePolicy)) {
    // Required, not defaulted: what a heater does when its thermometer dies is somebody's decision.
    errors.push(`${path}.onStale must be "hold", "on" or "off"`);
  }
  if (rule['sensor'] !== undefined) {
    checkSensorPolicy(rule['sensor'], `${path}.sensor`, errors);
  }
  if (KINDS_NEEDING_DAYLIGHT.has(kind as RoleRuleKind) && !hasDaylight) {
    errors.push(`${path} is a ${kind} rule, which needs a daylight window`);
  }

  ruleKind.check(rule, path, errors);
}

// A band with no width flips a 120 V heater relay on every reading that crosses one number.
function checkThermostat(
  rule: JsonObject,
  path: string,
  errors: string[],
): void {
  const mode = rule['mode'];
  if (mode !== 'heat' && mode !== 'cool') {
    errors.push(`${path}.mode must be "heat" or "cool"`);
  }
  const onAtC = readFiniteNumber(rule['onAtC'], `${path}.onAtC`, errors);
  const offAtC = readFiniteNumber(rule['offAtC'], `${path}.offAtC`, errors);
  if (onAtC === null || offAtC === null) {
    return;
  }

  if (mode === 'heat' && !(onAtC < offAtC)) {
    errors.push(
      `${path}: a heat thermostat needs onAtC (${onAtC}) below offAtC (${offAtC})`,
    );
  }
  if (mode === 'cool' && !(onAtC > offAtC)) {
    errors.push(
      `${path}: a cool thermostat needs onAtC (${onAtC}) above offAtC (${offAtC})`,
    );
  }
}

function checkCo2Burner(
  rule: JsonObject,
  path: string,
  errors: string[],
): void {
  readFiniteNumber(rule['dayOffAtC'], `${path}.dayOffAtC`, errors);
  readFiniteNumber(rule['nightOnBelowC'], `${path}.nightOnBelowC`, errors);
  const co2OnPpm = readFiniteNumber(
    rule['co2OnPpm'],
    `${path}.co2OnPpm`,
    errors,
  );
  const co2OffPpm = readFiniteNumber(
    rule['co2OffPpm'],
    `${path}.co2OffPpm`,
    errors,
  );
  if (co2OnPpm !== null && co2OffPpm !== null && !(co2OnPpm < co2OffPpm)) {
    // A zero-width band is the re-ignite-every-few-seconds bug the band was added to fix.
    errors.push(
      `${path}: co2OnPpm (${co2OnPpm}) must be below co2OffPpm (${co2OffPpm})`,
    );
  }
}

function checkSensorPolicy(
  policy: unknown,
  path: string,
  errors: string[],
): void {
  if (!isJsonObject(policy)) {
    errors.push(`${path} must be an object`);
    return;
  }
  reportUnknownKeys(policy, SENSOR_POLICY_KEYS, `${path}.`, errors);
  const source = policy['source'];
  if (typeof source !== 'string' || !SENSOR_SOURCE_PATTERN.test(source)) {
    errors.push(
      `${path}.source "${String(source)}" must be mean, max, min, node:<slug> or sensor:<slug>/<id>`,
    );
  }
  if (!isValidMaxAge(policy['maxAgeMs'])) {
    errors.push(`${path}.maxAgeMs must be a positive number of milliseconds`);
  }
}

function isValidMaxAge(maxAgeMs: unknown): boolean {
  return (
    maxAgeMs === undefined || (typeof maxAgeMs === 'number' && maxAgeMs > 0)
  );
}

function checkDaylight(daylight: unknown, errors: string[]): void {
  if (!isJsonObject(daylight)) {
    errors.push('daylight must be an object');
    return;
  }
  reportUnknownKeys(daylight, DAYLIGHT_KEYS, 'daylight.', errors);
  for (const key of DAYLIGHT_KEYS) {
    try {
      parseWallClock(String(daylight[key]));
    } catch {
      errors.push(`daylight.${key} must be HH:MM`);
    }
  }
}

function readFiniteNumber(
  value: unknown,
  path: string,
  errors: string[],
): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  errors.push(`${path} must be a number`);
  return null;
}

function reportUnknownKeys(
  value: JsonObject,
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

function isKnownRole(role: unknown): role is string {
  return typeof role === 'string' && KNOWN_ROLES.has(role);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
