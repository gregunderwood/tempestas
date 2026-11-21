import type { Device } from '@tempestas/domain';

export function isHeldOffByInterlock(device: Device): boolean {
  return !device.isOn && !device.canTurnOn && Boolean(device.canTurnOnAt);
}
