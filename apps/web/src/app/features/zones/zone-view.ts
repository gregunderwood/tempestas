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
  type RulesEvaluation,
  type SensorPolicy,
  type StalePolicy,
  type Zone,
  type ZoneFailure,
} from '@tempestas/domain';
import { READING_QUIET_AFTER_S } from '../../shared/freshness';

/**
 * The zones page as pure functions: what each zone's rules ARE, beside what
 * they are doing. Everything here takes `now` as an argument, so the specs can
 * pin time and the component owns the only clock.
 */

/**
 * Beyond this the last rules cycle is old enough that the card says so: six
 * missed ticks. A server that stopped evaluating (crashed loop, demoted to
 * follower) must not show its last decision as if it were current.
 */
export const EVALUATION_OLD_AFTER_S = 60;

// ------------------------------------------------------------- the bars

export type SegmentKind = 'on' | 'band' | 'off';

export interface BarSegment {
  kind: SegmentKind;
  /** Percent of the bar's width. */
  from: number;
  width: number;
}

export interface BarLabel {
  pct: number;
  text: string;
}

/**
 * One threshold rule drawn as a line: where it turns the load on, the dead band
 * where it holds whatever it was doing, where it turns it off, and where the
 * reading is now. The dead band is the part people ask about ("why didn't it
 * turn off at 2?"), so it is drawn rather than described.
 */
export interface ThresholdBar {
  caption: string;
  unit: string;
  segments: BarSegment[];
  labels: BarLabel[];
  /** The reading in words, for the caption row: "now 20.6 °C" or "no reading". */
  now: string;
  /**
   * Null when there is no reading to place. A reading outside the scale is
   * pinned to that edge and drawn as an arrow, rather than stretching the scale
   * until the thresholds - the part worth reading - are crushed into a corner.
   */
  marker: { pct: number; offScale: 'low' | 'high' | null } | null;
  /** The same picture as a sentence, for a screen reader. */
  description: string;
}

/** Threshold labels closer than this (percent of the bar) merge into one. */
const MERGE_LABELS_BELOW_PCT = 20;

export interface BarSpec {
  caption: string;
  unit: string;
  /** The load is on on the LOW side (heat, CO2) or the HIGH side (cool). */
  onSide: 'low' | 'high';
  onAt: number;
  offAt: number;
  value: number | null;
  /** Minimum padding either side, in the bar's unit. */
  minPad: number;
  decimals: number;
}

export function thresholdBar(spec: BarSpec): ThresholdBar {
  if (!Number.isFinite(spec.onAt) || !Number.isFinite(spec.offAt)) {
    throw new Error(`${spec.caption} thresholds are not numbers`);
  }
  const low = Math.min(spec.onAt, spec.offAt);
  const high = Math.max(spec.onAt, spec.offAt);
  // A fixed window around the thresholds: the scale never moves with the
  // reading, so the same rule always draws the same bar.
  const pad = Math.max(spec.minPad, (high - low) * 1.5);
  const min = low - pad;
  const max = high + pad;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  const [lowKind, highKind]: [SegmentKind, SegmentKind] =
    spec.onSide === 'low' ? ['on', 'off'] : ['off', 'on'];
  const segments: BarSegment[] = [
    { kind: lowKind, from: 0, width: pct(low) },
    { kind: 'band', from: pct(low), width: pct(high) - pct(low) },
    { kind: highKind, from: pct(high), width: 100 - pct(high) },
  ];

  const fmt = (v: number) => `${v.toFixed(spec.decimals)}${spec.unit}`;
  const onWord = spec.onSide === 'low' ? 'below' : 'above';
  const offWord = spec.onSide === 'low' ? 'above' : 'below';
  const now = spec.value === null ? 'no reading' : `now ${fmt(spec.value)}`;

  return {
    caption: spec.caption,
    unit: spec.unit,
    segments,
    labels:
      pct(high) - pct(low) < MERGE_LABELS_BELOW_PCT
        ? [
            {
              pct: (pct(low) + pct(high)) / 2,
              text: `${low.toFixed(spec.decimals)}–${fmt(high)}`,
            },
          ]
        : [
            { pct: pct(low), text: fmt(low) },
            { pct: pct(high), text: fmt(high) },
          ],
    now,
    marker:
      spec.value === null
        ? null
        : spec.value < min
          ? { pct: 0, offScale: 'low' }
          : spec.value > max
            ? { pct: 100, offScale: 'high' }
            : { pct: pct(spec.value), offScale: null },
    description:
      `${spec.caption}: on ${onWord} ${fmt(spec.onAt)}, ` +
      `off ${offWord} ${fmt(spec.offAt)}, holding in between; ${now}.`,
  };
}

/** The bars a rule draws, and the plain-words lines it needs beside them. */
export function barsForRule(
  rule: RoleRule,
  climate: ClimateSample | null,
): { bars: ThresholdBar[]; notes: string[] } {
  const temp = climate?.temperatureC ?? null;
  switch (rule.kind) {
    case 'thermostat':
    case 'daylight-thermostat':
      return {
        bars: [
          thresholdBar({
            caption: 'Temperature',
            unit: ' °C',
            onSide: rule.mode === 'heat' ? 'low' : 'high',
            onAt: rule.onAtC,
            offAt: rule.offAtC,
            value: temp,
            minPad: 3,
            decimals: 1,
          }),
        ],
        notes:
          rule.kind === 'daylight-thermostat'
            ? ['Only inside the daylight window; off outside it.']
            : [],
      };
    case 'co2-burner':
      return {
        bars: [
          thresholdBar({
            caption: 'CO₂ (day)',
            unit: ' ppm',
            onSide: 'low',
            onAt: rule.co2OnPpm,
            offAt: rule.co2OffPpm,
            value: climate?.co2Ppm ?? null,
            minPad: 300,
            decimals: 0,
          }),
        ],
        notes: [
          `Day: off at or above ${rule.dayOffAtC} °C, whatever the CO₂.`,
          `Night: a heater - on below ${rule.nightOnBelowC} °C, CO₂ ignored.`,
        ],
      };
    default:
      // The config is shown as stored; the engine is what validates it. A kind
      // this build does not know must not take the page down with it.
      throw new Error(
        `unknown rule kind "${String((rule as { kind?: unknown }).kind)}"`,
      );
  }
}

// ------------------------------------------------------------ the words

const ROLE_LABELS: Record<DeviceRole, string> = {
  heater: 'Heater',
  heat_tape: 'Heat tape',
  co2_generator: 'CO₂ generator',
  lights: 'Lights',
  exhaust_fan: 'Exhaust fan',
};

export function roleLabel(role: DeviceRole): string {
  return ROLE_LABELS[role] ?? role;
}

const REASONS: Record<RuleReason, string> = {
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

export function reasonText(reason: RuleReason): string {
  return REASONS[reason] ?? reason;
}

/**
 * How a decision reads at a glance. `warn` is for the ones a person should
 * look at: a role with no sensor, or one running on its stale policy.
 */
export type DecisionTone = 'on' | 'off' | 'hold' | 'warn' | 'idle';

export function decisionTone(decision: DecisionOutcome): DecisionTone {
  if (
    decision.reason === 'sensor-stale' ||
    decision.reason === 'stale-failsafe' ||
    decision.reason === 'no-sensor'
  ) {
    return 'warn';
  }
  if (decision.reason === 'role-not-owned') return 'idle';
  if (decision.desired === 'noop') return 'hold';
  return decision.desired;
}

export function decisionHeadline(decision: DecisionOutcome): string {
  const what =
    decision.desired === 'noop' ? 'hold' : decision.desired.toUpperCase();
  return `${what} · ${reasonText(decision.reason)}`;
}

const STALE: Record<StalePolicy, string> = {
  hold: 'hold last state',
  on: 'turn ON',
  off: 'turn off',
};

export function staleText(policy: StalePolicy): string {
  return `If its sensors go quiet: ${STALE[policy]}.`;
}

export function policyText(policy: SensorPolicy): string {
  const source = String(policy.source);
  const from =
    source === 'min'
      ? 'the coldest probe'
      : source === 'max'
        ? 'the warmest probe'
        : source === 'mean'
          ? 'the average of every probe'
          : source.startsWith('node:')
            ? `the probes on ${source.slice('node:'.length)}`
            : `${source.slice('sensor:'.length)} only`;
  const age =
    policy.maxAgeMs === undefined
      ? ''
      : ` · stale after ${formatDuration(policy.maxAgeMs / 1000)}`;
  return `Controls on ${from}${age}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60)
    return rest === 0 ? `${m} min` : `${m}:${String(rest).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

// ---------------------------------------------------------- the devices

export interface DeviceLine {
  id: string;
  name: string;
  nodeId: string;
  where: string;
  isOn: boolean;
  /** A manual override: the rule decides, but does not drive this device. */
  manual: boolean;
  /** Seconds until it may turn on again; null when it may now. */
  cooldownS: number | null;
  /** What the device did with the last decision, in words. */
  outcome: string | null;
  failed: boolean;
}

const OUTCOMES: Record<DeviceDispatch['outcome'], string> = {
  applied: 'switched by the rule',
  'already-in-state': 'where the rule wants it',
  cooldown: 'waiting out its minimum-off time',
  'rules-disabled': 'automation off for this device',
  failed: 'FAILED',
};

export function deviceLine(
  device: Device,
  dispatch: DeviceDispatch | undefined,
  now: number,
): DeviceLine {
  const until = device.canTurnOnAt
    ? new Date(device.canTurnOnAt).getTime()
    : null;
  const cooldownS =
    !device.isOn && until !== null && until > now
      ? Math.ceil((until - now) / 1000)
      : null;
  const failed = dispatch?.outcome === 'failed';
  return {
    id: device.id,
    name: device.name,
    nodeId: device.nodeId,
    where: `${device.nodeId} · BCM${device.gpio}`,
    isOn: device.isOn,
    manual: !device.rulesEnabled,
    cooldownS,
    outcome: dispatch
      ? OUTCOMES[dispatch.outcome] +
        (failed && dispatch.detail ? `: ${dispatch.detail}` : '')
      : null,
    failed,
  };
}

// ----------------------------------------------------------- the probes

export interface ProbeLine {
  key: string;
  label: string;
  temperatureC: number;
  ageS: number;
  quiet: boolean;
  /**
   * The owned roles whose decision this probe's value decided: the one picked
   * by `min`/`max`, or every contributor to `mean`, a node or a single sensor.
   */
  controls: string[];
  /** "controlling" when it decides every owned role, else which ones. */
  tag: string | null;
}

/** The sensor policy a role actually uses: its own override, else the zone's. */
function policyFor(
  rule: RoleRule | undefined,
  zone: Zone,
): SensorPolicy | null {
  return rule?.sensor ?? zone.rulesConfig.sensorPolicy?.default ?? null;
}

export function probeLines(
  zone: Zone,
  nodes: readonly Node[],
  readings: readonly Reading[],
  evaluation: RulesEvaluation | null,
  now: number,
): ProbeLine[] {
  const inZone = new Set(
    nodes.filter((n) => n.zoneId === zone.id).map((n) => n.slug),
  );
  const severalNodes = inZone.size > 1;

  const lines: ProbeLine[] = readings
    .filter((r) => inZone.has(r.nodeId))
    .map((r) => {
      const ageS = Math.max(
        0,
        Math.round((now - new Date(r.createdAt).getTime()) / 1000),
      );
      return {
        key: sensorKey(r),
        label: severalNodes ? sensorKey(r) : r.sensorId,
        temperatureC: r.temperature,
        ageS,
        quiet: ageS > READING_QUIET_AFTER_S,
        controls: [],
        tag: null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // Per role, because a role may override the zone's policy with its own
  // sensor: the zone default says nothing about which probe drives that role.
  const owned = (zone.rulesConfig.enabledRoles ?? []).filter(
    (role) => evaluation?.climateByRole[role],
  );
  for (const role of owned) {
    const climate = evaluation?.climateByRole[role] as ClimateSample;
    const sources = new Set(climate.sourceSensorIds);
    const contributors = lines.filter((l) => sources.has(l.key));
    const source = policyFor(zone.rulesConfig.rules?.[role], zone)?.source;
    let deciding = contributors;
    if (source === 'min' || source === 'max') {
      // The resolver says which probes took part, not which won, so the winner
      // is the contributor nearest the resolved value. Ties mark both.
      const distance = (l: ProbeLine) =>
        Math.abs(l.temperatureC - climate.temperatureC);
      const best = Math.min(...contributors.map(distance));
      deciding = contributors.filter((l) => distance(l) === best);
    }
    for (const l of deciding) l.controls.push(roleLabel(role));
  }
  for (const l of lines) {
    l.tag =
      l.controls.length === 0
        ? null
        : l.controls.length === owned.length
          ? 'controlling'
          : `controls ${l.controls.join(', ')}`;
  }
  return lines;
}

// ------------------------------------------------------------- the zone

export interface RuleRow {
  role: DeviceRole;
  label: string;
  /** In `enabledRoles`. A rule kept for a role another controller drives is shown, dimmed. */
  owned: boolean;
  bars: ThresholdBar[];
  notes: string[];
  stale: string;
  decision: { headline: string; tone: DecisionTone } | null;
  devices: DeviceLine[];
  /** This rule could not be drawn from its config; the rest of the zone still is. */
  problem: string | null;
}

export interface ZoneCard {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  localTime: string | null;
  /** Seconds since the last cycle evaluated this zone; null before the first. */
  evaluatedAgoS: number | null;
  /** The last evaluation is older than `EVALUATION_OLD_AFTER_S`. */
  evaluationOld: boolean;
  /** The rules engine refused this zone this cycle. */
  failure: string | null;
  /** Parts of the stored config this page could not draw. */
  problems: string[];
  policy: string;
  probes: ProbeLine[];
  /** Local minutes, for the daylight strip. */
  daylight: { start: number; end: number; now: number | null } | null;
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

/**
 * One card per zone, each built on its own: a hand-edited config that this
 * code cannot draw must cost that zone's card, never the page - the failure
 * alert on that very card is the thing a broken zone most needs shown.
 */
export function zoneCards(input: ZonesInput): ZoneCard[] {
  return input.zones.map((zone) => {
    const failure =
      input.failures.find((f) => f.zoneSlug === zone.slug)?.reason ?? null;
    try {
      return zoneCard(zone, failure, input);
    } catch (err: unknown) {
      return brokenCard(zone, failure, err);
    }
  });
}

function zoneCard(
  zone: Zone,
  failure: string | null,
  input: ZonesInput,
): ZoneCard {
  const config = zone.rulesConfig;
  // A zone that failed this cycle has no current evaluation, whatever an
  // earlier one said.
  const evaluation = failure
    ? null
    : (input.evaluations.find((e) => e.zoneId === zone.id) ?? null);
  const owned = new Set<DeviceRole>(config.enabledRoles ?? []);
  const problems: string[] = [];

  // Owned roles first, in config order, then the rules kept for other controllers.
  const roles = Object.keys(config.rules ?? {}) as DeviceRole[];
  roles.sort((a, b) => Number(owned.has(b)) - Number(owned.has(a)));

  const rules = roles.map((role) =>
    ruleRow(zone, role, owned.has(role), evaluation, input),
  );

  let daylight: ZoneCard['daylight'] = null;
  if (config.daylight) {
    const start = hhmm(config.daylight.start);
    const end = hhmm(config.daylight.end);
    if (start === null || end === null) {
      problems.push(
        `daylight window "${String(config.daylight.start)}"–"${String(config.daylight.end)}" is not HH:MM`,
      );
    } else {
      daylight = {
        start,
        end,
        now: evaluation?.minutesSinceMidnightLocal ?? null,
      };
    }
  }

  const evaluatedAgoS = evaluation
    ? Math.max(
        0,
        Math.round(
          (input.now - new Date(evaluation.evaluatedAt).getTime()) / 1000,
        ),
      )
    : null;

  return {
    id: zone.id,
    slug: zone.slug,
    name: zone.displayName,
    timezone: String(config.timezone ?? ''),
    localTime: evaluation?.localTime ?? null,
    evaluatedAgoS,
    evaluationOld:
      evaluatedAgoS !== null && evaluatedAgoS > EVALUATION_OLD_AFTER_S,
    failure,
    problems,
    policy: config.sensorPolicy?.default
      ? policyText(config.sensorPolicy.default)
      : 'No sensor policy',
    probes: probeLines(
      zone,
      input.nodes,
      input.readings,
      evaluation,
      input.now,
    ),
    daylight,
    rules,
    updatedAt: zone.updatedAt,
  };
}

function ruleRow(
  zone: Zone,
  role: DeviceRole,
  owned: boolean,
  evaluation: RulesEvaluation | null,
  input: ZonesInput,
): RuleRow {
  const decision = evaluation?.decisions.find((d) => d.role === role) ?? null;
  const devices = input.devices
    .filter((d) => d.zoneId === zone.id && d.role === role)
    .map((d) =>
      deviceLine(
        d,
        decision?.dispatched.find((x) => x.deviceId === d.id),
        input.now,
      ),
    );
  const base = {
    role,
    label: roleLabel(role),
    owned,
    decision: decision
      ? { headline: decisionHeadline(decision), tone: decisionTone(decision) }
      : null,
    devices,
  };

  try {
    const rule = zone.rulesConfig.rules[role] as RoleRule;
    // This role's own reading or none. Borrowing another role's would show a
    // healthy number for a probe that has stopped reporting.
    const climate = evaluation?.climateByRole[role] ?? null;
    const { bars, notes } = barsForRule(rule, climate);
    return {
      ...base,
      bars,
      notes,
      stale: staleText(rule.onStale),
      problem: null,
    };
  } catch (err: unknown) {
    return {
      ...base,
      bars: [],
      notes: [],
      stale: '',
      problem: `This rule cannot be drawn: ${messageOf(err)}.`,
    };
  }
}

/** The last resort: the card still exists, and still carries the failure. */
function brokenCard(
  zone: Zone,
  failure: string | null,
  err: unknown,
): ZoneCard {
  return {
    id: zone.id,
    slug: zone.slug,
    name: zone.displayName,
    timezone: '',
    localTime: null,
    evaluatedAgoS: null,
    evaluationOld: false,
    failure,
    problems: [`this zone's config cannot be drawn: ${messageOf(err)}`],
    policy: '',
    probes: [],
    daylight: null,
    rules: [],
    updatedAt: zone.updatedAt,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `HH:MM` to minutes since midnight, or null if it is not one. */
export function hhmm(value: unknown): number | null {
  const match =
    typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [h, m] = [Number(match[1]), Number(match[2])];
  return h < 24 && m < 60 ? h * 60 + m : null;
}
