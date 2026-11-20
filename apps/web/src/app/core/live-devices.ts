import {
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import type { Device } from '@tempestas/domain';
import { ApiService } from './api.service';
import type { PushedDevice } from './device-pushes';
import type { RequestState } from './fetch-once';
import { RealtimeService } from './realtime.service';

export interface FetchedDevices {
  devices: Device[];
  requestedAt: number;
}

export interface LiveDevices {
  devices: Signal<Device[]>;
  requestState: Signal<RequestState>;
  refresh(): void;
}

export function applyNewerPushes(
  fetched: FetchedDevices,
  pushes: ReadonlyMap<string, PushedDevice>,
): Device[] {
  return fetched.devices.map((fetchedDevice) => {
    const pushed = pushes.get(fetchedDevice.id);
    // A push received after the request was sent is at least as new as the response.
    if (pushed !== undefined && pushed.receivedAt >= fetched.requestedAt) {
      return pushed.device;
    }
    return fetchedDevice;
  });
}

export function keepNewerFetch(
  known: FetchedDevices,
  arriving: FetchedDevices,
): FetchedDevices {
  return arriving.requestedAt >= known.requestedAt ? arriving : known;
}

export function injectLiveDevices(): LiveDevices {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const fetched = signal<FetchedDevices>({ devices: [], requestedAt: 0 });
  const requestState = signal<RequestState>('loading');

  const refresh = (): void => {
    const requestedAt = Date.now();
    api.devices().subscribe({
      next: (devices) => {
        fetched.update((known) =>
          keepNewerFetch(known, { devices, requestedAt }),
        );
        requestState.set('loaded');
      },
      error: () =>
        requestState.update((state) =>
          state === 'loading' ? 'failed' : state,
        ),
    });
  };
  refresh();
  refreshOnEveryReconnect(realtime, refresh);

  return {
    devices: computed(() =>
      applyNewerPushes(fetched(), realtime.devicePushes()),
    ),
    requestState,
    refresh,
  };
}

// The server replays no device state on connect, so a change made while offline only arrives by refetching.
function refreshOnEveryReconnect(
  realtime: RealtimeService,
  refresh: () => void,
): void {
  const connectionsBeforeFetch = realtime.connectionCount();
  effect(() => {
    if (realtime.connectionCount() > connectionsBeforeFetch) untracked(refresh);
  });
}
