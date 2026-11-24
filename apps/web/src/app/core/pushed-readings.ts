import {
  sensorKey,
  ZONE_HISTORY_BUCKET_MINUTES,
  ZONE_HISTORY_HOURS,
  type Reading,
  type TemperatureBucket,
} from '@tempestas/domain';
import {
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_HOUR,
  SECONDS_PER_MINUTE,
} from '../shared/time';

const MILLISECONDS_PER_MINUTE = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
export const BUCKET_MILLISECONDS =
  ZONE_HISTORY_BUCKET_MINUTES * MILLISECONDS_PER_MINUTE;
export const WINDOW_MILLISECONDS =
  ZONE_HISTORY_HOURS * MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE;

export interface PushedProbe {
  nodeId: string;
  sensorId: string;
  /** Buckets the probe has moved past, oldest first, only as far back as the window reaches. */
  closedBuckets: readonly TemperatureBucket[];
  /** The newest bucket's readings, kept apart because a refetch can land part way through it. */
  openReadings: readonly Reading[];
}

/** Keyed by `sensorKey`. */
export type PushedReadings = ReadonlyMap<string, PushedProbe>;

export const NO_PUSHED_READINGS: PushedReadings = new Map();

// Folding as they arrive keeps at most a window of buckets per probe, however long the page stays open.
export function addPushedReadings(
  pushed: PushedReadings,
  latestBySensor: readonly Reading[],
  fetchedTo: string | null,
): PushedReadings {
  let updated = dropWhatTheFetchCovered(pushed, fetchedTo);
  for (const reading of latestBySensor) {
    const key = sensorKey(reading);
    const probe = updated.get(key) ?? startProbe(reading);
    if (!isNewReading(probe, reading, fetchedTo)) continue;
    updated = new Map(updated).set(key, addReading(probe, reading));
  }
  return updated;
}

// A closed bucket that began before the fetch's end is in the fetch already, whole or in part.
export function dropWhatTheFetchCovered(
  pushed: PushedReadings,
  fetchedTo: string | null,
): PushedReadings {
  if (fetchedTo === null) return pushed;
  const fetchedToMs = Date.parse(fetchedTo);
  let hasDropped = false;
  const trimmed = new Map<string, PushedProbe>();
  for (const [key, probe] of pushed) {
    const kept = keepAfter(probe, fetchedToMs);
    if (kept !== probe) hasDropped = true;
    if (!isEmpty(kept)) trimmed.set(key, kept);
  }
  return hasDropped ? trimmed : pushed;
}

export function bucketStartOf(instantMs: number): string {
  return new Date(
    Math.floor(instantMs / BUCKET_MILLISECONDS) * BUCKET_MILLISECONDS,
  ).toISOString();
}

export function foldReadings(
  at: string,
  readings: readonly Reading[],
): TemperatureBucket {
  return readings
    .map((reading) => toSingleReadingBucket(at, reading))
    .reduce(combineBuckets);
}

export function combineBuckets(
  first: TemperatureBucket,
  second: TemperatureBucket,
): TemperatureBucket {
  const sampleCount = first.sampleCount + second.sampleCount;
  return {
    at: first.at,
    averageC:
      (first.averageC * first.sampleCount +
        second.averageC * second.sampleCount) /
      sampleCount,
    lowestC: Math.min(first.lowestC, second.lowestC),
    highestC: Math.max(first.highestC, second.highestC),
    sampleCount,
  };
}

function startProbe(reading: Reading): PushedProbe {
  return {
    nodeId: reading.nodeId,
    sensorId: reading.sensorId,
    closedBuckets: [],
    openReadings: [],
  };
}

function isNewReading(
  probe: PushedProbe,
  reading: Reading,
  fetchedTo: string | null,
): boolean {
  const newestSeen =
    probe.openReadings[probe.openReadings.length - 1]?.createdAt ?? fetchedTo;
  return (
    newestSeen === null ||
    Date.parse(reading.createdAt) > Date.parse(newestSeen)
  );
}

function addReading(probe: PushedProbe, reading: Reading): PushedProbe {
  const readingMs = Date.parse(reading.createdAt);
  const openBucketStart = probe.openReadings[0]
    ? bucketStartOf(Date.parse(probe.openReadings[0].createdAt))
    : null;
  if (
    openBucketStart === null ||
    openBucketStart === bucketStartOf(readingMs)
  ) {
    return { ...probe, openReadings: [...probe.openReadings, reading] };
  }
  const closedBuckets = [
    ...probe.closedBuckets,
    foldReadings(openBucketStart, probe.openReadings),
  ].filter((bucket) => isInWindowEndingAt(bucket, readingMs));
  return { ...probe, closedBuckets, openReadings: [reading] };
}

function isInWindowEndingAt(bucket: TemperatureBucket, endMs: number): boolean {
  return (
    Date.parse(bucket.at) + BUCKET_MILLISECONDS > endMs - WINDOW_MILLISECONDS
  );
}

function keepAfter(probe: PushedProbe, fetchedToMs: number): PushedProbe {
  const closedBuckets = probe.closedBuckets.filter(
    (bucket) => Date.parse(bucket.at) > fetchedToMs,
  );
  const openReadings = probe.openReadings.filter(
    (reading) => Date.parse(reading.createdAt) > fetchedToMs,
  );
  const isUnchanged =
    closedBuckets.length === probe.closedBuckets.length &&
    openReadings.length === probe.openReadings.length;
  return isUnchanged ? probe : { ...probe, closedBuckets, openReadings };
}

function isEmpty(probe: PushedProbe): boolean {
  return probe.closedBuckets.length === 0 && probe.openReadings.length === 0;
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
