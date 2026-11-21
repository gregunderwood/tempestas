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
