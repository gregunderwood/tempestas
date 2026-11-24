import {
  sensorKey,
  type Device,
  type DeviceRunHistory,
  type ProbeHistory,
  type RelaySpan,
  type RelayState,
  type SensorSource,
  type TemperatureBucket,
  type ZoneHistory,
  type ZoneHistoryReport,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import {
  BUCKET_MILLISECONDS,
  bucketStartOf,
  combineBuckets,
  dropWhatTheFetchCovered,
  foldReadings,
  WINDOW_MILLISECONDS,
  type PushedProbe,
  type PushedReadings,
} from '../../core/pushed-readings';
import { MILLISECONDS_PER_SECOND, SECONDS_PER_MINUTE } from '../../shared/time';
import { formatDuration } from './zone-words';

export const PLOT_WIDTH = 1000;
export const PLOT_HEIGHT = 100;
export const LINE_STYLE_COUNT = 4;

const MILLISECONDS_PER_MINUTE = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
// More than this many empty buckets in a row is a gap in the readings, not a line to draw across.
const LONGEST_JOINED_GAP_BUCKETS = 3;
const SMALLEST_SCALE_DEGREES = 4;
const TIME_LABEL_EVERY_HOURS = 6;
const TIME_LABEL_STEP_MILLISECONDS = 30 * MILLISECONDS_PER_MINUTE;
// A label this close to an edge would hang off the card.
const TIME_LABEL_EDGE_PERCENT = 10;
const FULL_PERCENT = 100;
const PERCENT_DECIMALS = 3;
const COORDINATE_SCALE = 10;
const LONE_POINT_TICK = 'h4';
const NODE_SOURCE_PREFIX = 'node:';
const SENSOR_SOURCE_PREFIX = 'sensor:';
const AGGREGATE_LABELS = new Map<string, string>([
  ['mean', 'average'],
  ['min', 'coldest'],
  ['max', 'warmest'],
]);

export interface HistoryLine {
  key: string;
  label: string;
  path: string;
  styleIndex: number;
  isDeciding: boolean;
  /** The value the rules act on, worked out from several probes. */
  isControlling: boolean;
}

export interface PositionedLabel {
  text: string;
  atPercent: number;
}

export interface RunSegment {
  state: RelayState;
  fromPercent: number;
  widthPercent: number;
}

export interface RunStrip {
  deviceId: string;
  name: string;
  summary: string;
  screenReaderText: string;
  segments: RunSegment[];
}

export interface ZoneHistoryChart {
  lines: HistoryLine[];
  hasReadings: boolean;
  topLabel: string;
  bottomLabel: string;
  extremes: string | null;
  screenReaderText: string;
  timeLabels: PositionedLabel[];
  strips: RunStrip[];
}

export interface HistoryZone {
  zoneId: string;
  timezone: string;
  decidingProbeKeys: readonly string[];
  controllingSources: readonly SensorSource[];
}

export interface ZoneHistoryChartsInput {
  report: ZoneHistoryReport;
  zones: readonly HistoryZone[];
  /** Readings pushed over the socket, folded into buckets as they came. */
  pushedReadings: PushedReadings;
  zoneIdByNodeSlug: ReadonlyMap<string, string>;
  /** The newest push per device. */
  pushedDevices: readonly Device[];
  now: number;
}

interface TimeWindow {
  fromMs: number;
  toMs: number;
}

interface ProbeSeries {
  key: string;
  nodeId: string;
  sensorId: string;
  buckets: TemperatureBucket[];
}

interface ProbeBuckets {
  nodeId: string;
  sensorId: string;
  bucketsByStart: Map<string, TemperatureBucket>;
}

interface Stretch {
  state: RelayState;
  fromMs: number;
  toMs: number;
}

interface ControllingLine {
  line: HistoryLine;
  probeKeys: readonly string[];
}

interface Scale {
  topC: number;
  bottomC: number;
}

export function buildZoneHistoryCharts(
  input: ZoneHistoryChartsInput,
): Map<string, ZoneHistoryChart> {
  const timeWindow = {
    fromMs: input.now - WINDOW_MILLISECONDS,
    toMs: input.now,
  };
  const freshProbes = [
    ...dropWhatTheFetchCovered(input.pushedReadings, input.report.to).values(),
  ];
  const charts = new Map<string, ZoneHistoryChart>();
  for (const zone of input.zones) {
    const history = input.report.zones.find(
      (candidate) => candidate.zoneId === zone.zoneId,
    );
    if (!history) continue;
    const zoneProbes = freshProbes.filter(
      (probe) => input.zoneIdByNodeSlug.get(probe.nodeId) === zone.zoneId,
    );
    charts.set(
      zone.zoneId,
      buildZoneHistoryChart(zone, history, zoneProbes, input, timeWindow),
    );
  }
  return charts;
}

function buildZoneHistoryChart(
  zone: HistoryZone,
  history: ZoneHistory,
  pushedProbes: readonly PushedProbe[],
  input: ZoneHistoryChartsInput,
  timeWindow: TimeWindow,
): ZoneHistoryChart {
  const series = mergePushedReadings(history.probes, pushedProbes)
    .map((probe) => keepBucketsInWindow(probe, timeWindow))
    .filter((probe) => probe.buckets.length > 0);
  const scale = chooseScale(series);
  const formatClock = buildClockFormatter(zone.timezone);
  const extremes = describeExtremes(series, formatClock);
  const controllingLines = buildControllingLines(
    series,
    zone.controllingSources,
    scale,
    timeWindow,
  );
  const aggregatedProbeKeys = new Set(
    controllingLines.flatMap((controlling) => controlling.probeKeys),
  );
  const decidingProbeKeys = zone.decidingProbeKeys.filter(
    (key) => !aggregatedProbeKeys.has(key),
  );
  return {
    lines: [
      ...buildProbeLines(series, scale, timeWindow, decidingProbeKeys),
      ...controllingLines.map((controlling) => controlling.line),
    ],
    hasReadings: series.length > 0,
    topLabel: `${scale.topC} °C`,
    bottomLabel: `${scale.bottomC} °C`,
    extremes,
    screenReaderText: describeTemperatureChart(
      series.length,
      controllingLines.map((controlling) => controlling.line.label),
      extremes,
    ),
    timeLabels: buildTimeLabels(timeWindow, formatClock),
    strips: history.devices.map((device) =>
      buildRunStrip(device, findPushedDevice(input, device), timeWindow),
    ),
  };
}

export function mergePushedReadings(
  probes: readonly ProbeHistory[],
  pushedProbes: readonly PushedProbe[],
): ProbeSeries[] {
  const probesByKey = new Map<string, ProbeBuckets>(
    probes.map((probe) => [
      sensorKey(probe),
      {
        nodeId: probe.nodeId,
        sensorId: probe.sensorId,
        bucketsByStart: new Map(
          probe.buckets.map((bucket) => [bucket.at, bucket]),
        ),
      },
    ]),
  );
  for (const pushed of pushedProbes) {
    const key = sensorKey(pushed);
    const probe = probesByKey.get(key) ?? {
      nodeId: pushed.nodeId,
      sensorId: pushed.sensorId,
      bucketsByStart: new Map(),
    };
    for (const bucket of toPushedBuckets(pushed)) {
      addBucket(probe.bucketsByStart, bucket);
    }
    probesByKey.set(key, probe);
  }
  return [...probesByKey.entries()]
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([key, probe]) => toProbeSeries(key, probe));
}

function toPushedBuckets(pushed: PushedProbe): TemperatureBucket[] {
  const [firstOpenReading] = pushed.openReadings;
  if (!firstOpenReading) return [...pushed.closedBuckets];
  const openBucketStart = bucketStartOf(Date.parse(firstOpenReading.createdAt));
  return [
    ...pushed.closedBuckets,
    foldReadings(openBucketStart, pushed.openReadings),
  ];
}

// Bucketed the way the server does, so pushed readings join the bucket the fetch started.
function addBucket(
  bucketsByStart: Map<string, TemperatureBucket>,
  bucket: TemperatureBucket,
): void {
  const existing = bucketsByStart.get(bucket.at);
  bucketsByStart.set(
    bucket.at,
    existing ? combineBuckets(existing, bucket) : bucket,
  );
}

function toProbeSeries(key: string, probe: ProbeBuckets): ProbeSeries {
  return {
    key,
    nodeId: probe.nodeId,
    sensorId: probe.sensorId,
    buckets: [...probe.bucketsByStart.values()].sort((first, second) =>
      first.at.localeCompare(second.at),
    ),
  };
}

function keepBucketsInWindow(
  series: ProbeSeries,
  timeWindow: TimeWindow,
): ProbeSeries {
  return {
    ...series,
    buckets: series.buckets.filter(
      (bucket) =>
        Date.parse(bucket.at) + BUCKET_MILLISECONDS > timeWindow.fromMs,
    ),
  };
}

// Whole degrees, at least a few apart, so a steady night is not drawn as a jagged one.
function chooseScale(series: readonly ProbeSeries[]): Scale {
  const buckets = series.flatMap((probe) => probe.buckets);
  if (buckets.length === 0) return { topC: SMALLEST_SCALE_DEGREES, bottomC: 0 };
  const lowestC = Math.floor(findColdestBucket(buckets).lowestC);
  const highestC = Math.ceil(findWarmestBucket(buckets).highestC);
  const shortfall = SMALLEST_SCALE_DEGREES - (highestC - lowestC);
  if (shortfall <= 0) return { topC: highestC, bottomC: lowestC };
  const bottomC = lowestC - Math.floor(shortfall / 2);
  return { topC: bottomC + SMALLEST_SCALE_DEGREES, bottomC };
}

function findColdestBucket(
  buckets: readonly TemperatureBucket[],
): TemperatureBucket {
  return buckets.reduce((coldest, bucket) =>
    bucket.lowestC < coldest.lowestC ? bucket : coldest,
  );
}

function findWarmestBucket(
  buckets: readonly TemperatureBucket[],
): TemperatureBucket {
  return buckets.reduce((warmest, bucket) =>
    bucket.highestC > warmest.highestC ? bucket : warmest,
  );
}

// The rules' sources, each once; a single-sensor source is its probe's own line, so it is left out.
export function findControllingSources(
  config: ZoneRulesConfig,
): SensorSource[] {
  const enabledRoles = Array.isArray(config.enabledRoles)
    ? config.enabledRoles
    : [];
  const sources = enabledRoles.flatMap((role) => {
    const source =
      config.rules?.[role]?.sensor?.source ??
      config.sensorPolicy?.default?.source;
    return source ? [source] : [];
  });
  return [...new Set(sources)].filter(
    (source) => !source.startsWith(SENSOR_SOURCE_PREFIX),
  );
}

function buildControllingLines(
  series: readonly ProbeSeries[],
  sources: readonly SensorSource[],
  scale: Scale,
  timeWindow: TimeWindow,
): ControllingLine[] {
  return sources.flatMap((source): ControllingLine[] => {
    const selected = selectSourceProbes(series, source);
    if (selected.length < 2) return [];
    return [
      {
        line: {
          key: `controlling:${source}`,
          label: labelControllingSource(source),
          path: buildLinePath(
            aggregateBuckets(selected, source),
            scale,
            timeWindow,
          ),
          styleIndex: 0,
          isDeciding: true,
          isControlling: true,
        },
        probeKeys: selected.map((probe) => probe.key),
      },
    ];
  });
}

function selectSourceProbes(
  series: readonly ProbeSeries[],
  source: SensorSource,
): ProbeSeries[] {
  if (!source.startsWith(NODE_SOURCE_PREFIX)) return [...series];
  const nodeSlug = source.slice(NODE_SOURCE_PREFIX.length);
  return series.filter((probe) => probe.nodeId === nodeSlug);
}

function labelControllingSource(source: SensorSource): string {
  return (
    AGGREGATE_LABELS.get(source) ??
    `average on ${source.slice(NODE_SOURCE_PREFIX.length)}`
  );
}

// Worked out the way the rules do, over whichever probes reported in each bucket.
function aggregateBuckets(
  selected: readonly ProbeSeries[],
  source: SensorSource,
): TemperatureBucket[] {
  const averagesByStart = new Map<string, number[]>();
  for (const bucket of selected.flatMap((probe) => probe.buckets)) {
    const averages = averagesByStart.get(bucket.at) ?? [];
    averages.push(bucket.averageC);
    averagesByStart.set(bucket.at, averages);
  }
  return [...averagesByStart.entries()]
    .sort(([firstStart], [secondStart]) =>
      firstStart.localeCompare(secondStart),
    )
    .map(([at, averages]) => {
      const pickedC = pickBySource(averages, source);
      return {
        at,
        averageC: pickedC,
        lowestC: pickedC,
        highestC: pickedC,
        sampleCount: averages.length,
      };
    });
}

function pickBySource(values: readonly number[], source: SensorSource): number {
  if (source === 'min') return Math.min(...values);
  if (source === 'max') return Math.max(...values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildProbeLines(
  series: readonly ProbeSeries[],
  scale: Scale,
  timeWindow: TimeWindow,
  decidingProbeKeys: readonly string[],
): HistoryLine[] {
  const hasSeveralNodes = new Set(series.map((probe) => probe.nodeId)).size > 1;
  return series.map((probe, index) => ({
    key: probe.key,
    label: hasSeveralNodes ? probe.key : probe.sensorId,
    path: buildLinePath(probe.buckets, scale, timeWindow),
    styleIndex: index % LINE_STYLE_COUNT,
    isDeciding: decidingProbeKeys.includes(probe.key),
    isControlling: false,
  }));
}

export function buildLinePath(
  buckets: readonly TemperatureBucket[],
  scale: Scale,
  timeWindow: TimeWindow,
): string {
  const commands: string[] = [];
  buckets.forEach((bucket, index) => {
    const isAfterGap = isGapBetween(buckets[index - 1], bucket);
    const middleMs = Math.min(
      Math.max(
        Date.parse(bucket.at) + BUCKET_MILLISECONDS / 2,
        timeWindow.fromMs,
      ),
      timeWindow.toMs,
    );
    const plotX = roundCoordinate(toPlotX(middleMs, timeWindow));
    const plotY = roundCoordinate(toPlotY(bucket.averageC, scale));
    commands.push(`${isAfterGap ? 'M' : 'L'}${plotX} ${plotY}`);
    // A lone point draws nothing, so it gets a short tick to stay visible.
    if (isAfterGap && isGapBetween(bucket, buckets[index + 1])) {
      commands.push(LONE_POINT_TICK);
    }
  });
  return commands.join(' ');
}

function isGapBetween(
  earlier: TemperatureBucket | undefined,
  later: TemperatureBucket | undefined,
): boolean {
  if (!earlier || !later) return true;
  const apartMs = Date.parse(later.at) - Date.parse(earlier.at);
  return apartMs > LONGEST_JOINED_GAP_BUCKETS * BUCKET_MILLISECONDS;
}

function toPlotX(instantMs: number, timeWindow: TimeWindow): number {
  return (
    ((instantMs - timeWindow.fromMs) / (timeWindow.toMs - timeWindow.fromMs)) *
    PLOT_WIDTH
  );
}

function toPlotY(temperatureC: number, scale: Scale): number {
  return (
    ((scale.topC - temperatureC) / (scale.topC - scale.bottomC)) * PLOT_HEIGHT
  );
}

function roundCoordinate(value: number): number {
  return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
}

function describeExtremes(
  series: readonly ProbeSeries[],
  formatClock: ClockFormatter,
): string | null {
  const buckets = series.flatMap((probe) => probe.buckets);
  if (buckets.length === 0) return null;
  const coldest = findColdestBucket(buckets);
  const warmest = findWarmestBucket(buckets);
  return (
    `Low ${formatTemperature(coldest.lowestC)} near ${formatClock(Date.parse(coldest.at))} · ` +
    `high ${formatTemperature(warmest.highestC)} near ${formatClock(Date.parse(warmest.at))}`
  );
}

function formatTemperature(temperatureC: number): string {
  return `${temperatureC.toFixed(1)} °C`;
}

function describeTemperatureChart(
  probeCount: number,
  controllingLabels: readonly string[],
  extremes: string | null,
): string {
  if (probeCount === 0) return 'No temperature readings in the last 24 hours.';
  const probes = probeCount === 1 ? 'one probe' : `${probeCount} probes`;
  const controlling =
    controllingLabels.length === 0
      ? ''
      : `, with the ${controllingLabels.join(' and the ')} the rules act on`;
  return `Temperature over the last 24 hours from ${probes}${controlling}. ${extremes}.`;
}

type ClockFormatter = (instantMs: number) => string;

// A zone whose timezone the browser does not know falls back to UTC and says so.
function buildClockFormatter(timezone: string): ClockFormatter {
  const formatter = createHourMinuteFormat(timezone);
  if (formatter) return (instantMs) => formatter.format(instantMs);
  const utcFormatter = createHourMinuteFormat('UTC') as Intl.DateTimeFormat;
  return (instantMs) => `${utcFormatter.format(instantMs)} UTC`;
}

function createHourMinuteFormat(timezone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    });
  } catch {
    return null;
  }
}

// Whole local hours a quarter-day apart, found by stepping half-hours so a half-hour zone still lands on them.
export function buildTimeLabels(
  timeWindow: TimeWindow,
  formatClock: ClockFormatter,
): PositionedLabel[] {
  const labels: PositionedLabel[] = [];
  const firstStepMs =
    Math.ceil(timeWindow.fromMs / TIME_LABEL_STEP_MILLISECONDS) *
    TIME_LABEL_STEP_MILLISECONDS;
  for (
    let instantMs = firstStepMs;
    instantMs <= timeWindow.toMs;
    instantMs += TIME_LABEL_STEP_MILLISECONDS
  ) {
    const text = formatClock(instantMs);
    const atPercent = toPercent(instantMs - timeWindow.fromMs, timeWindow);
    if (isQuarterDayLabel(text) && isAwayFromEdges(atPercent)) {
      labels.push({ text, atPercent });
    }
  }
  return labels;
}

function isQuarterDayLabel(clockText: string): boolean {
  const [hours, minutes] = clockText
    .split(':')
    .map((part) => parseInt(part, 10));
  return minutes === 0 && hours % TIME_LABEL_EVERY_HOURS === 0;
}

function isAwayFromEdges(atPercent: number): boolean {
  return (
    atPercent >= TIME_LABEL_EDGE_PERCENT &&
    atPercent <= FULL_PERCENT - TIME_LABEL_EDGE_PERCENT
  );
}

function findPushedDevice(
  input: ZoneHistoryChartsInput,
  device: DeviceRunHistory,
): Device | null {
  return (
    input.pushedDevices.find((pushed) => pushed.id === device.deviceId) ?? null
  );
}

export function buildRunStrip(
  device: DeviceRunHistory,
  pushedDevice: Device | null,
  timeWindow: TimeWindow,
): RunStrip {
  const stretches = clipToWindow(
    applyPushedSwitch(
      extendToNow(device.spans, timeWindow),
      pushedDevice,
      timeWindow,
    ),
    timeWindow,
  );
  const onMs = sumStateMs(stretches, 'on');
  const unknownMs = sumStateMs(stretches, 'unknown');
  const starts = countStarts(stretches);
  return {
    deviceId: device.deviceId,
    name: device.deviceName,
    summary: describeRuns(onMs, starts, unknownMs),
    screenReaderText: `${device.deviceName}, last 24 hours: ${describeRuns(onMs, starts, unknownMs)}.`,
    segments: stretches.map((stretch) => ({
      state: stretch.state,
      fromPercent: toPercent(stretch.fromMs - timeWindow.fromMs, timeWindow),
      widthPercent: toPercent(stretch.toMs - stretch.fromMs, timeWindow),
    })),
  };
}

// The last span holds until something changes, and a change refetches; until then it runs on to now.
function extendToNow(
  spans: readonly RelaySpan[],
  timeWindow: TimeWindow,
): Stretch[] {
  return spans.map((span, index) => ({
    state: span.state,
    fromMs: Date.parse(span.from),
    toMs:
      index === spans.length - 1
        ? Math.max(Date.parse(span.to), timeWindow.toMs)
        : Date.parse(span.to),
  }));
}

// A switch pushed before the refetch lands is drawn at once, from the moment the relay switched.
function applyPushedSwitch(
  stretches: Stretch[],
  pushedDevice: Device | null,
  timeWindow: TimeWindow,
): Stretch[] {
  const last = stretches[stretches.length - 1];
  const switchedAt = pushedDevice?.isOn
    ? pushedDevice.onAt
    : pushedDevice?.offAt;
  if (!last || !pushedDevice || !switchedAt) return stretches;
  const pushedState: RelayState = pushedDevice.isOn ? 'on' : 'off';
  const switchedAtMs = Date.parse(switchedAt);
  const isNewerThanHistory =
    switchedAtMs > last.fromMs && last.state !== pushedState;
  if (!isNewerThanHistory) return stretches;
  return [
    ...stretches.slice(0, -1),
    { ...last, toMs: switchedAtMs },
    { state: pushedState, fromMs: switchedAtMs, toMs: timeWindow.toMs },
  ];
}

function clipToWindow(stretches: Stretch[], timeWindow: TimeWindow): Stretch[] {
  return stretches
    .map((stretch) => ({
      state: stretch.state,
      fromMs: Math.max(stretch.fromMs, timeWindow.fromMs),
      toMs: Math.min(stretch.toMs, timeWindow.toMs),
    }))
    .filter((stretch) => stretch.toMs > stretch.fromMs);
}

function sumStateMs(stretches: readonly Stretch[], state: RelayState): number {
  return stretches
    .filter((stretch) => stretch.state === state)
    .reduce((total, stretch) => total + stretch.toMs - stretch.fromMs, 0);
}

// A start follows a known off; a node reappearing with the relay on is not one.
function countStarts(stretches: readonly Stretch[]): number {
  return stretches.filter(
    (stretch, index) =>
      stretch.state === 'on' && stretches[index - 1]?.state === 'off',
  ).length;
}

function describeRuns(onMs: number, starts: number, unknownMs: number): string {
  const parts = [
    onMs === 0 ? 'never on' : `on ${formatMilliseconds(onMs)}`,
    `${starts} ${starts === 1 ? 'start' : 'starts'}`,
  ];
  if (unknownMs > 0) parts.push(`unknown ${formatMilliseconds(unknownMs)}`);
  return parts.join(' · ');
}

function formatMilliseconds(milliseconds: number): string {
  return formatDuration(milliseconds / MILLISECONDS_PER_SECOND);
}

function toPercent(milliseconds: number, timeWindow: TimeWindow): number {
  const scale = 10 ** PERCENT_DECIMALS;
  return (
    Math.round(
      (milliseconds / (timeWindow.toMs - timeWindow.fromMs)) *
        FULL_PERCENT *
        scale,
    ) / scale
  );
}
