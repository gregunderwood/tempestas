import type { WritableSignal } from '@angular/core';
import type { Device } from '@tempestas/domain';

export interface PushedDevice {
  device: Device;
  receivedAt: number;
}

export function recordDevicePush(
  pushes: ReadonlyMap<string, PushedDevice>,
  device: Device,
  receivedAt: number,
): ReadonlyMap<string, PushedDevice> {
  return new Map(pushes).set(device.id, { device, receivedAt });
}

export const RECENT_PUSH_COUNT = 50;

export interface NumberedPush extends PushedDevice {
  sequence: number;
}

export function appendDevicePush(
  recentPushes: readonly NumberedPush[],
  push: PushedDevice,
): readonly NumberedPush[] {
  const newest = recentPushes[recentPushes.length - 1];
  const sequence = (newest?.sequence ?? 0) + 1;
  return [...recentPushes, { ...push, sequence }].slice(-RECENT_PUSH_COUNT);
}

export interface DevicePushSignals {
  devicePushes: WritableSignal<ReadonlyMap<string, PushedDevice>>;
  recentDevicePushes: WritableSignal<readonly NumberedPush[]>;
}

export function storeDevicePush(
  signals: DevicePushSignals,
  device: Device,
  receivedAt: number,
): void {
  signals.devicePushes.update((pushes) =>
    recordDevicePush(pushes, device, receivedAt),
  );
  signals.recentDevicePushes.update((recentPushes) =>
    appendDevicePush(recentPushes, { device, receivedAt }),
  );
}
