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

export type HeatOnBelowByRole = Partial<Record<DeviceRole, number>>;
export type SensorSourceByRole = Partial<Record<DeviceRole, SensorSource>>;

export interface FreezeWarning {
  belowC: number;
  isFromRules: boolean;
}

export function findHeatOnBelowByRole(rulesConfig: unknown): HeatOnBelowByRole {
  const parsed = parseZoneRulesConfig(rulesConfig);
  if (parsed.ok === false) return {};
  const byRole: HeatOnBelowByRole = {};
  for (const role of HEATING_ROLES) {
    const rule = parsed.config.rules[role];
    if (rule && isHeatThermostat(rule)) byRole[role] = rule.onAtC;
  }
  return byRole;
}

export function findSensorSourceByRole(
  rulesConfig: unknown,
): SensorSourceByRole {
  const parsed = parseZoneRulesConfig(rulesConfig);
  if (parsed.ok === false) return {};
  const { rules, sensorPolicy } = parsed.config;
  const byRole: SensorSourceByRole = {};
  for (const role of HEATING_ROLES) {
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
): number {
  return heatOnBelowByRole[role] ?? DEFAULT_FREEZE_WARNING_C;
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

// A daylight thermostat is off at night by design, so only a plain one says when heat is owed.
function isHeatThermostat(rule: RoleRule): rule is ThermostatRule {
  return rule.kind === 'thermostat' && rule.mode === 'heat';
}
