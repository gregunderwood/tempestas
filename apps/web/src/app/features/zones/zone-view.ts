import {
  sensorKey,
  type ClimateSample,
  type DecisionOutcome,
  type Device,
  type DeviceDispatch,
  type DeviceRole,
  type Node,
  type Reading,
  type RoleRule,
  type RulesCycle,
  type RulesEvaluation,
  type SensorPolicy,
  type Zone,
  type ZoneFailure,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import {
  READING_QUIET_AFTER_SECONDS,
  secondsSince,
} from '../../shared/freshness';
import { buildRuleBars, type ThresholdBar } from './threshold-bar';
import {
  chooseDecisionTone,
  describeDecision,
  describeDispatch,
  describeSensorPolicy,
  describeStalePolicy,
  formatHourMinute,
  labelRole,
  parseHourMinute,
  type DecisionTone,
} from './zone-words';

export const EVALUATION_OLD_AFTER_SECONDS = 60;
const MINUTES_PER_DAY = 24 * 60;

export interface DeviceLine {
  id: string;
  name: string;
  nodeId: string;
  where: string;
  isOn: boolean;
  isManual: boolean;
  cooldownSeconds: number | null;
  outcome: string | null;
  hasFailed: boolean;
}

export interface ProbeLine {
  key: string;
  label: string;
  temperatureC: number;
  ageSeconds: number;
  isQuiet: boolean;
  tag: string | null;
}

export interface RuleRow {
  role: DeviceRole;
  label: string;
  isOwned: boolean;
  bars: ThresholdBar[];
  notes: string[];
  stalePolicy: string;
  decision: { headline: string; tone: DecisionTone } | null;
  devices: DeviceLine[];
  problem: string | null;
}

export interface DaylightStrip {
  window: string;
  segments: { fromPercent: number; widthPercent: number }[];
  nowPercent: number | null;
}

export interface ZoneCard {
  id: string;
  name: string;
  timezone: string;
  localTime: string | null;
  evaluatedAgoSeconds: number | null;
  isEvaluationOld: boolean;
  failure: string | null;
  problems: string[];
  policy: string;
  probes: ProbeLine[];
  daylight: DaylightStrip | null;
  rules: RuleRow[];
  updatedAt: string;
}

export interface ZonesInput {
  zones: readonly Zone[];
  evaluations: readonly RulesEvaluation[];
  failures: readonly ZoneFailure[];
  nodes: readonly Node[];
  readings: readonly Reading[];
  devices: readonly Device[];
  now: number;
}

type ProbeReading = Omit<ProbeLine, 'tag'>;

export function pickNewerCycle(
  socketCycle: RulesCycle | null,
  fetchedCycle: RulesCycle | null,
): RulesCycle | null {
  if (!socketCycle) return fetchedCycle;
  if (!fetchedCycle) return socketCycle;
  return socketCycle.at >= fetchedCycle.at ? socketCycle : fetchedCycle;
}

export function buildZoneCards(input: ZonesInput): ZoneCard[] {
  return input.zones.map((zone) => {
    const failure = findFailure(zone, input.failures);
    try {
      return buildZoneCard(zone, failure, input);
    } catch (error: unknown) {
      return buildUndrawableZoneCard(zone, failure, error);
    }
  });
}

function buildZoneCard(
  zone: Zone,
  failure: string | null,
  input: ZonesInput,
): ZoneCard {
  const config = zone.rulesConfig;
  const evaluation = findCurrentEvaluation(zone, failure, input.evaluations);
  const evaluatedAgoSeconds = evaluation
    ? secondsSince(evaluation.evaluatedAt, input.now)
    : null;
  const daylight = buildDaylight(config, evaluation);
  const ownedRoles = new Set<DeviceRole>(config.enabledRoles ?? []);

  return {
    ...buildEmptyZoneCard(zone, failure),
    timezone: String(config.timezone ?? ''),
    localTime: evaluation?.localTime ?? null,
    evaluatedAgoSeconds,
    isEvaluationOld:
      evaluatedAgoSeconds !== null &&
      evaluatedAgoSeconds > EVALUATION_OLD_AFTER_SECONDS,
    problems: daylight.problems,
    policy: config.sensorPolicy?.default
      ? describeSensorPolicy(config.sensorPolicy.default)
      : 'No sensor policy',
    probes: buildProbeLines(zone, evaluation, input),
    daylight: daylight.strip,
    rules: sortOwnedRolesFirst(config, ownedRoles).map((role) =>
      buildRuleRow(zone, role, ownedRoles.has(role), evaluation, input),
    ),
  };
}

function buildUndrawableZoneCard(
  zone: Zone,
  failure: string | null,
  error: unknown,
): ZoneCard {
  return {
    ...buildEmptyZoneCard(zone, failure),
    problems: [
      `this zone's config cannot be drawn: ${readErrorMessage(error)}`,
    ],
  };
}

function buildEmptyZoneCard(zone: Zone, failure: string | null): ZoneCard {
  return {
    id: zone.id,
    name: zone.displayName,
    timezone: '',
    localTime: null,
    evaluatedAgoSeconds: null,
    isEvaluationOld: false,
    failure,
    problems: [],
    policy: '',
    probes: [],
    daylight: null,
    rules: [],
    updatedAt: zone.updatedAt,
  };
}

function findFailure(
  zone: Zone,
  failures: readonly ZoneFailure[],
): string | null {
  return (
    failures.find((failure) => failure.zoneSlug === zone.slug)?.reason ?? null
  );
}

function findCurrentEvaluation(
  zone: Zone,
  failure: string | null,
  evaluations: readonly RulesEvaluation[],
): RulesEvaluation | null {
  if (failure) return null;
  return (
    evaluations.find((evaluation) => evaluation.zoneId === zone.id) ?? null
  );
}

function sortOwnedRolesFirst(
  config: ZoneRulesConfig,
  ownedRoles: ReadonlySet<DeviceRole>,
): DeviceRole[] {
  const roles = Object.keys(config.rules ?? {}) as DeviceRole[];
  return roles.sort(
    (first, second) =>
      Number(ownedRoles.has(second)) - Number(ownedRoles.has(first)),
  );
}

function buildDaylight(
  config: ZoneRulesConfig,
  evaluation: RulesEvaluation | null,
): { strip: DaylightStrip | null; problems: string[] } {
  if (!config.daylight) return { strip: null, problems: [] };

  const startMinute = parseHourMinute(config.daylight.start);
  const endMinute = parseHourMinute(config.daylight.end);
  if (startMinute === null || endMinute === null) {
    const window = `"${String(config.daylight.start)}"–"${String(config.daylight.end)}"`;
    return {
      strip: null,
      problems: [`daylight window ${window} is not HH:MM`],
    };
  }

  const nowMinute = evaluation?.minutesSinceMidnightLocal ?? null;
  return {
    strip: buildDaylightStrip(startMinute, endMinute, nowMinute),
    problems: [],
  };
}

function buildDaylightStrip(
  startMinute: number,
  endMinute: number,
  nowMinute: number | null,
): DaylightStrip {
  const toPercent = (minute: number): number =>
    (minute / MINUTES_PER_DAY) * 100;
  const crossesMidnight = startMinute > endMinute;
  const segments = crossesMidnight
    ? [
        {
          fromPercent: toPercent(startMinute),
          widthPercent: 100 - toPercent(startMinute),
        },
        { fromPercent: 0, widthPercent: toPercent(endMinute) },
      ]
    : [
        {
          fromPercent: toPercent(startMinute),
          widthPercent: toPercent(endMinute - startMinute),
        },
      ];
  return {
    window: `${formatHourMinute(startMinute)}–${formatHourMinute(endMinute)}`,
    segments,
    nowPercent: nowMinute === null ? null : toPercent(nowMinute),
  };
}

function buildRuleRow(
  zone: Zone,
  role: DeviceRole,
  isOwned: boolean,
  evaluation: RulesEvaluation | null,
  input: ZonesInput,
): RuleRow {
  const decision =
    evaluation?.decisions.find((candidate) => candidate.role === role) ?? null;
  const drawnWithoutRule = {
    role,
    label: labelRole(role),
    isOwned,
    decision: decision
      ? {
          headline: describeDecision(decision),
          tone: chooseDecisionTone(decision),
        }
      : null,
    devices: buildRoleDeviceLines(zone, role, decision, input),
  };

  try {
    const rule = zone.rulesConfig.rules[role] as RoleRule;
    // Never another role's climate: it would show a healthy number for a probe that stopped reporting.
    const ownClimate = evaluation?.climateByRole[role] ?? null;
    return {
      ...drawnWithoutRule,
      ...buildRuleBars(rule, ownClimate),
      stalePolicy: describeStalePolicy(rule.onStale),
      problem: null,
    };
  } catch (error: unknown) {
    return {
      ...drawnWithoutRule,
      bars: [],
      notes: [],
      stalePolicy: '',
      problem: `This rule cannot be drawn: ${readErrorMessage(error)}.`,
    };
  }
}

function buildRoleDeviceLines(
  zone: Zone,
  role: DeviceRole,
  decision: DecisionOutcome | null,
  input: ZonesInput,
): DeviceLine[] {
  return input.devices
    .filter((device) => device.zoneId === zone.id && device.role === role)
    .map((device) =>
      buildDeviceLine(
        device,
        decision?.dispatched.find(
          (dispatch) => dispatch.deviceId === device.id,
        ),
        input.now,
      ),
    );
}

export function buildDeviceLine(
  device: Device,
  dispatch: DeviceDispatch | undefined,
  now: number,
): DeviceLine {
  return {
    id: device.id,
    name: device.name,
    nodeId: device.nodeId,
    where: `${device.nodeId} · BCM${device.gpio}`,
    isOn: device.isOn,
    isManual: !device.rulesEnabled,
    cooldownSeconds: secondsUntilRestart(device, now),
    outcome: describeDispatch(dispatch),
    hasFailed: dispatch?.outcome === 'failed',
  };
}

function secondsUntilRestart(device: Device, now: number): number | null {
  if (device.isOn || !device.canTurnOnAt) return null;
  const restartAt = Date.parse(device.canTurnOnAt);
  return restartAt > now ? Math.ceil((restartAt - now) / 1000) : null;
}

function buildProbeLines(
  zone: Zone,
  evaluation: RulesEvaluation | null,
  input: ZonesInput,
): ProbeLine[] {
  const zoneNodeSlugs = findZoneNodeSlugs(zone, input.nodes);
  const hasSeveralNodes = zoneNodeSlugs.size > 1;
  const probes = input.readings
    .filter((reading) => zoneNodeSlugs.has(reading.nodeId))
    .map((reading) => toProbeReading(reading, hasSeveralNodes, input.now))
    .sort((first, second) => first.label.localeCompare(second.label));

  const measuredRoles = findMeasuredRoles(zone, evaluation);
  const controlledRolesByProbe = mapControlledRolesToProbes(
    zone,
    measuredRoles,
    probes,
  );
  return probes.map((probe) => ({
    ...probe,
    tag: describeControlTag(
      controlledRolesByProbe.get(probe.key) ?? [],
      measuredRoles.length,
    ),
  }));
}

function findZoneNodeSlugs(zone: Zone, nodes: readonly Node[]): Set<string> {
  return new Set(
    nodes.filter((node) => node.zoneId === zone.id).map((node) => node.slug),
  );
}

function toProbeReading(
  reading: Reading,
  hasSeveralNodes: boolean,
  now: number,
): ProbeReading {
  const ageSeconds = secondsSince(reading.createdAt, now);
  return {
    key: sensorKey(reading),
    label: hasSeveralNodes ? sensorKey(reading) : reading.sensorId,
    temperatureC: reading.temperature,
    ageSeconds,
    isQuiet: ageSeconds > READING_QUIET_AFTER_SECONDS,
  };
}

function findMeasuredRoles(
  zone: Zone,
  evaluation: RulesEvaluation | null,
): [DeviceRole, ClimateSample][] {
  return (zone.rulesConfig.enabledRoles ?? []).flatMap((role) => {
    const climate = evaluation?.climateByRole[role];
    return climate ? [[role, climate] as [DeviceRole, ClimateSample]] : [];
  });
}

function mapControlledRolesToProbes(
  zone: Zone,
  measuredRoles: [DeviceRole, ClimateSample][],
  probes: ProbeReading[],
): Map<string, string[]> {
  const controlledRolesByProbe = new Map<string, string[]>();
  for (const [role, climate] of measuredRoles) {
    const policy = findPolicyForRole(zone, role);
    for (const probe of findDecidingProbes(probes, climate, policy)) {
      const controlledRoles = controlledRolesByProbe.get(probe.key) ?? [];
      controlledRolesByProbe.set(probe.key, [
        ...controlledRoles,
        labelRole(role),
      ]);
    }
  }
  return controlledRolesByProbe;
}

function findPolicyForRole(zone: Zone, role: DeviceRole): SensorPolicy | null {
  return (
    zone.rulesConfig.rules?.[role]?.sensor ??
    zone.rulesConfig.sensorPolicy?.default ??
    null
  );
}

function findDecidingProbes(
  probes: ProbeReading[],
  climate: ClimateSample,
  policy: SensorPolicy | null,
): ProbeReading[] {
  const contributors = probes.filter((probe) =>
    climate.sourceSensorIds.includes(probe.key),
  );
  const picksOneProbe = policy?.source === 'min' || policy?.source === 'max';
  if (!picksOneProbe) return contributors;

  // The resolver names contributors, not the winner: the winner is the nearest, and ties mark both.
  const distanceFromResolved = (probe: ProbeReading): number =>
    Math.abs(probe.temperatureC - climate.temperatureC);
  const nearestDistance = Math.min(...contributors.map(distanceFromResolved));
  return contributors.filter(
    (probe) => distanceFromResolved(probe) === nearestDistance,
  );
}

function describeControlTag(
  controlledRoles: string[],
  measuredRoleCount: number,
): string | null {
  if (controlledRoles.length === 0) return null;
  if (controlledRoles.length === measuredRoleCount) return 'controlling';
  return `controls ${controlledRoles.join(', ')}`;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
