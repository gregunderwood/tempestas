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
