import type {
  DecisionOutcome,
  DeviceDispatch,
  DeviceRole,
  RuleReason,
  SensorPolicy,
  StalePolicy,
} from '@tempestas/domain';
import {
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_HOUR,
  SECONDS_PER_MINUTE,
} from '../../shared/time';

export type DecisionTone = 'on' | 'off' | 'hold' | 'warn' | 'idle';

const NODE_SOURCE_PREFIX = 'node:';
const SENSOR_SOURCE_PREFIX = 'sensor:';
const HOUR_MINUTE_PATTERN = /^(\d{1,2}):(\d{2})$/;
const HOURS_PER_DAY = 24;

const ROLE_LABELS: Record<DeviceRole, string> = {
  heater: 'Heater',
  heat_tape: 'Heat tape',
  co2_generator: 'CO₂ generator',
  lights: 'Lights',
  exhaust_fan: 'Exhaust fan',
};

const REASON_DESCRIPTIONS: Record<RuleReason, string> = {
  'temp-below-setpoint': 'below setpoint',
  'temp-above-setpoint': 'above setpoint',
  'dead-band': 'in the dead band, holding',
  'outside-window': 'outside the daylight window',
  'co2-below-threshold': 'CO₂ below threshold',
  'co2-at-threshold': 'CO₂ at threshold',
  'frost-protection': 'frost protection',
  'role-not-owned': 'not driven by tempestas',
  'no-sensor': 'no sensor',
  'sensor-stale': 'sensors stale, holding last state',
  'stale-failsafe': 'sensors stale, failsafe',
};

const WARNING_REASONS: ReadonlySet<RuleReason> = new Set<RuleReason>([
  'sensor-stale',
  'stale-failsafe',
  'no-sensor',
]);

const STALE_POLICY_DESCRIPTIONS: Record<StalePolicy, string> = {
  hold: 'hold last state',
  on: 'turn ON',
  off: 'turn off',
};

const AGGREGATE_SOURCE_DESCRIPTIONS = new Map<string, string>([
  ['min', 'the coldest probe'],
  ['max', 'the warmest probe'],
  ['mean', 'the average of every probe'],
]);

const DISPATCH_DESCRIPTIONS: Record<DeviceDispatch['outcome'], string> = {
  applied: 'switched by the rule',
  'already-in-state': 'where the rule wants it',
  cooldown: 'waiting out its minimum-off time',
  'rules-disabled': 'automation off for this device',
  failed: 'FAILED',
};

export function labelRole(role: DeviceRole): string {
  return ROLE_LABELS[role] ?? role;
}

export function describeReason(reason: RuleReason): string {
  return REASON_DESCRIPTIONS[reason] ?? reason;
}

export function chooseDecisionTone(decision: DecisionOutcome): DecisionTone {
  if (WARNING_REASONS.has(decision.reason)) return 'warn';
  if (decision.reason === 'role-not-owned') return 'idle';
  if (decision.desired === 'noop') return 'hold';
  return decision.desired;
}

export function describeDecision(decision: DecisionOutcome): string {
  const action =
    decision.desired === 'noop' ? 'hold' : decision.desired.toUpperCase();
  return `${action} · ${describeReason(decision.reason)}`;
}

export function describeStalePolicy(policy: StalePolicy): string {
  return `If its sensors go quiet: ${STALE_POLICY_DESCRIPTIONS[policy]}.`;
}

export function describeSensorPolicy(policy: SensorPolicy): string {
  const staleAfter =
    policy.maxAgeMs === undefined
      ? ''
      : ` · stale after ${formatDuration(policy.maxAgeMs / MILLISECONDS_PER_SECOND)}`;
  return `Controls on ${describeSensorSource(String(policy.source))}${staleAfter}`;
}

export function describeSensorSource(source: string): string {
  const aggregateDescription = AGGREGATE_SOURCE_DESCRIPTIONS.get(source);
  if (aggregateDescription) return aggregateDescription;
  const nodeSlug = readNodeSlug(source);
  if (nodeSlug !== null) return `the probes on ${nodeSlug}`;
  const sensorKey = readSingleSensorKey(source);
  if (sensorKey !== null) return `${sensorKey} only`;
  return source;
}

export function readNodeSlug(source: string): string | null {
  return readAfterPrefix(source, NODE_SOURCE_PREFIX);
}

export function readSingleSensorKey(source: string): string | null {
  return readAfterPrefix(source, SENSOR_SOURCE_PREFIX);
}

function readAfterPrefix(source: string, prefix: string): string | null {
  return source.startsWith(prefix) ? source.slice(prefix.length) : null;
}

export function describeDispatch(
  dispatch: DeviceDispatch | undefined,
): string | null {
  if (!dispatch) return null;
  const description = DISPATCH_DESCRIPTIONS[dispatch.outcome];
  const hasFailureDetail =
    dispatch.outcome === 'failed' && Boolean(dispatch.detail);
  return hasFailureDetail ? `${description}: ${dispatch.detail}` : description;
}

export function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  if (totalSeconds < SECONDS_PER_MINUTE) return `${totalSeconds} s`;

  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const remainingSeconds = totalSeconds % SECONDS_PER_MINUTE;
  if (totalMinutes < MINUTES_PER_HOUR) {
    return remainingSeconds === 0
      ? `${totalMinutes} min`
      : `${totalMinutes}:${padToTwoDigits(remainingSeconds)}`;
  }

  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  return `${hours} h ${totalMinutes % MINUTES_PER_HOUR} min`;
}

export function parseHourMinute(value: unknown): number | null {
  const match =
    typeof value === 'string' ? HOUR_MINUTE_PATTERN.exec(value) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const isValidTime = hours < HOURS_PER_DAY && minutes < MINUTES_PER_HOUR;
  return isValidTime ? hours * MINUTES_PER_HOUR + minutes : null;
}

export function formatHourMinute(minutesSinceMidnight: number): string {
  const hours = Math.floor(minutesSinceMidnight / MINUTES_PER_HOUR);
  const minutes = minutesSinceMidnight % MINUTES_PER_HOUR;
  return `${padToTwoDigits(hours)}:${padToTwoDigits(minutes)}`;
}

function padToTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}
