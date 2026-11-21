import {
  GAUGE_METRICS,
  gaugeColorFor,
  sensorKey,
  type Device,
  type MetricKey,
  type Node,
  type Reading,
} from '@tempestas/domain';
import { READING_QUIET_AFTER_SECONDS } from '../../shared/freshness';
import { metricsFor } from '../../shared/metrics';
import { secondsSince } from '../../shared/time';
import { formatDuration } from '../zones/zone-words';
import type { PeriodStart } from './period-start';
import { UNKNOWN_VALUE } from './system-summary';

const PERCENT = 100;

const PERIOD_START_PHRASES: Record<PeriodStart['kind'], string> = {
  day: 'since the day began',
  night: 'since night fell',
};

const SAME_DAY_CLOCK_FORMAT = 'HH:mm';
const OTHER_DAY_CLOCK_FORMAT = 'MMM d, HH:mm';

export interface RelayLine {
  id: string;
  name: string;
  isOn: boolean;
  onAt: string | null;
  onAtFormat: string;
}

export interface MetricStat {
  key: string;
  label: string;
  sensorCaption: string | null;
  value: string;
  unit: string;
  trend: string;
  rangePercent: number | null;
  band: string | null;
}

export interface NodeStatCard {
  nodeId: string;
  title: string;
  metrics: MetricStat[];
  age: string;
  isQuiet: boolean;
  relays: RelayLine[];
}

export interface NodeStatFacts {
  readings: readonly Reading[];
  nodes: readonly Node[];
  devices: readonly Device[];
  periodStarts: ReadonlyMap<string, PeriodStart>;
  now: number;
}

export function buildNodeStatCards(facts: NodeStatFacts): NodeStatCard[] {
  const readingsByNode = groupByNode(facts.readings);
  return [...readingsByNode.entries()]
    .sort(([firstNodeId], [secondNodeId]) =>
      firstNodeId.localeCompare(secondNodeId),
    )
    .map(([nodeId, readings]) => buildNodeStatCard(nodeId, readings, facts));
}

function buildNodeStatCard(
  nodeId: string,
  readings: readonly Reading[],
  facts: NodeStatFacts,
): NodeStatCard {
  const node = facts.nodes.find((candidate) => candidate.slug === nodeId);
  const hasSeveralSensors = readings.length > 1;
  const quietSensors = readings.filter((reading) =>
    isQuiet(reading, facts.now),
  );
  return {
    nodeId,
    title: node?.displayName ?? nodeId,
    metrics: readings.flatMap((reading) =>
      metricsFor(reading, node).map((metric) =>
        buildMetricStat(
          reading,
          metric,
          hasSeveralSensors,
          facts.periodStarts.get(nodeId),
        ),
      ),
    ),
    age: describeAge(readings, quietSensors, hasSeveralSensors, facts.now),
    isQuiet: quietSensors.length > 0,
    relays: facts.devices
      .filter((device) => device.nodeId === nodeId)
      .map((device) => describeRelay(device, facts.now)),
  };
}

function buildMetricStat(
  reading: Reading,
  metricKey: MetricKey,
  hasSeveralSensors: boolean,
  periodStart: PeriodStart | undefined,
): MetricStat {
  const metric = GAUGE_METRICS[metricKey];
  const value = reading[metricKey];
  const startValue =
    periodStart?.readingsBySensor.get(reading.sensorId)?.[metricKey] ?? null;
  return {
    key: `${sensorKey(reading)}:${metricKey}`,
    label: metric.label,
    sensorCaption: hasSeveralSensors ? reading.sensorId : null,
    value: value === null ? UNKNOWN_VALUE : value.toFixed(metric.decimals),
    unit: metric.unit,
    trend: describeTrend(value, startValue, metric.decimals, periodStart),
    rangePercent: value === null ? null : placeInRange(value, metric),
    band: gaugeColorFor(metric, value),
  };
}

export function describeTrend(
  value: number | null,
  startValue: number | null,
  decimals: number,
  periodStart: PeriodStart | undefined,
): string {
  if (value === null || startValue === null || !periodStart) {
    return UNKNOWN_VALUE;
  }
  const change = Number((value - startValue).toFixed(decimals));
  const since = PERIOD_START_PHRASES[periodStart.kind];
  if (change === 0) return `no change ${since}`;
  const arrow = change > 0 ? '▲' : '▼';
  const sign = change > 0 ? '+' : '−';
  return `${arrow} ${sign}${Math.abs(change).toFixed(decimals)} ${since}`;
}

function placeInRange(
  value: number,
  metric: { min: number; max: number },
): number {
  const fraction = (value - metric.min) / (metric.max - metric.min);
  return Math.round(Math.min(1, Math.max(0, fraction)) * PERCENT);
}

function describeAge(
  readings: readonly Reading[],
  quietSensors: readonly Reading[],
  hasSeveralSensors: boolean,
  now: number,
): string {
  if (quietSensors.length > 0) {
    return quietSensors
      .map((reading) => {
        const quietFor = formatDuration(secondsSince(reading.createdAt, now));
        const sensor = hasSeveralSensors ? `${reading.sensorId}: ` : '';
        return `${sensor}no reading for ${quietFor}`;
      })
      .join(' · ');
  }
  const newestAgeSeconds = Math.min(
    ...readings.map((reading) => secondsSince(reading.createdAt, now)),
  );
  return `Read ${formatDuration(newestAgeSeconds)} ago`;
}

function isQuiet(reading: Reading, now: number): boolean {
  return secondsSince(reading.createdAt, now) > READING_QUIET_AFTER_SECONDS;
}

function groupByNode(readings: readonly Reading[]): Map<string, Reading[]> {
  const readingsByNode = new Map<string, Reading[]>();
  const bySensor = [...readings].sort((first, second) =>
    first.sensorId.localeCompare(second.sensorId),
  );
  for (const reading of bySensor) {
    readingsByNode.set(reading.nodeId, [
      ...(readingsByNode.get(reading.nodeId) ?? []),
      reading,
    ]);
  }
  return readingsByNode;
}

// A relay on since yesterday says so, rather than reading as on since earlier today.
function describeRelay(device: Device, now: number): RelayLine {
  const onAt = device.onAt;
  const isToday =
    onAt !== null &&
    new Date(onAt).toDateString() === new Date(now).toDateString();
  return {
    id: device.id,
    name: device.name,
    isOn: device.isOn,
    onAt,
    onAtFormat: isToday ? SAME_DAY_CLOCK_FORMAT : OTHER_DAY_CLOCK_FORMAT,
  };
}
