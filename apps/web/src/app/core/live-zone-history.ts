import {
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import type { Reading, ZoneHistoryReport } from '@tempestas/domain';
import { ApiService } from './api.service';
import { injectLiveSource, type SourceState } from './live-source';
import { RealtimeService } from './realtime.service';

export interface LiveZoneHistory {
  report: Signal<ZoneHistoryReport | null>;
  /** Readings pushed since the last fetch, which the chart adds to what it returned. */
  pushedReadings: Signal<readonly Reading[]>;
  sourceState: Signal<SourceState>;
}

// Readings arrive every few seconds and are added in the browser; only a switch or a node change refetches.
export function injectLiveZoneHistory(): LiveZoneHistory {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const source = injectLiveSource((options) => api.fetchZoneHistory(options));
  const report = computed(() => source.latest()?.payload ?? null);
  refreshWhenADeviceSwitchesOrANodeComesAndGoes(realtime, source.refresh);
  return {
    report,
    pushedReadings: collectPushedReadings(realtime, report),
    sourceState: source.sourceState,
  };
}

export function refreshWhenADeviceSwitchesOrANodeComesAndGoes(
  realtime: RealtimeService,
  refresh: () => void,
): void {
  const devicePushesAtStart = realtime.devicePushes();
  const nodePushesAtStart = realtime.nodePushes();
  effect(() => {
    const hasDevicePush = realtime.devicePushes() !== devicePushesAtStart;
    const hasNodePush = realtime.nodePushes() !== nodePushesAtStart;
    if (!hasDevicePush && !hasNodePush) return;
    untracked(refresh);
  });
}

function collectPushedReadings(
  realtime: RealtimeService,
  report: Signal<ZoneHistoryReport | null>,
): Signal<readonly Reading[]> {
  const pushedReadings = signal<readonly Reading[]>([]);
  effect(() => {
    const latestBySensor = Object.values(realtime.readings());
    const fetchedTo = report()?.to ?? null;
    untracked(() =>
      pushedReadings.update((collected) =>
        addNewReadings(collected, latestBySensor, fetchedTo),
      ),
    );
  });
  return pushedReadings;
}

// Anything the last fetch already covered is dropped, so the list only spans the time since it.
export function addNewReadings(
  collected: readonly Reading[],
  latestBySensor: readonly Reading[],
  fetchedTo: string | null,
): readonly Reading[] {
  const collectedIds = new Set(collected.map((reading) => reading.id));
  const added = latestBySensor.filter(
    (reading) => !collectedIds.has(reading.id),
  );
  const isAfterFetch = (reading: Reading): boolean =>
    fetchedTo === null || Date.parse(reading.createdAt) > Date.parse(fetchedTo);
  const kept = [...collected, ...added].filter(isAfterFetch);
  return kept.length === collected.length && added.length === 0
    ? collected
    : kept;
}
