import {
  FREEZE_MARGIN_ALARM_C,
  type ColdestReading,
  type DeviceRole,
  type FreezeConcern,
  type FreezeMarginNight,
  type HeatingAtColdest,
  type Reading,
  type SensorSource,
  type ZoneFreezeMargin,
} from '@tempestas/domain';
import { roundTo } from '../common/rounding';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
} from '../common/time-units';
import { findStateAt, type Span } from '../devices/relay-spans';
import type { TemperatureBucketRow } from '../readings/readings.service';
import {
  pickSourceTemperature,
  type ProbeTemperature,
} from '../rules/climate-resolver';
import {
  FALLBACK_SENSOR_SOURCE,
  findOnBelowFor,
  findSensorSourceFor,
  resolveFreezeWarning,
  type HeatOnBelowByRole,
  type SensorSourceByRole,
} from './heating-setpoints';
import type { NightWindow } from './night-windows';

export interface FreezeMarginZone {
  id: string;
  slug: string;
  displayName: string;
  timezone: string;
  nodeIds: string[];
}

export interface HeatingDevice {
  id: string;
  name: string;
  role: DeviceRole;
  zoneId: string;
}

export interface NightWithColdest extends NightWindow {
  coldest: Reading | null;
}

export interface ZoneFreezeMarginInput {
  zone: FreezeMarginZone;
  heatOnBelowByRole: HeatOnBelowByRole;
  sensorSourceByRole: SensorSourceByRole;
  /** This zone's heating devices only. */
  devices: readonly HeatingDevice[];
  /** Newest first. */
  nights: readonly NightWithColdest[];
  /** This zone's probes only, every night in one window. */
  temperatureBuckets: readonly TemperatureBucketRow[];
  bucketMinutes: number;
  spans: readonly Span[];
}

interface ZoneBucket {
  atMs: number;
  lowestC: number;
}

const FREEZING_POINT_C = 0;
const HOUR_DECIMALS = 2;

export function summariseZoneFreezeMargin(
  input: ZoneFreezeMarginInput,
): ZoneFreezeMargin {
  const warning = resolveFreezeWarning(input.heatOnBelowByRole);
  const zoneBuckets = findZoneLowestByBucket(input.temperatureBuckets);
  return {
    zoneId: input.zone.id,
    zoneSlug: input.zone.slug,
    zoneName: input.zone.displayName,
    timezone: input.zone.timezone,
    nodeIds: input.zone.nodeIds,
    warningBelowC: warning.belowC,
    isWarningFromRules: warning.isFromRules,
    nights: input.nights.map((night) =>
      summariseNight(night, zoneBuckets, warning.belowC, input),
    ),
  };
}

function summariseNight(
  night: NightWithColdest,
  zoneBuckets: readonly ZoneBucket[],
  warningBelowC: number,
  input: ZoneFreezeMarginInput,
): FreezeMarginNight {
  const bucketMs = input.bucketMinutes * MILLISECONDS_PER_MINUTE;
  const bucketsThisNight = zoneBuckets.filter((bucket) =>
    isWithinNight(bucket.atMs, night),
  );
  const bucketsBelowWarning = bucketsThisNight.filter(
    (bucket) => bucket.lowestC < warningBelowC,
  );
  const heating = night.coldest ? describeHeatingAt(night.coldest, input) : [];
  return {
    from: night.from.toISOString(),
    to: night.to.toISOString(),
    inProgress: night.inProgress,
    coldest: night.coldest ? toColdestReading(night.coldest) : null,
    heating,
    hoursBelowWarning: toHours(bucketsBelowWarning.length * bucketMs),
    hoursWithReadings: toHours(bucketsThisNight.length * bucketMs),
    concern: night.coldest
      ? findConcern(night.coldest.temperature, heating)
      : null,
  };
}

// The zone is as cold as its coldest probe, whichever probe a rule follows.
function findZoneLowestByBucket(
  buckets: readonly TemperatureBucketRow[],
): ZoneBucket[] {
  const lowestByBucket = new Map<number, number>();
  for (const bucket of buckets) {
    const atMs = bucket.at.getTime();
    const lowestSoFar = lowestByBucket.get(atMs) ?? Number.POSITIVE_INFINITY;
    lowestByBucket.set(atMs, Math.min(lowestSoFar, bucket.lowestC));
  }
  return [...lowestByBucket].map(([atMs, lowestC]) => ({ atMs, lowestC }));
}

function describeHeatingAt(
  coldest: Reading,
  input: ZoneFreezeMarginInput,
): HeatingAtColdest[] {
  const coldestMs = new Date(coldest.createdAt).getTime();
  const probes = findProbesAround(coldest, input);
  return input.devices.map((device) => {
    const { onBelowC, isFromRule } = findOnBelowFor(
      device.role,
      input.heatOnBelowByRole,
    );
    const ruleTemperatureC = readRuleSourceTemperature(
      probes,
      findSensorSourceFor(device.role, input.sensorSourceByRole),
    );
    return {
      deviceId: device.id,
      deviceName: device.name,
      role: device.role,
      state: findStateAt(
        input.spans.filter((span) => span.deviceId === device.id),
        coldestMs,
      ),
      onBelowC,
      isOnBelowFromRule: isFromRule,
      isHeatOwed: ruleTemperatureC !== null && ruleTemperatureC < onBelowC,
    };
  });
}

// A silent source does not mean no heat was owed, so fall back to the coldest probe, the cautious reading.
function readRuleSourceTemperature(
  probes: readonly ProbeTemperature[],
  source: SensorSource,
): number | null {
  return (
    pickSourceTemperature(probes, source) ??
    pickSourceTemperature(probes, FALLBACK_SENSOR_SOURCE)
  );
}

// Each probe at its lowest in the coldest moment's bucket, so a doubtful night leans towards a flag.
function findProbesAround(
  coldest: Reading,
  input: ZoneFreezeMarginInput,
): ProbeTemperature[] {
  const bucketMs = input.bucketMinutes * MILLISECONDS_PER_MINUTE;
  const coldestMs = new Date(coldest.createdAt).getTime();
  const bucketStartMs = Math.floor(coldestMs / bucketMs) * bucketMs;
  const probes = input.temperatureBuckets
    .filter((bucket) => bucket.at.getTime() === bucketStartMs)
    .map((bucket) => ({
      nodeId: bucket.nodeId,
      sensorId: bucket.sensorId,
      temperatureC: bucket.lowestC,
    }));
  if (probes.length > 0) return probes;
  return [
    {
      nodeId: coldest.nodeId,
      sensorId: coldest.sensorId,
      temperatureC: coldest.temperature,
    },
  ];
}

// Off beats unknown beats on: the worse explanation is the one to look at first.
function findConcern(
  coldestC: number,
  heating: readonly HeatingAtColdest[],
): FreezeConcern | null {
  const owed = heating.filter((device) => device.isHeatOwed);
  if (owed.some((device) => device.state === 'off')) {
    return 'heat-off-while-cold';
  }
  if (owed.some((device) => device.state === 'unknown')) {
    return 'heat-unknown-while-cold';
  }
  if (owed.length > 0 && isNearFreezing(coldestC)) {
    return 'cold-despite-heat';
  }
  return null;
}

function isNearFreezing(temperatureC: number): boolean {
  return temperatureC - FREEZING_POINT_C < FREEZE_MARGIN_ALARM_C;
}

function isWithinNight(instantMs: number, night: NightWindow): boolean {
  return instantMs >= night.from.getTime() && instantMs < night.to.getTime();
}

function toColdestReading(reading: Reading): ColdestReading {
  return {
    temperatureC: reading.temperature,
    at: reading.createdAt,
    nodeId: reading.nodeId,
    sensorId: reading.sensorId,
  };
}

function toHours(milliseconds: number): number {
  return roundTo(milliseconds / MILLISECONDS_PER_HOUR, HOUR_DECIMALS);
}
