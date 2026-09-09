import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';
import type { ZoneRulesConfig } from '../zones/zone.model';

/**
 * The climate a single role is evaluated against, already resolved from the
 * zone's sensor policy. Provenance is carried so the UI and the logs can say
 * WHICH sensors a decision came from.
 */
export interface ClimateSample {
  temperatureC: number;
  co2Ppm: number | null;
  observedAt: string;
  sourceNodeIds: NodeId[];
}

/**
 * Input to the pure rules engine.
 *
 * Note `minutesSinceMidnightLocal`: the caller resolves the IANA zone, the
 * engine sees a number. That is what makes the engine pure, and what makes the
 * DST tests possible. Nothing in the engine may call `new Date()`.
 */
export interface RulesInput {
  minutesSinceMidnightLocal: number;
  config: ZoneRulesConfig;
  enabledRoles: readonly DeviceRole[];
  /** A role absent here has no usable sensor - it yields a `no-sensor` no-op. */
  climateByRole: Readonly<Partial<Record<DeviceRole, ClimateSample>>>;
}

export type DesiredState = 'on' | 'off' | 'noop';

export type RuleReason =
  | 'temp-below-setpoint'
  | 'temp-above-setpoint'
  | 'dead-band'
  | 'outside-window'
  | 'co2-below-threshold'
  | 'co2-at-threshold'
  | 'frost-protection'
  | 'role-not-owned'
  | 'no-sensor'
  | 'sensor-stale';

export interface RuleDecision {
  role: DeviceRole;
  desired: DesiredState;
  reason: RuleReason;
  sourceNodeIds: NodeId[];
}
