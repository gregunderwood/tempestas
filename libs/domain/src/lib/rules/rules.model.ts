import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';
import type { ZoneRulesConfig } from '../zones/zone.model';

/** Carries provenance so the UI and the logs can say which sensors a decision came from. */
export interface ClimateSample {
  temperatureC: number;
  co2Ppm: number | null;
  observedAt: string;
  /** Each contributing node once, however many of its sensors contributed. */
  sourceNodeIds: NodeId[];
  /** As `node/sensor`. */
  sourceSensorIds: string[];
  /** One for `min`/`max` unless tied, otherwise every contributor. */
  decidingSensorIds: string[];
}

export interface RulesInput {
  /** The caller resolves the timezone, which keeps the engine pure and DST testable. */
  minutesSinceMidnightLocal: number;
  config: ZoneRulesConfig;
  enabledRoles: readonly DeviceRole[];
  /** A role absent here has no usable sensor, and yields a `no-sensor` no-op. */
  climateByRole: Readonly<Partial<Record<DeviceRole, ClimateSample>>>;
  /** Separate from absent: a sensor that went quiet is an incident, not a configuration gap. */
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

/** One decision fans out to every device sharing the role, and their outcomes may differ. */
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

/** Echoes every input beside the decisions, so a burner left off is told apart from a rule that never ran. */
export interface RulesEvaluation {
  zoneId: string;
  zoneSlug: string;
  evaluatedAt: string;
  minutesSinceMidnightLocal: number;
  localTime: string;
  timezone: string;
  enabledRoles: DeviceRole[];
  climateByRole: Partial<Record<DeviceRole, ClimateSample>>;
  staleRoles: DeviceRole[];
  decisions: DecisionOutcome[];
}

export interface ZoneFailure {
  zoneSlug: string;
  reason: string;
}

/** Every zone in one message, so a screen never mixes zones from different cycles. */
export interface RulesCycle {
  at: string;
  evaluations: RulesEvaluation[];
  failingZones: ZoneFailure[];
}
