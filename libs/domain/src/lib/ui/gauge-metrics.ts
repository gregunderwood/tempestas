/**
 * Gauge ranges and colour bands, carried over verbatim from the old Angular
 * app - where they lived untyped on a service as `readonly threshholds: any`
 * (sic) and the gauge config was copy-pasted nine times across two templates.
 */
export type GaugeMetricKey = 'co2' | 'temperature' | 'humidity';

export interface GaugeThreshold {
  /** Applies from this value upward. */
  from: number;
  color: string;
}

export interface GaugeMetric {
  key: GaugeMetricKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  decimals: number;
  /** Ascending. Pick the last threshold whose `from` <= value. */
  thresholds: GaugeThreshold[];
}

export const GAUGE_METRICS: Record<GaugeMetricKey, GaugeMetric> = {
  co2: {
    key: 'co2',
    label: 'CO2',
    unit: 'PPM',
    min: 0,
    max: 2500,
    decimals: 0,
    thresholds: [
      { from: 0, color: 'blue' },
      { from: 300, color: 'green' },
      { from: 1750, color: 'orange' },
      { from: 2200, color: 'red' },
    ],
  },
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    unit: '°C',
    min: 0,
    max: 50,
    decimals: 1,
    thresholds: [
      { from: -50, color: 'blue' },
      { from: 2, color: 'purple' },
      { from: 10, color: 'green' },
      { from: 35, color: 'orange' },
      { from: 40, color: 'red' },
    ],
  },
  humidity: {
    key: 'humidity',
    label: 'Humidity',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    thresholds: [
      { from: 0, color: 'red' },
      { from: 10, color: 'orange' },
      { from: 25, color: 'green' },
      { from: 60, color: 'orange' },
      { from: 85, color: 'red' },
    ],
  },
};

export function gaugeColorFor(metric: GaugeMetric, value: number | null): string | null {
  if (value === null) {
    return null;
  }
  let color: string | null = null;
  for (const t of metric.thresholds) {
    if (value >= t.from) {
      color = t.color;
    }
  }
  return color;
}
