import type {
  BandBound,
  MetricKey,
  PeriodExtreme,
  PeriodExtremes,
  Reading,
  SensorSource,
  TimeInRangePeriod,
  ZoneTimeInRange,
} from '@tempestas/domain';
import { roundTo } from '../common/rounding';
import { MILLISECONDS_PER_HOUR } from '../common/time-units';
import type { HeldTemperatureBucketRow } from '../readings/readings.service';
import {
  pickSourceTemperature,
  type ProbeTemperature,
} from '../rules/climate-resolver';
import type { ReportPeriod } from './report-periods';
import type { ReportZone } from './report-zone';
import type { ZoneBand } from './zone-band';

export type PeriodExtremeReadings = Record<MetricKey, Reading | null>;

export interface PeriodWithExtremes extends ReportPeriod {
  /** Each metric's lowest reading of a night, its highest of a day. */
  extremeReadings: PeriodExtremeReadings;
}

export interface ZoneTimeInRangeInput {
  zone: ReportZone;
  band: ZoneBand;
  /** Newest first. */
  periods: readonly PeriodWithExtremes[];
  /** This zone's probes only, every period in one window. */
  temperatureBuckets: readonly HeldTemperatureBucketRow[];
}

type BandPosition = 'below' | 'inRange' | 'above';

interface ZoneBucket {
  atMs: number;
  /** The longest any of the zone's probes held in the bucket. */
  heldMs: number;
  probes: ProbeTemperature[];
}

// A silent source falls back to the probe that would trip its rule first, the cautious reading.
const LOWER_BOUND_FALLBACK_SOURCE: SensorSource = 'min';
const UPPER_BOUND_FALLBACK_SOURCE: SensorSource = 'max';
const HOUR_DECIMALS = 2;

export function summariseZoneTimeInRange(
  input: ZoneTimeInRangeInput,
): ZoneTimeInRange {
  const zoneBuckets = groupProbesByBucket(input.temperatureBuckets);
  return {
    zoneId: input.zone.id,
    zoneSlug: input.zone.slug,
    zoneName: input.zone.displayName,
    timezone: input.zone.timezone,
    nodeIds: input.zone.nodeIds,
    lowerBounds: input.band.lowerBounds,
    upperBounds: input.band.upperBounds,
    periods: input.periods.map((period) =>
      summarisePeriod(period, zoneBuckets, input.band),
    ),
  };
}

function summarisePeriod(
  period: PeriodWithExtremes,
  zoneBuckets: readonly ZoneBucket[],
  band: ZoneBand,
): TimeInRangePeriod {
  const heldMsByPosition: Record<BandPosition, number> = {
    below: 0,
    inRange: 0,
    above: 0,
  };
  for (const bucket of zoneBuckets) {
    if (!isWithinPeriod(bucket.atMs, period)) continue;
    heldMsByPosition[findBandPosition(bucket.probes, band)] += bucket.heldMs;
  }
  const periodMs = period.to.getTime() - period.from.getTime();
  const heldMs = Object.values(heldMsByPosition).reduce(
    (total, positionMs) => total + positionMs,
    0,
  );
  return {
    kind: period.kind,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    inProgress: period.inProgress,
    hoursBelow: toHours(heldMsByPosition.below),
    hoursInRange: toHours(heldMsByPosition.inRange),
    hoursAbove: toHours(heldMsByPosition.above),
    hoursWithoutReadings: toHours(Math.max(0, periodMs - heldMs)),
    extremes: toPeriodExtremes(period.extremeReadings),
  };
}

function groupProbesByBucket(
  rows: readonly HeldTemperatureBucketRow[],
): ZoneBucket[] {
  const bucketsByStart = new Map<number, ZoneBucket>();
  for (const row of rows) {
    const atMs = row.at.getTime();
    const bucket = bucketsByStart.get(atMs) ?? { atMs, heldMs: 0, probes: [] };
    bucket.heldMs = Math.max(bucket.heldMs, row.heldMs);
    bucket.probes.push({
      nodeId: row.nodeId,
      sensorId: row.sensorId,
      temperatureC: row.averageC,
    });
    bucketsByStart.set(atMs, bucket);
  }
  return [...bucketsByStart.values()];
}

// Below wins a tie with above: a missed heat setpoint is the costlier miss.
function findBandPosition(
  probes: readonly ProbeTemperature[],
  band: ZoneBand,
): BandPosition {
  if (band.lowerBounds.some((bound) => isBelowBound(probes, bound))) {
    return 'below';
  }
  if (band.upperBounds.some((bound) => isAboveBound(probes, bound))) {
    return 'above';
  }
  return 'inRange';
}

function isBelowBound(
  probes: readonly ProbeTemperature[],
  bound: BandBound,
): boolean {
  const temperatureC = readBoundTemperature(
    probes,
    bound,
    LOWER_BOUND_FALLBACK_SOURCE,
  );
  return temperatureC !== null && temperatureC < bound.setpointC;
}

function isAboveBound(
  probes: readonly ProbeTemperature[],
  bound: BandBound,
): boolean {
  const temperatureC = readBoundTemperature(
    probes,
    bound,
    UPPER_BOUND_FALLBACK_SOURCE,
  );
  return temperatureC !== null && temperatureC > bound.setpointC;
}

function readBoundTemperature(
  probes: readonly ProbeTemperature[],
  bound: BandBound,
  fallbackSource: SensorSource,
): number | null {
  return (
    pickSourceTemperature(probes, bound.sensorSource) ??
    pickSourceTemperature(probes, fallbackSource)
  );
}

function isWithinPeriod(instantMs: number, period: ReportPeriod): boolean {
  return instantMs >= period.from.getTime() && instantMs < period.to.getTime();
}

function toPeriodExtremes(readings: PeriodExtremeReadings): PeriodExtremes {
  return {
    temperature: toPeriodExtreme(readings.temperature, 'temperature'),
    humidity: toPeriodExtreme(readings.humidity, 'humidity'),
    co2: toPeriodExtreme(readings.co2, 'co2'),
  };
}

function toPeriodExtreme(
  reading: Reading | null,
  metric: MetricKey,
): PeriodExtreme | null {
  const value = reading?.[metric];
  if (reading === null || value === null || value === undefined) return null;
  return {
    value,
    at: reading.createdAt,
    nodeId: reading.nodeId,
    sensorId: reading.sensorId,
  };
}

function toHours(milliseconds: number): number {
  return roundTo(milliseconds / MILLISECONDS_PER_HOUR, HOUR_DECIMALS);
}
