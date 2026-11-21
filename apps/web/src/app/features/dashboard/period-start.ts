import {
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { catchError, map, of, type Observable } from 'rxjs';
import {
  ReadingOrder,
  sensorKey,
  type DayNightStats,
  type Reading,
  type SegmentStats,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { IN_BACKGROUND } from '../../core/background-request';

const LONGEST_TIMEOUT_MILLISECONDS = 2_147_483_647;
export const PERIOD_START_RETRY_MILLISECONDS = 60_000;

export interface PeriodStart {
  kind: SegmentStats['kind'];
  readingsBySensor: ReadonlyMap<string, Reading>;
  endsAt: string | null;
}

export interface CurrentPeriod {
  kind: SegmentStats['kind'];
  from: string;
  endsAt: string | null;
}

export interface PeriodLookup {
  stats: DayNightStats;
  period: CurrentPeriod | null;
}

export interface SensorBaseline {
  periodFrom: string;
  reading: Reading | null;
  failedAt: number | null;
}

export function injectPeriodStarts(
  liveReadings: Signal<readonly Reading[]>,
): Signal<ReadonlyMap<string, PeriodStart>> {
  const api = inject(ApiService);
  const destroyRef = inject(DestroyRef);
  const periods = signal<ReadonlyMap<string, CurrentPeriod>>(new Map());
  const baselines = signal<ReadonlyMap<string, SensorBaseline>>(new Map());
  const retryCount = signal(0);
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const periodTimers = new Map<string, ReturnType<typeof setTimeout>>();
  destroyRef.onDestroy(() => {
    retryTimers.forEach(clearTimeout);
    periodTimers.forEach(clearTimeout);
  });

  const schedulePeriodLoad = (nodeId: string, delay: number | null): void => {
    clearTimeout(periodTimers.get(nodeId));
    const isSchedulable =
      delay !== null && delay <= LONGEST_TIMEOUT_MILLISECONDS;
    if (!isSchedulable || destroyRef.destroyed) return;
    periodTimers.set(
      nodeId,
      setTimeout(() => loadPeriod(nodeId), delay),
    );
  };

  const loadPeriod = (nodeId: string): void => {
    lookUpCurrentPeriod(api, nodeId).subscribe((lookup) => {
      if (destroyRef.destroyed) return;
      const now = Date.now();
      periods.update((current) =>
        replaceCurrentPeriod(current, nodeId, lookup, now),
      );
      schedulePeriodLoad(nodeId, chooseNextPeriodLoadDelay(lookup, now));
    });
  };

  const scheduleRetry = (): void => {
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      retryCount.update((count) => count + 1);
    }, PERIOD_START_RETRY_MILLISECONDS);
    retryTimers.add(timer);
  };

  const recordBaseline = (key: string, baseline: SensorBaseline): void =>
    baselines.update((current) => new Map(current).set(key, baseline));

  const loadBaseline = (liveReading: Reading, period: CurrentPeriod): void => {
    const key = sensorKey(liveReading);
    recordBaseline(key, {
      periodFrom: period.from,
      reading: null,
      failedAt: null,
    });
    fetchFirstReading(api, liveReading, period).subscribe((firstReading) => {
      if (destroyRef.destroyed) return;
      if (!firstReading) scheduleRetry();
      recordBaseline(key, {
        periodFrom: period.from,
        reading: firstReading,
        failedAt: firstReading ? null : Date.now(),
      });
    });
  };

  const requestedNodeIds = new Set<string>();
  effect(() => {
    const unrequested = [
      ...new Set(liveReadings().map((reading) => reading.nodeId)),
    ].filter((nodeId) => !requestedNodeIds.has(nodeId));
    untracked(() =>
      unrequested.forEach((nodeId) => {
        requestedNodeIds.add(nodeId);
        loadPeriod(nodeId);
      }),
    );
  });

  effect(() => {
    retryCount();
    const currentPeriods = periods();
    const known = baselines();
    const now = Date.now();
    const due = liveReadings().flatMap((reading) => {
      const period = currentPeriods.get(reading.nodeId);
      const isDue = isBaselineDue(reading, period, known, now);
      return period && isDue ? [{ reading, period }] : [];
    });
    untracked(() =>
      due.forEach(({ reading, period }) => loadBaseline(reading, period)),
    );
  });

  return computed(() => buildPeriodStarts(periods(), baselines()));
}

// Only once the sensor has spoken this period, so a dead probe is never asked about.
export function isBaselineDue(
  liveReading: Reading,
  period: CurrentPeriod | undefined,
  baselines: ReadonlyMap<string, SensorBaseline>,
  now: number,
): boolean {
  if (!period) return false;
  const hasSpokenThisPeriod =
    Date.parse(liveReading.createdAt) >= Date.parse(period.from);
  if (!hasSpokenThisPeriod) return false;
  const baseline = baselines.get(sensorKey(liveReading));
  if (!baseline || baseline.periodFrom !== period.from) return true;
  if (baseline.reading || baseline.failedAt === null) return false;
  return now - baseline.failedAt >= PERIOD_START_RETRY_MILLISECONDS;
}

export function buildPeriodStarts(
  periods: ReadonlyMap<string, CurrentPeriod>,
  baselines: ReadonlyMap<string, SensorBaseline>,
): ReadonlyMap<string, PeriodStart> {
  const starts = new Map<string, PeriodStart>();
  for (const [nodeId, period] of periods) {
    const readingsBySensor = new Map<string, Reading>();
    for (const { periodFrom, reading } of baselines.values()) {
      const isThisPeriodsBaseline =
        reading?.nodeId === nodeId && periodFrom === period.from;
      if (reading && isThisPeriodsBaseline) {
        readingsBySensor.set(reading.sensorId, reading);
      }
    }
    starts.set(nodeId, {
      kind: period.kind,
      readingsBySensor,
      endsAt: period.endsAt,
    });
  }
  return starts;
}

// A failed lookup keeps the period it had, but never past that period's end.
export function replaceCurrentPeriod(
  periods: ReadonlyMap<string, CurrentPeriod>,
  nodeId: string,
  lookup: PeriodLookup | null,
  now: number,
): ReadonlyMap<string, CurrentPeriod> {
  const replacement = chooseReplacement(periods.get(nodeId), lookup, now);
  const updated = new Map(periods);
  if (replacement) {
    updated.set(nodeId, replacement);
  } else {
    updated.delete(nodeId);
  }
  return updated;
}

function chooseReplacement(
  current: CurrentPeriod | undefined,
  lookup: PeriodLookup | null,
  now: number,
): CurrentPeriod | null {
  if (lookup) return lookup.period;
  if (!current) return null;
  const hasPeriodEnded =
    current.endsAt !== null && Date.parse(current.endsAt) <= now;
  return hasPeriodEnded ? null : current;
}

// Retry soon after a failure, otherwise wait for the period to end; never faster than a retry.
export function chooseNextPeriodLoadDelay(
  lookup: PeriodLookup | null,
  now: number,
): number | null {
  if (!lookup) return PERIOD_START_RETRY_MILLISECONDS;
  const nextBoundary = lookup.stats.nextBoundary;
  if (nextBoundary === null) return null;
  return Math.max(
    Date.parse(nextBoundary) - now,
    PERIOD_START_RETRY_MILLISECONDS,
  );
}

function lookUpCurrentPeriod(
  api: ApiService,
  nodeId: string,
): Observable<PeriodLookup | null> {
  return api.dayNightStats({ nodeId }, IN_BACKGROUND).pipe(
    map((stats) => ({ stats, period: findCurrentPeriod(stats) })),
    catchError(() => of(null)),
  );
}

function findCurrentPeriod(stats: DayNightStats): CurrentPeriod | null {
  const period = stats.periods.find((segment) => segment.inProgress);
  if (!period) return null;
  return { kind: period.kind, from: period.from, endsAt: stats.nextBoundary };
}

function fetchFirstReading(
  api: ApiService,
  liveReading: Reading,
  period: CurrentPeriod,
): Observable<Reading | null> {
  const query = {
    nodeId: liveReading.nodeId,
    sensorId: liveReading.sensorId,
    from: period.from,
    order: ReadingOrder.OldestFirst,
    limit: 1,
  };
  return api.readings(query, IN_BACKGROUND).pipe(
    map((readings) => findOldest(readings, liveReading.sensorId)),
    catchError(() => of(null)),
  );
}

function findOldest(
  readings: readonly Reading[],
  sensorId: string,
): Reading | null {
  let oldest: Reading | null = null;
  for (const reading of readings) {
    const isOlder = !oldest || reading.createdAt < oldest.createdAt;
    if (reading.sensorId === sensorId && isOlder) oldest = reading;
  }
  return oldest;
}
