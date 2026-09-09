import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';

/**
 * A zone is an airspace: one greenhouse, one temperature, one CO2 concentration.
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

export interface RulesThresholds {
  /** Local wall-clock, inclusive. */
  startTime: string;
  /** Local wall-clock, exclusive. */
  endTime: string;
  lightsOnTemp: number;
  lightsOffTemp: number;
  co2OffTemp: number;
  co2NightOnTemp: number;
  exhaustOnTemp: number;
  exhaustOffTemp: number;
  co2ThresholdPpm: number;
}

export interface ZoneRulesConfig {
  /**
   * What this deployment actually controls. Explicit, never inferred from which
   * devices exist: "no lights device" must not mean the same thing as "the other
   * Pi owns lights". During the transition this is `['co2_generator']`.
   */
  enabledRoles: DeviceRole[];
  sensorPolicy: {
    default: SensorPolicy;
    byRole?: Partial<Record<DeviceRole, SensorPolicy>>;
  };
  thresholds: RulesThresholds;
  /** IANA zone. Never read from the host locale - that was the old DST bug. */
  timezone: string;
}

export interface Zone {
  id: string;
  slug: string;
  displayName: string;
  rulesConfig: ZoneRulesConfig;
}
