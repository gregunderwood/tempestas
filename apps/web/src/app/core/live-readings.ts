import { computed, inject, signal, type Signal } from '@angular/core';
import { sensorKey, type Reading } from '@tempestas/domain';
import { ApiService } from './api.service';
import { RealtimeService } from './realtime.service';

export function mergeLatestReadings(
  fetched: Reading[],
  pushed: Record<string, Reading>,
): Reading[] {
  const latestBySensor = new Map(
    fetched.map((reading) => [sensorKey(reading), reading]),
  );
  for (const [key, reading] of Object.entries(pushed)) {
    latestBySensor.set(key, reading);
  }
  return [...latestBySensor.values()];
}

export function injectLiveReadings(): Signal<Reading[]> {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const fetched = signal<Reading[]>([]);
  api.latestReadings().subscribe((readings) => fetched.set(readings));
  return computed(() => mergeLatestReadings(fetched(), realtime.readings()));
}
