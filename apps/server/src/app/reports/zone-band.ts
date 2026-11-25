import { DeviceRole, type BandBound } from '@tempestas/domain';
import {
  findSensorSourceByRole,
  findSensorSourceFor,
  findThermostatOnAtByRole,
  HEATING_ROLES,
  type OnAtByRole,
  type SensorSourceByRole,
} from './heating-setpoints';

export const COOLING_ROLES: readonly DeviceRole[] = [DeviceRole.ExhaustFan];

/** Where the zone's rules are set to hold it: below a heat on-setpoint, or above a cool one. */
export interface ZoneBand {
  lowerBounds: BandBound[];
  upperBounds: BandBound[];
}

export function findZoneBand(rulesConfig: unknown): ZoneBand {
  const sensorSourceByRole = findSensorSourceByRole(rulesConfig, [
    ...HEATING_ROLES,
    ...COOLING_ROLES,
  ]);
  return {
    lowerBounds: toBounds(
      HEATING_ROLES,
      findThermostatOnAtByRole(rulesConfig, HEATING_ROLES, 'heat'),
      sensorSourceByRole,
    ),
    upperBounds: toBounds(
      COOLING_ROLES,
      findThermostatOnAtByRole(rulesConfig, COOLING_ROLES, 'cool'),
      sensorSourceByRole,
    ),
  };
}

function toBounds(
  roles: readonly DeviceRole[],
  onAtByRole: OnAtByRole,
  sensorSourceByRole: SensorSourceByRole,
): BandBound[] {
  return roles.flatMap((role) => {
    const setpointC = onAtByRole[role];
    if (setpointC === undefined) return [];
    return [
      {
        role,
        setpointC,
        sensorSource: findSensorSourceFor(role, sensorSourceByRole),
      },
    ];
  });
}
