import { computed, inject, type Signal } from '@angular/core';
import type { Device } from '@tempestas/domain';
import { ApiService } from './api.service';
import type { PushedDevice } from './device-pushes';
import {
  injectLiveSource,
  type FetchedPayload,
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
    // A push received after the request was sent is at least as new as the response.
    if (pushed !== undefined && pushed.receivedAt >= fetched.requestedAt) {
      return pushed.device;
    }
    return fetchedDevice;
  });
}

export function injectLiveDevices(): LiveDevices {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const source = injectLiveSource(() => api.devices());
  return {
    devices: computed(() =>
      applyNewerPushes(source.latest(), realtime.devicePushes()),
    ),
    sourceState: source.sourceState,
    refresh: source.refresh,
  };
}
