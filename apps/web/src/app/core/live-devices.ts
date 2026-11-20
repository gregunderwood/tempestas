import { computed, inject, signal, type Signal } from '@angular/core';
import type { Device } from '@tempestas/domain';
import { ApiService } from './api.service';
import { RealtimeService } from './realtime.service';

export interface PushedDevice {
  device: Device;
  receivedAt: number;
}

export interface FetchedDevices {
  devices: Device[];
  requestedAt: number;
}

export interface LiveDevices {
  devices: Signal<Device[]>;
  refresh(): void;
}

export function recordDevicePush(
  pushes: ReadonlyMap<string, PushedDevice>,
  device: Device,
  receivedAt: number,
): ReadonlyMap<string, PushedDevice> {
  return new Map(pushes).set(device.id, { device, receivedAt });
}

export function applyNewerPushes(
  fetched: FetchedDevices,
  pushes: ReadonlyMap<string, PushedDevice>,
): Device[] {
  return fetched.devices.map((fetchedDevice) => {
    const pushed = pushes.get(fetchedDevice.id);
    // A push received after the request was sent is at least as new as the response.
    const isPushNewer = pushed && pushed.receivedAt >= fetched.requestedAt;
    return isPushNewer ? pushed.device : fetchedDevice;
  });
}

export function injectLiveDevices(): LiveDevices {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const fetched = signal<FetchedDevices>({ devices: [], requestedAt: 0 });

  const refresh = (): void => {
    const requestedAt = Date.now();
    api.devices().subscribe((devices) => fetched.set({ devices, requestedAt }));
  };
  refresh();

  return {
    devices: computed(() =>
      applyNewerPushes(fetched(), realtime.devicePushes()),
    ),
    refresh,
  };
}
