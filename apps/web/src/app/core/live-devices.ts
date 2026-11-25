import { computed, effect, inject, type Signal } from '@angular/core';
import type { Device } from '@tempestas/domain';
import { ApiService } from './api.service';
import type { PushedDevice } from './device-pushes';
import {
  injectLiveSource,
  isNewerThanFetch,
  type FetchedPayload,
  type LiveSource,
  type SourceState,
} from './live-source';
import { RealtimeService } from './realtime.service';

export interface LiveDevices {
  devices: Signal<Device[]>;
  sourceState: Signal<SourceState>;
  refresh(): void;
}

export function applyNewerPushes(
  fetched: FetchedPayload<Device[]> | null,
  pushes: ReadonlyMap<string, PushedDevice>,
): Device[] {
  if (!fetched) return [];
  return fetched.payload.map((fetchedDevice) => {
    const pushed = pushes.get(fetchedDevice.id);
    if (pushed !== undefined && isNewerThanFetch(pushed, fetched)) {
      return pushed.device;
    }
    return fetchedDevice;
  });
}

// A device added since the fetch is refetched rather than trusted from its push alone.
export function findNewestUnlistedPushAt(
  fetched: FetchedPayload<Device[]> | null,
  pushes: ReadonlyMap<string, PushedDevice>,
): number | null {
  if (!fetched) return null;
  const listedIds = new Set(fetched.payload.map((device) => device.id));
  const unlistedPushTimes = [...pushes.values()]
    .filter(
      (pushed) =>
        !listedIds.has(pushed.device.id) && isNewerThanFetch(pushed, fetched),
    )
    .map((pushed) => pushed.receivedAt);
  return unlistedPushTimes.length > 0 ? Math.max(...unlistedPushTimes) : null;
}

export function injectLiveDevices(): LiveDevices {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const source = injectLiveSource((options) => api.devices(options));
  refetchForEachAddedDevice(source, realtime);
  return {
    devices: computed(() =>
      applyNewerPushes(source.latest(), realtime.devicePushes()),
    ),
    sourceState: source.sourceState,
    refresh: source.refresh,
  };
}

// Once per push, or a device the server no longer lists would be refetched forever.
function refetchForEachAddedDevice(
  source: LiveSource<Device[]>,
  realtime: RealtimeService,
): void {
  let refetchedForPushAt = Number.NEGATIVE_INFINITY;
  effect(() => {
    const newestUnlistedPushAt = findNewestUnlistedPushAt(
      source.latest(),
      realtime.devicePushes(),
    );
    if (newestUnlistedPushAt === null) return;
    if (newestUnlistedPushAt <= refetchedForPushAt) return;
    refetchedForPushAt = newestUnlistedPushAt;
    source.refresh();
  });
}
