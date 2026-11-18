import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';

/**
 * A zone is an airspace: one greenhouse, one pumphouse - one temperature, one
 * CO2 concentration.
 *
 * Rules scope to a zone rather than a node because a node is a wiring identity.
 * The greenhouse has sensors at each end and relays wherever the wiring landed;
 * scoping rules to nodes would mean the node holding the burner could not see
 * the thermometer at the other end.
 */

/**
 * How a role picks its climate reading when a zone has several sensor nodes.
 * Four options, deliberately - not a predicate language.
 *
 *   mean | max | min | node:<slug>
 */
export type SensorSource = 'mean' | 'max' | 'min' | `node:${NodeId}`;

export interface SensorPolicy {
  source: SensorSource;
  /** A sample older than this is omitted, collapsing staleness into "no sensor". */
  maxAgeMs?: number;
}

/**
 * What a role does while its sensors are stale.
 *
 * `hold` keeps the last state, which is right for the greenhouse burner:
 * failing it off can freeze the crop and forcing it on can cook it, so a human
 * decides. A pumphouse has no "cook it" direction - a heater left running costs
 * electricity, a heater left off costs the pipes - so its roles say `on`.
 * Every policy still logs at ERROR and raises the stale banner.
 */
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

/**
 * On/off around a dead band. Every comparison is strict, so the setpoints
 * themselves are inside the band and hold.
 *
 *   heat: on below `onAtC`, off above `offAtC` - so `onAtC < offAtC`
 *   cool: on above `onAtC`, off below `offAtC` - so `onAtC > offAtC`
 */
export interface ThermostatRule extends RoleRuleBase {
  kind: 'thermostat';
  mode: 'heat' | 'cool';
  onAtC: number;
  offAtC: number;
}

/**
 * A thermostat that only runs inside the zone's daylight window, and is
 * unconditionally off outside it. The greenhouse lights: a heat source, but
 * never at night.
 */
export interface DaylightThermostatRule extends RoleRuleBase {
  kind: 'daylight-thermostat';
  mode: 'heat' | 'cool';
  onAtC: number;
  offAtC: number;
}

/**
 * The greenhouse's propane CO2 generator, which is also its night heater. Two
 * genuinely different rules switched by the zone's daylight window:
 *
 *   day:   off at or above `dayOffAtC`; else on below `co2OnPpm`, off at or
 *          above `co2OffPpm`, holding in between
 *   night: on below `nightOnBelowC`, else off - CO2 is never consulted
 */
export interface Co2BurnerRule extends RoleRuleBase {
  kind: 'co2-burner';
  dayOffAtC: number;
  nightOnBelowC: number;
  /**
   * A dead band rather than one setpoint. A single threshold on a combustion
   * appliance chatters: measured in the greenhouse, the burner cut at 1509 ppm
   * and the rule wanted it back on at 1494 - every cycle an ignition for a few
   * seconds of burn, gated only by the minimum-off time.
   */
  co2OnPpm: number;
  co2OffPpm: number;
}

/**
 * The menu. A zone chooses a kind per role and sets its numbers; it cannot
 * invent logic. A new kind is a code change with tests, never a config change.
 */
export type RoleRule = ThermostatRule | DaylightThermostatRule | Co2BurnerRule;

export type RoleRuleKind = RoleRule['kind'];

export interface ZoneRulesConfig {
  /**
   * What this deployment actually controls. Explicit, never inferred from which
   * devices exist - or from which rules exist: "no lights device" must not mean
   * the same thing as "the other Pi owns lights". A zone may carry a rule for a
   * role it does not own, which is how the greenhouse keeps its lights and fan
   * settings across the transition.
   */
  enabledRoles: DeviceRole[];
  sensorPolicy: {
    default: SensorPolicy;
  };
  /** Must cover every enabled role. */
  rules: Partial<Record<DeviceRole, RoleRule>>;
  /**
   * When it is day in this zone. Required by any rule that reads it, and shared
   * by all of them, so lights and burner cannot disagree about when night is.
   * Also where the day/night statistics are split.
   */
  daylight?: DaylightWindow;
  /** IANA zone. Never read from the host locale - that was the old DST bug. */
  timezone: string;
}

export interface Zone {
  id: string;
  slug: string;
  displayName: string;
  rulesConfig: ZoneRulesConfig;
}
