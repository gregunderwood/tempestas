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
  type RuleReason,
  type RulesCycle,
  type RulesEvaluation,
  type Zone,
  type ZoneFailure,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import { READING_QUIET_AFTER_SECONDS } from '../../shared/freshness';
import {
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_DAY,
  secondsSince,
} from '../../shared/time';
import {
  FULL_SCALE_PERCENT,
  buildRuleBars,
  type ThresholdBar,
} from './threshold-bar';
import {
  chooseDecisionTone,
  describeDecision,
  describeDispatch,
  describeSensorPolicy,
  describeStalePolicy,
  formatDuration,
  formatHourMinute,
  labelRole,
  parseHourMinute,
  type DecisionTone,
} from './zone-words';

export const RULES_RUN_OLD_AFTER_SECONDS = 60;

// A co2-burner's only dead band is its daytime CO2 band.
const CO2_BURNER_REASONS_DECIDED_ON_CO2: readonly RuleReason[] = [
  'co2-below-threshold',
  'co2-at-threshold',
  'dead-band',
];

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
  co2Ppm: number | null;
  ageSeconds: number;
  isQuiet: boolean;
  tag: string | null;
  isTemperatureDeciding: boolean;
  isCo2Deciding: boolean;
}

type DecidingMeasurement = 'temperature' | 'co2';

interface DecidingProbes {
  role: DeviceRole;
  measurement: DecidingMeasurement;
  probeKeys: string[];
}

export interface RuleDecision {
  headline: string;
  tone: DecisionTone;
}

export interface RuleRow {
  role: DeviceRole;
  label: string;
  isOwned: boolean;
  bars: ThresholdBar[];
  notes: string[];
  stalePolicy: string;
  decision: RuleDecision | null;
  devices: DeviceLine[];
  problem: string | null;
}

export interface DaylightStrip {
  windowLabel: string;
  segments: { fromPercent: number; widthPercent: number }[];
  nowPercent: number | null;
  screenReaderText: string;
}

export interface ZoneCard {
  id: string;
  name: string;
  timezone: string;
  localTime: string | null;
  rulesRanAgoSeconds: number | null;
  isRulesRunOld: boolean;
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
  cycle: RulesCycle | null;
  nodes: readonly Node[];
  readings: readonly Reading[];
  devices: readonly Device[];
  now: number;
}

type ProbeReading = Omit<
  ProbeLine,
  'tag' | 'isTemperatureDeciding' | 'isCo2Deciding'
>;

export function buildZoneCards(input: ZonesInput): ZoneCard[] {
  return input.zones.map((zone) => {
    const failure = findFailure(zone, input.cycle?.failingZones ?? []);
    try {
      return buildZoneCard(zone, failure, input);
    } catch (error: unknown) {
      return buildUndrawableZoneCard(zone, failure, error);
    }
  });
}

export function describeZoneSubtitle(
  zone: ZoneCard,
  isFollower: boolean,
): string {
  const localTime = zone.localTime
    ? `${zone.localTime} ${zone.timezone}`
    : null;
  const rulesRan = isFollower
    ? null
    : describeRulesRan(zone.rulesRanAgoSeconds);
  return [localTime, rulesRan].filter(isPresent).join(' · ');
}

function describeRulesRan(rulesRanAgoSeconds: number | null): string {
  if (rulesRanAgoSeconds === null) return 'rules have not run yet';
  return `rules ran ${formatDuration(rulesRanAgoSeconds)} ago`;
}

function isPresent(part: string | null): part is string {
  return part !== null;
}

function buildZoneCard(
  zone: Zone,
  failure: string | null,
  input: ZonesInput,
): ZoneCard {
  const config = zone.rulesConfig;
  const evaluation = findCurrentEvaluation(
    zone,
    failure,
    input.cycle?.evaluations ?? [],
  );
  const rulesRanAt = findRulesRanAt(evaluation, failure, input.cycle);
  const rulesRanAgoSeconds = rulesRanAt
    ? secondsSince(rulesRanAt, input.now)
    : null;
  const daylight = buildDaylight(config, evaluation);
  const ownedRoles = new Set<DeviceRole>(config.enabledRoles ?? []);

  return {
    ...buildEmptyZoneCard(zone, failure),
    timezone: String(config.timezone ?? ''),
    localTime: evaluation?.localTime ?? null,
    rulesRanAgoSeconds,
    isRulesRunOld: isRulesRunOld(rulesRanAgoSeconds),
    problems: daylight.problems,
    policy: describeZonePolicy(config),
    probes: buildProbeLines(zone, evaluation, input),
    daylight: daylight.strip,
    rules: sortOwnedRolesFirst(config, ownedRoles).map((role) =>
      buildRuleRow(zone, role, ownedRoles.has(role), evaluation, input),
    ),
  };
}

function findRulesRanAt(
  evaluation: RulesEvaluation | null,
  failure: string | null,
  cycle: RulesCycle | null,
): string | null {
  if (evaluation) return evaluation.evaluatedAt;
  return failure ? (cycle?.at ?? null) : null;
}

function isRulesRunOld(rulesRanAgoSeconds: number | null): boolean {
  return (
    rulesRanAgoSeconds !== null &&
    rulesRanAgoSeconds > RULES_RUN_OLD_AFTER_SECONDS
  );
}

function describeZonePolicy(config: ZoneRulesConfig): string {
  const defaultPolicy = config.sensorPolicy?.default;
  return defaultPolicy
    ? describeSensorPolicy(defaultPolicy)
    : 'No sensor policy';
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
    rulesRanAgoSeconds: null,
    isRulesRunOld: false,
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
    const windowText = `"${String(config.daylight.start)}"–"${String(config.daylight.end)}"`;
    return {
      strip: null,
      problems: [`daylight window ${windowText} is not HH:MM`],
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
    (minute / MINUTES_PER_DAY) * FULL_SCALE_PERCENT;
  const crossesMidnight = startMinute > endMinute;
  const segments = crossesMidnight
    ? [
        {
          fromPercent: toPercent(startMinute),
          widthPercent: FULL_SCALE_PERCENT - toPercent(startMinute),
        },
        { fromPercent: 0, widthPercent: toPercent(endMinute) },
      ]
    : [
        {
          fromPercent: toPercent(startMinute),
          widthPercent: toPercent(endMinute - startMinute),
        },
      ];
  const windowLabel = `${formatHourMinute(startMinute)}–${formatHourMinute(endMinute)}`;
  return {
    windowLabel,
    segments,
    nowPercent: nowMinute === null ? null : toPercent(nowMinute),
    screenReaderText: describeDaylightStrip(windowLabel, nowMinute),
  };
}

function describeDaylightStrip(
  windowLabel: string,
  nowMinute: number | null,
): string {
  const daylight = `Daylight ${windowLabel}`;
  if (nowMinute === null) return daylight;
  return `${daylight}, now ${formatHourMinute(Math.floor(nowMinute))}`;
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
    decision: describeRuleDecision(decision),
    devices: buildRoleDeviceLines(zone, role, decision, input),
  };

  try {
    const rule = zone.rulesConfig.rules[role] as RoleRule;
    // Never another role's climate: it would show a healthy number for a probe that stopped reporting.
    const ownClimate = evaluation?.climateByRole[role] ?? null;
    const isClimateStale = evaluation?.staleRoles.includes(role) ?? false;
    return {
      ...drawnWithoutRule,
      ...buildRuleBars(rule, ownClimate, isClimateStale),
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

function describeRuleDecision(
  decision: DecisionOutcome | null,
): RuleDecision | null {
  if (!decision) return null;
  return {
    headline: describeDecision(decision),
    tone: chooseDecisionTone(decision),
  };
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
      buildDeviceLine(device, findDispatch(decision, device), input.now),
    );
}

function findDispatch(
  decision: DecisionOutcome | null,
  device: Device,
): DeviceDispatch | undefined {
  return decision?.dispatched.find(
    (dispatch) => dispatch.deviceId === device.id,
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
  return restartAt > now
    ? Math.ceil((restartAt - now) / MILLISECONDS_PER_SECOND)
    : null;
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

  const enabledRoles = zone.rulesConfig.enabledRoles ?? [];
  const decidingProbes = findDecidingProbesByRole(zone.rulesConfig, evaluation);
  const controlledRolesByProbe = mapControlledRolesToProbes(decidingProbes);
  return probes.map((probe) => ({
    ...probe,
    tag: describeControlTag(
      controlledRolesByProbe.get(probe.key) ?? [],
      enabledRoles.length,
    ),
    isTemperatureDeciding: isDecidingOn(
      decidingProbes,
      probe.key,
      'temperature',
    ),
    isCo2Deciding: isDecidingOn(decidingProbes, probe.key, 'co2'),
  }));
}

function isDecidingOn(
  decidingProbes: readonly DecidingProbes[],
  probeKey: string,
  measurement: DecidingMeasurement,
): boolean {
  return decidingProbes.some(
    (deciding) =>
      deciding.measurement === measurement &&
      deciding.probeKeys.includes(probeKey),
  );
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
    co2Ppm: reading.co2,
    ageSeconds,
    isQuiet: ageSeconds > READING_QUIET_AFTER_SECONDS,
  };
}

function findDecidingProbesByRole(
  config: ZoneRulesConfig,
  evaluation: RulesEvaluation | null,
): DecidingProbes[] {
  if (!evaluation) return [];
  const enabledRoles = config.enabledRoles ?? [];
  return enabledRoles.flatMap((role): DecidingProbes[] => {
    const climate = evaluation.climateByRole[role];
    const isDecidedByProbes =
      climate !== undefined && !evaluation.staleRoles.includes(role);
    if (!isDecidedByProbes) return [];
    const decision = evaluation.decisions.find(
      (candidate) => candidate.role === role,
    );
    return [selectDecidingProbes(role, config.rules[role], decision, climate)];
  });
}

function selectDecidingProbes(
  role: DeviceRole,
  rule: RoleRule | undefined,
  decision: DecisionOutcome | undefined,
  climate: ClimateSample,
): DecidingProbes {
  return wasDecidedOnCo2(rule, decision)
    ? { role, measurement: 'co2', probeKeys: climate.co2DecidingSensorIds }
    : {
        role,
        measurement: 'temperature',
        probeKeys: climate.decidingSensorIds,
      };
}

function wasDecidedOnCo2(
  rule: RoleRule | undefined,
  decision: DecisionOutcome | undefined,
): boolean {
  return (
    rule?.kind === 'co2-burner' &&
    decision !== undefined &&
    CO2_BURNER_REASONS_DECIDED_ON_CO2.includes(decision.reason)
  );
}

function mapControlledRolesToProbes(
  decidingProbesByRole: readonly DecidingProbes[],
): Map<string, string[]> {
  const controlledRolesByProbe = new Map<string, string[]>();
  for (const { role, probeKeys } of decidingProbesByRole) {
    for (const probeKey of probeKeys) {
      const controlledRoles = controlledRolesByProbe.get(probeKey) ?? [];
      controlledRolesByProbe.set(probeKey, [
        ...controlledRoles,
        labelRole(role),
      ]);
    }
  }
  return controlledRolesByProbe;
}

function describeControlTag(
  controlledRoles: string[],
  enabledRoleCount: number,
): string | null {
  if (controlledRoles.length === 0) return null;
  if (controlledRoles.length === enabledRoleCount) return 'controlling';
  return `controls ${controlledRoles.join(', ')}`;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
