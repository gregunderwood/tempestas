import {
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import type { ZoneHistoryReport } from '@tempestas/domain';
import { ApiService } from './api.service';
import { injectLiveSource, type SourceState } from './live-source';
import {
  addPushedReadings,
  NO_PUSHED_READINGS,
  type PushedReadings,
} from './pushed-readings';
import { RealtimeService } from './realtime.service';

export interface LiveZoneHistory {
  report: Signal<ZoneHistoryReport | null>;
  /** Readings pushed since the last fetch, which the chart adds to what it returned. */
  pushedReadings: Signal<PushedReadings>;
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
): Signal<PushedReadings> {
  const pushedReadings = signal<PushedReadings>(NO_PUSHED_READINGS);
  effect(() => {
    const latestBySensor = Object.values(realtime.readings());
    const fetchedTo = report()?.to ?? null;
    untracked(() =>
      pushedReadings.update((pushed) =>
        addPushedReadings(pushed, latestBySensor, fetchedTo),
      ),
    );
  });
  return pushedReadings;
}
