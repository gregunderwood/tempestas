import { computed, inject, type Signal } from '@angular/core';
import { sensorKey, type Reading } from '@tempestas/domain';
import { ApiService } from './api.service';
import { fetchOnce, type RequestState } from './fetch-once';
import { RealtimeService } from './realtime.service';

export interface LiveReadings {
  readings: Signal<Reading[]>;
  requestState: Signal<RequestState>;
}

export function mergeLatestReadings(
  fetched: Reading[],
  pushed: Record<string, Reading>,
): Reading[] {
  const latestBySensor = new Map(
    fetched.map((reading) => [sensorKey(reading), reading]),
  );
  for (const reading of Object.values(pushed)) {
    const known = latestBySensor.get(sensorKey(reading));
    if (!known || isAtLeastAsNew(reading, known)) {
      latestBySensor.set(sensorKey(reading), reading);
    }
  }
  return [...latestBySensor.values()];
}

function isAtLeastAsNew(candidate: Reading, known: Reading): boolean {
  return Date.parse(candidate.createdAt) >= Date.parse(known.createdAt);
}

export function injectLiveReadings(): LiveReadings {
  const realtime = inject(RealtimeService);
  const fetched = fetchOnce(inject(ApiService).latestReadings());
  return {
    readings: computed(() =>
      mergeLatestReadings(fetched.value() ?? [], realtime.readings()),
    ),
    requestState: fetched.requestState,
  };
}
