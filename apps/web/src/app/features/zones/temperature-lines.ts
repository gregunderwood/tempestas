import {
  sensorKey,
  type ProbeHistory,
  type SensorSource,
  type TemperatureBucket,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import {
  BUCKET_MILLISECONDS,
  bucketStartOf,
  combineBuckets,
  foldReadings,
  type PushedProbe,
} from '../../core/pushed-readings';
import type { ClockFormatter, TimeWindow } from './time-axis';
import { readNodeSlug, readSingleSensorKey } from './zone-words';

export const PLOT_WIDTH = 1000;
export const PLOT_HEIGHT = 100;
export const LINE_STYLE_COUNT = 4;
export const NO_TEMPERATURE_READINGS =
  'No temperature readings in the last 24 hours.';

const SOLID_LINE_STYLE = 0;
const LONGEST_JOINED_GAP_BUCKETS = 3;
const SMALLEST_SCALE_DEGREES = 4;
const FEWEST_PROBES_FOR_AGGREGATE_LINE = 2;
const COORDINATE_SCALE = 10;
const LONE_POINT_TICK = 'h4';
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
  isControlling: boolean;
}

export interface TemperatureChart {
  lines: HistoryLine[];
  hasReadings: boolean;
  topLabel: string;
  bottomLabel: string;
  extremes: string | null;
  screenReaderText: string;
}

export interface TemperatureZone {
  decidingProbeKeys: readonly string[];
  controllingSources: readonly SensorSource[];
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

interface ControllingLine {
  line: HistoryLine;
  probeKeys: readonly string[];
}

interface Scale {
  topC: number;
  bottomC: number;
}

export function buildTemperatureChart(
  zone: TemperatureZone,
  probes: readonly ProbeHistory[],
  pushedProbes: readonly PushedProbe[],
  timeWindow: TimeWindow,
  formatClock: ClockFormatter,
): TemperatureChart {
  const series = mergePushedReadings(probes, pushedProbes)
    .map((probe) => keepBucketsInWindow(probe, timeWindow))
    .filter((probe) => probe.buckets.length > 0);
  const scale = chooseScale(series);
  const extremes = describeExtremes(series, formatClock);
  const controllingLines = buildControllingLines(
    series,
    zone.controllingSources,
    scale,
    timeWindow,
  );
  const decidingProbeKeys = findProbesDrawnAsDeciding(zone, controllingLines);
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
  };
}

export function findControllingSources(
  config: ZoneRulesConfig,
): SensorSource[] {
  const sources = config.enabledRoles.map(
    (role) =>
      config.rules[role]?.sensor?.source ?? config.sensorPolicy.default.source,
  );
  return [...new Set(sources)];
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

function findProbesDrawnAsDeciding(
  zone: TemperatureZone,
  controllingLines: readonly ControllingLine[],
): string[] {
  const probesReadAlone = new Set(
    zone.controllingSources
      .map(readSingleSensorKey)
      .filter((probeKey): probeKey is string => probeKey !== null),
  );
  const probesInAggregateLines = new Set(
    controllingLines.flatMap((controlling) => controlling.probeKeys),
  );
  return zone.decidingProbeKeys.filter(
    (probeKey) =>
      probesReadAlone.has(probeKey) || !probesInAggregateLines.has(probeKey),
  );
}

function buildControllingLines(
  series: readonly ProbeSeries[],
  sources: readonly SensorSource[],
  scale: Scale,
  timeWindow: TimeWindow,
): ControllingLine[] {
  return sources.flatMap((source): ControllingLine[] => {
    if (readSingleSensorKey(source) !== null) return [];
    const selected = selectSourceProbes(series, source);
    if (selected.length < FEWEST_PROBES_FOR_AGGREGATE_LINE) return [];
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
          styleIndex: SOLID_LINE_STYLE,
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
  const nodeSlug = readNodeSlug(source);
  if (nodeSlug === null) return [...series];
  return series.filter((probe) => probe.nodeId === nodeSlug);
}

function labelControllingSource(source: SensorSource): string {
  return (
    AGGREGATE_LABELS.get(source) ??
    `average on ${readNodeSlug(source) ?? source}`
  );
}

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
      const pickedC = pickLikeTheRules(averages, source);
      return {
        at,
        averageC: pickedC,
        lowestC: pickedC,
        highestC: pickedC,
        sampleCount: averages.length,
      };
    });
}

function pickLikeTheRules(
  values: readonly number[],
  source: SensorSource,
): number {
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
    const previous = buckets[index - 1];
    const middleMs = Math.min(
      Math.max(
        Date.parse(bucket.at) + BUCKET_MILLISECONDS / 2,
        timeWindow.fromMs,
      ),
      timeWindow.toMs,
    );
    const plotX = roundCoordinate(toPlotX(middleMs, timeWindow));
    const plotY = roundCoordinate(toPlotY(bucket.averageC, scale));
    commands.push(
      `${isGapBetween(previous, bucket) ? 'M' : 'L'}${plotX} ${plotY}`,
    );
    if (isLonePoint(previous, bucket, buckets[index + 1])) {
      commands.push(LONE_POINT_TICK);
    }
  });
  return commands.join(' ');
}

function isLonePoint(
  previous: TemperatureBucket | undefined,
  bucket: TemperatureBucket,
  next: TemperatureBucket | undefined,
): boolean {
  return isGapBetween(previous, bucket) && isGapBetween(bucket, next);
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
  if (probeCount === 0) return NO_TEMPERATURE_READINGS;
  const probes = probeCount === 1 ? 'one probe' : `${probeCount} probes`;
  const controlling =
    controllingLabels.length === 0
      ? ''
      : `, with the ${controllingLabels.join(' and the ')} the rules act on`;
  return `Temperature over the last 24 hours from ${probes}${controlling}. ${extremes}.`;
}
