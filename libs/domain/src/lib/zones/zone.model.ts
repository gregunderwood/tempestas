import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';

/** Five options, deliberately, not a predicate language. `node:` aggregates by mean. */
export type SensorSource =
  'mean' | 'max' | 'min' | `node:${NodeId}` | `sensor:${NodeId}/${string}`;

export interface SensorPolicy {
  source: SensorSource;
  /** An older sample is omitted, collapsing staleness into "no sensor". */
  maxAgeMs?: number;
}

/** `hold` leaves a human to decide where failing either way can harm the crop. */
export type StalePolicy = 'hold' | 'on' | 'off';

/** Local wall-clock `HH:MM`. Start inclusive, end exclusive, may cross midnight. */
export interface DaylightWindow {
  start: string;
  end: string;
}

interface RoleRuleBase {
  onStale: StalePolicy;
  /** Overrides the zone's default sensor policy for this role only. */
  sensor?: SensorPolicy;
}

/** Comparisons are strict, so the setpoints sit inside the dead band. */
interface ThermostatBand {
  mode: 'heat' | 'cool';
  onAtC: number;
  offAtC: number;
}

export interface ThermostatRule extends RoleRuleBase, ThermostatBand {
  kind: 'thermostat';
}

/** Unconditionally off outside the zone's daylight window. */
export interface DaylightThermostatRule extends RoleRuleBase, ThermostatBand {
  kind: 'daylight-thermostat';
}

/** CO2 enrichment by day, frost protection by night: night never consults CO2. */
export interface Co2BurnerRule extends RoleRuleBase {
  kind: 'co2-burner';
  dayOffAtC: number;
  nightOnBelowC: number;
  /** A dead band, not one setpoint: a single threshold makes a combustion appliance chatter. */
  co2OnPpm: number;
  co2OffPpm: number;
}

/** A fixed menu: a new kind is a code change with tests, never a config change. */
export type RoleRule = ThermostatRule | DaylightThermostatRule | Co2BurnerRule;

export type RoleRuleKind = RoleRule['kind'];

export interface ZoneRulesConfig {
  /** Explicit, never inferred from which devices or rules exist. */
  enabledRoles: DeviceRole[];
  sensorPolicy: {
    default: SensorPolicy;
  };
  /** Must cover every enabled role. */
  rules: Partial<Record<DeviceRole, RoleRule>>;
  /** Shared by every rule that reads it, so lights and burner agree on when night is. */
  daylight?: DaylightWindow;
  /** IANA zone, never the host locale. */
  timezone: string;
}

export interface Zone {
  id: string;
  slug: string;
  displayName: string;
  rulesConfig: ZoneRulesConfig;
  updatedAt: string;
}
