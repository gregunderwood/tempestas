import type { MetricKey, Node, Reading } from '@tempestas/domain';

/** Display order, everywhere a sensor's metrics are listed. */
export const METRIC_ORDER: readonly MetricKey[] = [
  'temperature',
  'humidity',
  'co2',
];

/**
 * The gauges a sensor gets: what it declares it measures. A pipe probe has no
 * humidity, and an empty humidity dial beside it would read as a broken sensor.
 *
 * A declared metric that is null still gets its gauge, showing unknown - an
 * SCD4x warming up has CO2, it just has not said yet. Only before the node's
 * capabilities have loaded does the reading itself decide.
 */
export function metricsFor(
  reading: Reading,
  node: Node | null | undefined,
): MetricKey[] {
  const declared = node?.capabilities?.sensors?.find(
    (s) => s.sensorId === reading.sensorId,
  )?.metrics;
  if (declared) {
    return METRIC_ORDER.filter((m) => declared.includes(m));
  }
  return METRIC_ORDER.filter((m) => reading[m] !== null);
}

/** Every metric any sensor on the node declares - all of them until it has announced. */
export function nodeMetrics(node: Node | null | undefined): MetricKey[] {
  const sensors = node?.capabilities?.sensors;
  if (!sensors || sensors.length === 0) {
    return [...METRIC_ORDER];
  }
  const declared = new Set(sensors.flatMap((s) => s.metrics));
  return METRIC_ORDER.filter((m) => declared.has(m));
}
