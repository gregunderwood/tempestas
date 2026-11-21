import type { MetricKey, Node, Reading } from '@tempestas/domain';

export const METRIC_ORDER: readonly MetricKey[] = [
  'temperature',
  'humidity',
  'co2',
];

// A declared metric that is still null keeps its gauge, showing unknown rather than a missing dial.
export function metricsFor(
  reading: Reading,
  node: Node | null | undefined,
): MetricKey[] {
  const declared = node?.capabilities?.sensors?.find(
    (sensor) => sensor.sensorId === reading.sensorId,
  )?.metrics;
  if (declared) {
    return METRIC_ORDER.filter((metric) => declared.includes(metric));
  }
  return METRIC_ORDER.filter((metric) => reading[metric] !== null);
}

export function nodeMetrics(node: Node | null | undefined): MetricKey[] {
  const sensors = node?.capabilities?.sensors;
  if (!sensors || sensors.length === 0) {
    return [...METRIC_ORDER];
  }
  const declared = new Set(sensors.flatMap((sensor) => sensor.metrics));
  return METRIC_ORDER.filter((metric) => declared.has(metric));
}
