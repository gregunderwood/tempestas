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
  /** Each contributing node once, however many of its sensors contributed. */
  sourceNodeIds: NodeId[];
  /** Each contributing sensor, as `node/sensor` - which probe it actually was. */
  sourceSensorIds: string[];
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
  /**
   * Roles whose sensors exist but have gone quiet. Separate from simply being
   * absent because the two need different responses: no sensor at all is a
   * configuration gap, whereas a sensor that stopped reporting is an incident
   * that has to raise a visible alarm. Both hold last state - failing everything
   * off can freeze the greenhouse and forcing heat on can cook it, so a human
   * decides - but only one of them is worth waking somebody for.
   */
  staleRoles: readonly DeviceRole[];
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
  | 'sensor-stale'
  /** Stale, and the role's `onStale` says to drive it rather than hold. */
  | 'stale-failsafe';

export interface RuleDecision {
  role: DeviceRole;
  desired: DesiredState;
  reason: RuleReason;
  sourceNodeIds: NodeId[];
}

/**
 * What one device did with a decision.
 *
 * A decision is not an action: several devices can share a `(zone, role)`, each
 * with its own `rulesEnabled` and its own cooldown, so one decision fans out
 * into per-device outcomes that may legitimately differ.
 */
export interface DeviceDispatch {
  deviceId: string;
  deviceName: string;
  outcome:
    'applied' | 'already-in-state' | 'cooldown' | 'rules-disabled' | 'failed';
  /** Present on `failed`, and on `cooldown` where it carries `canTurnOnAt`. */
  detail?: string;
}

export interface DecisionOutcome extends RuleDecision {
  dispatched: DeviceDispatch[];
}

/**
 * The response of `GET /api/rules/last-evaluation`.
 *
 * The endpoint exists because the Python system had no equivalent: it logged
 * what it did but never what it saw, so a burner that stayed off was
 * indistinguishable from a rule that never ran. Every input that produced the
 * decisions is echoed back alongside them.
 */
export interface RulesEvaluation {
  zoneId: string;
  zoneSlug: string;
  /** ISO-8601. */
  evaluatedAt: string;
  minutesSinceMidnightLocal: number;
  localTime: string;
  timezone: string;
  enabledRoles: DeviceRole[];
  climateByRole: Partial<Record<DeviceRole, ClimateSample>>;
  staleRoles: DeviceRole[];
  decisions: DecisionOutcome[];
}
