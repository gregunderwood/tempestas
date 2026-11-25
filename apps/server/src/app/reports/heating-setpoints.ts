import {
  DeviceRole,
  type RoleRule,
  type SensorSource,
  type ThermostatRule,
} from '@tempestas/domain';
import { parseZoneRulesConfig } from '../rules/rules-config';

export const HEATING_ROLES: readonly DeviceRole[] = [
  DeviceRole.Heater,
  DeviceRole.HeatTape,
];
// Only for a heating role whose rule has no heat on-setpoint to borrow.
export const DEFAULT_FREEZE_WARNING_C = 3;

// The coldest probe, the cautious reading when the rules cannot say which one heat follows.
export const FALLBACK_SENSOR_SOURCE: SensorSource = 'min';

export type ThermostatMode = ThermostatRule['mode'];
export type OnAtByRole = Partial<Record<DeviceRole, number>>;
export type HeatOnBelowByRole = OnAtByRole;
export type SensorSourceByRole = Partial<Record<DeviceRole, SensorSource>>;

export interface FreezeWarning {
  belowC: number;
  isFromRules: boolean;
}

export interface RoleOnBelow {
  onBelowC: number;
  isFromRule: boolean;
}

export function findHeatOnBelowByRole(rulesConfig: unknown): HeatOnBelowByRole {
  return findThermostatOnAtByRole(rulesConfig, HEATING_ROLES, 'heat');
}

export function findThermostatOnAtByRole(
  rulesConfig: unknown,
  roles: readonly DeviceRole[],
  mode: ThermostatMode,
): OnAtByRole {
  const parsed = parseZoneRulesConfig(rulesConfig);
  if (parsed.ok === false) return {};
  const byRole: OnAtByRole = {};
  for (const role of roles) {
    const rule = parsed.config.rules[role];
    if (rule && isAlwaysOnThermostat(rule, mode)) byRole[role] = rule.onAtC;
  }
  return byRole;
}

export function findSensorSourceByRole(
  rulesConfig: unknown,
  roles: readonly DeviceRole[] = HEATING_ROLES,
): SensorSourceByRole {
  const parsed = parseZoneRulesConfig(rulesConfig);
  if (parsed.ok === false) return {};
  const { rules, sensorPolicy } = parsed.config;
  const byRole: SensorSourceByRole = {};
  for (const role of roles) {
    byRole[role] = (rules[role]?.sensor ?? sensorPolicy.default).source;
  }
  return byRole;
}

export function findSensorSourceFor(
  role: DeviceRole,
  sensorSourceByRole: SensorSourceByRole,
): SensorSource {
  return sensorSourceByRole[role] ?? FALLBACK_SENSOR_SOURCE;
}

export function findOnBelowFor(
  role: DeviceRole,
  heatOnBelowByRole: HeatOnBelowByRole,
): RoleOnBelow {
  const ruleOnBelowC = heatOnBelowByRole[role];
  if (ruleOnBelowC === undefined) {
    return { onBelowC: DEFAULT_FREEZE_WARNING_C, isFromRule: false };
  }
  return { onBelowC: ruleOnBelowC, isFromRule: true };
}

// The highest setpoint, because below it at least one heat source should already be running.
export function resolveFreezeWarning(
  heatOnBelowByRole: HeatOnBelowByRole,
): FreezeWarning {
  const setpoints = Object.values(heatOnBelowByRole);
  if (setpoints.length === 0) {
    return { belowC: DEFAULT_FREEZE_WARNING_C, isFromRules: false };
  }
  return { belowC: Math.max(...setpoints), isFromRules: true };
}

// A daylight thermostat is off at night by design, so only a plain one holds its setpoint around the clock.
function isAlwaysOnThermostat(
  rule: RoleRule,
  mode: ThermostatMode,
): rule is ThermostatRule {
  return rule.kind === 'thermostat' && rule.mode === mode;
}
