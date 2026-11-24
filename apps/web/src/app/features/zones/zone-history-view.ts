import {
  sensorKey,
  ZONE_HISTORY_BUCKET_MINUTES,
  ZONE_HISTORY_HOURS,
  type Device,
  type DeviceRunHistory,
  type ProbeHistory,
  type Reading,
  type RelaySpan,
  type RelayState,
  type TemperatureBucket,
  type ZoneHistory,
  type ZoneHistoryReport,
} from '@tempestas/domain';
import {
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_HOUR,
  SECONDS_PER_MINUTE,
} from '../../shared/time';
import { formatDuration } from './zone-words';

export const PLOT_WIDTH = 1000;
export const PLOT_HEIGHT = 100;
export const LINE_STYLE_COUNT = 4;

const MILLISECONDS_PER_MINUTE = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_HOUR = MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE;
const WINDOW_MILLISECONDS = ZONE_HISTORY_HOURS * MILLISECONDS_PER_HOUR;
const BUCKET_MILLISECONDS =
  ZONE_HISTORY_BUCKET_MINUTES * MILLISECONDS_PER_MINUTE;
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

export interface HistoryLine {
  key: string;
  label: string;
  path: string;
  styleIndex: number;
  isDeciding: boolean;
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
}

export interface ZoneHistoryChartsInput {
  report: ZoneHistoryReport;
  zones: readonly HistoryZone[];
  /** Readings pushed over the socket since the page opened, any order. */
  pushedReadings: readonly Reading[];
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

interface Scale {
  topC: number;
  bottomC: number;
}

export function buildZoneHistoryCharts(
  input: ZoneHistoryChartsInput,
): Map<string, ZoneHistoryChart> {
  const window = { fromMs: input.now - WINDOW_MILLISECONDS, toMs: input.now };
  const fetchedToMs = Date.parse(input.report.to);
  const freshReadings = input.pushedReadings.filter(
    (reading) => Date.parse(reading.createdAt) > fetchedToMs,
  );
  const charts = new Map<string, ZoneHistoryChart>();
  for (const zone of input.zones) {
    const history = input.report.zones.find(
      (candidate) => candidate.zoneId === zone.zoneId,
    );
    if (!history) continue;
    const zoneReadings = freshReadings.filter(
      (reading) => input.zoneIdByNodeSlug.get(reading.nodeId) === zone.zoneId,
    );
    charts.set(
      zone.zoneId,
      buildZoneHistoryChart(zone, history, zoneReadings, input, window),
    );
  }
  return charts;
}

function buildZoneHistoryChart(
  zone: HistoryZone,
  history: ZoneHistory,
  freshReadings: readonly Reading[],
  input: ZoneHistoryChartsInput,
  window: TimeWindow,
): ZoneHistoryChart {
  const series = mergePushedReadings(history.probes, freshReadings)
    .map((probe) => keepBucketsInWindow(probe, window))
    .filter((probe) => probe.buckets.length > 0);
  const scale = chooseScale(series);
  const formatClock = buildClockFormatter(zone.timezone);
  const extremes = describeExtremes(series, formatClock);
  return {
    lines: buildLines(series, scale, window, zone.decidingProbeKeys),
    hasReadings: series.length > 0,
    topLabel: `${scale.topC} °C`,
    bottomLabel: `${scale.bottomC} °C`,
    extremes,
    screenReaderText: describeTemperatureChart(series.length, extremes),
    timeLabels: buildTimeLabels(window, formatClock),
    strips: history.devices.map((device) =>
      buildRunStrip(device, findPushedDevice(input, device), window),
    ),
  };
}

export function mergePushedReadings(
  probes: readonly ProbeHistory[],
  freshReadings: readonly Reading[],
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
  for (const reading of freshReadings) {
    const key = sensorKey(reading);
    const probe = probesByKey.get(key) ?? {
      nodeId: reading.nodeId,
      sensorId: reading.sensorId,
      bucketsByStart: new Map(),
    };
    addReadingToBuckets(probe.bucketsByStart, reading);
    probesByKey.set(key, probe);
  }
  return [...probesByKey.entries()]
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([key, probe]) => toProbeSeries(key, probe));
}

// Bucketed the way the server does, so a reading lands in the bucket the next fetch will put it in.
function addReadingToBuckets(
  bucketsByStart: Map<string, TemperatureBucket>,
  reading: Reading,
): void {
  const readingMs = Date.parse(reading.createdAt);
  const bucketStart = new Date(
    Math.floor(readingMs / BUCKET_MILLISECONDS) * BUCKET_MILLISECONDS,
  ).toISOString();
  const existing = bucketsByStart.get(bucketStart);
  bucketsByStart.set(
    bucketStart,
    existing
      ? combineWithReading(existing, reading)
      : toSingleReadingBucket(bucketStart, reading),
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

function toSingleReadingBucket(
  at: string,
  reading: Reading,
): TemperatureBucket {
  return {
    at,
    averageC: reading.temperature,
    lowestC: reading.temperature,
    highestC: reading.temperature,
    sampleCount: 1,
  };
}

function combineWithReading(
  bucket: TemperatureBucket,
  reading: Reading,
): TemperatureBucket {
  const sampleCount = bucket.sampleCount + 1;
  return {
    at: bucket.at,
    averageC:
      (bucket.averageC * bucket.sampleCount + reading.temperature) /
      sampleCount,
    lowestC: Math.min(bucket.lowestC, reading.temperature),
    highestC: Math.max(bucket.highestC, reading.temperature),
    sampleCount,
  };
}

function keepBucketsInWindow(
  series: ProbeSeries,
  window: TimeWindow,
): ProbeSeries {
  return {
    ...series,
    buckets: series.buckets.filter(
      (bucket) => Date.parse(bucket.at) + BUCKET_MILLISECONDS > window.fromMs,
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

function buildLines(
  series: readonly ProbeSeries[],
  scale: Scale,
  window: TimeWindow,
  decidingProbeKeys: readonly string[],
): HistoryLine[] {
  const hasSeveralNodes = new Set(series.map((probe) => probe.nodeId)).size > 1;
  return series.map((probe, index) => ({
    key: probe.key,
    label: hasSeveralNodes ? probe.key : probe.sensorId,
    path: buildLinePath(probe.buckets, scale, window),
    styleIndex: index % LINE_STYLE_COUNT,
    isDeciding: decidingProbeKeys.includes(probe.key),
  }));
}

export function buildLinePath(
  buckets: readonly TemperatureBucket[],
  scale: Scale,
  window: TimeWindow,
): string {
  const commands: string[] = [];
  buckets.forEach((bucket, index) => {
    const isAfterGap = isGapBetween(buckets[index - 1], bucket);
    const middleMs = Math.min(
      Math.max(Date.parse(bucket.at) + BUCKET_MILLISECONDS / 2, window.fromMs),
      window.toMs,
    );
    const x = roundCoordinate(toPlotX(middleMs, window));
    const y = roundCoordinate(toPlotY(bucket.averageC, scale));
    commands.push(`${isAfterGap ? 'M' : 'L'}${x} ${y}`);
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

function toPlotX(instantMs: number, window: TimeWindow): number {
  return (
    ((instantMs - window.fromMs) / (window.toMs - window.fromMs)) * PLOT_WIDTH
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
  extremes: string | null,
): string {
  if (probeCount === 0) return 'No temperature readings in the last 24 hours.';
  const probes = probeCount === 1 ? 'one probe' : `${probeCount} probes`;
  return `Temperature over the last 24 hours from ${probes}. ${extremes}.`;
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
  window: TimeWindow,
  formatClock: ClockFormatter,
): PositionedLabel[] {
  const labels: PositionedLabel[] = [];
  const firstStepMs =
    Math.ceil(window.fromMs / TIME_LABEL_STEP_MILLISECONDS) *
    TIME_LABEL_STEP_MILLISECONDS;
  for (
    let instantMs = firstStepMs;
    instantMs <= window.toMs;
    instantMs += TIME_LABEL_STEP_MILLISECONDS
  ) {
    const text = formatClock(instantMs);
    const atPercent = toPercent(instantMs - window.fromMs, window);
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
  window: TimeWindow,
): RunStrip {
  const stretches = clipToWindow(
    applyPushedSwitch(extendToNow(device.spans, window), pushedDevice, window),
    window,
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
      fromPercent: toPercent(stretch.fromMs - window.fromMs, window),
      widthPercent: toPercent(stretch.toMs - stretch.fromMs, window),
    })),
  };
}

// The last span holds until something changes, and a change refetches; until then it runs on to now.
function extendToNow(
  spans: readonly RelaySpan[],
  window: TimeWindow,
): Stretch[] {
  return spans.map((span, index) => ({
    state: span.state,
    fromMs: Date.parse(span.from),
    toMs:
      index === spans.length - 1
        ? Math.max(Date.parse(span.to), window.toMs)
        : Date.parse(span.to),
  }));
}

// A switch pushed before the refetch lands is drawn at once, from the moment the relay switched.
function applyPushedSwitch(
  stretches: Stretch[],
  pushedDevice: Device | null,
  window: TimeWindow,
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
    { state: pushedState, fromMs: switchedAtMs, toMs: window.toMs },
  ];
}

function clipToWindow(stretches: Stretch[], window: TimeWindow): Stretch[] {
  return stretches
    .map((stretch) => ({
      state: stretch.state,
      fromMs: Math.max(stretch.fromMs, window.fromMs),
      toMs: Math.min(stretch.toMs, window.toMs),
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

function toPercent(milliseconds: number, window: TimeWindow): number {
  const scale = 10 ** PERCENT_DECIMALS;
  return (
    Math.round(
      (milliseconds / (window.toMs - window.fromMs)) * FULL_PERCENT * scale,
    ) / scale
  );
}
