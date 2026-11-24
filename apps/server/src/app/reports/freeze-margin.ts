import {
  FREEZE_MARGIN_ALARM_C,
  type ColdestReading,
  type DeviceRole,
  type FreezeConcern,
  type FreezeMarginNight,
  type HeatingAtColdest,
  type Reading,
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
  findOnBelowFor,
  resolveFreezeWarning,
  type HeatOnBelowByRole,
} from './heating-setpoints';
import type { NightWindow } from './night-windows';

export interface FreezeMarginZone {
  id: string;
  slug: string;
  displayName: string;
  timezone: string;
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

// The zone is as cold as its coldest probe, which is the probe the pumphouse heat runs on.
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
  return input.devices.map((device) => ({
    deviceId: device.id,
    deviceName: device.name,
    role: device.role,
    state: findStateAt(
      input.spans.filter((span) => span.deviceId === device.id),
      coldestMs,
    ),
    onBelowC: findOnBelowFor(device.role, input.heatOnBelowByRole),
  }));
}

// Off beats unknown beats on: the worse explanation is the one to look at first.
function findConcern(
  coldestC: number,
  heating: readonly HeatingAtColdest[],
): FreezeConcern | null {
  const calledFor = heating.filter((device) => coldestC < device.onBelowC);
  if (calledFor.some((device) => device.state === 'off')) {
    return 'heat-off-while-cold';
  }
  if (calledFor.some((device) => device.state === 'unknown')) {
    return 'heat-unknown-while-cold';
  }
  if (calledFor.length > 0 && isNearFreezing(coldestC)) {
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
