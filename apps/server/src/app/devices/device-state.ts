// Pure: nothing here may call `new Date()`, so DST and boundary cases are testable.

import { MILLISECONDS_PER_SECOND } from '../common/time-units';

export interface DeviceTimes {
  onAt: Date | null;
  offAt: Date | null;
  /** Minimum-off time in seconds. */
  onDelayDuration: number;
}

export function isOn(device: DeviceTimes): boolean {
  if (!device.onAt) {
    return false;
  }
  if (!device.offAt) {
    return true;
  }
  // Strictly greater: an exact tie counts as OFF, matching the Python original.
  return device.onAt.getTime() > device.offAt.getTime();
}

/** `null` means no constraint: the device has never been turned off, or is on now. */
export function canTurnOnAt(device: DeviceTimes): Date | null {
  if (isOn(device)) {
    return null;
  }
  if (!hasBeenTurnedOff(device)) {
    return null;
  }
  return new Date(
    device.offAt.getTime() + device.onDelayDuration * MILLISECONDS_PER_SECOND,
  );
}

// A never-on device must pass with a single `now`; see "now < now" in docs/Rules and Climate.md.
export function canTurnOn(device: DeviceTimes, now: Date): boolean {
  if (isOn(device)) {
    return false;
  }
  const earliest = canTurnOnAt(device);
  if (earliest === null) {
    return true;
  }
  return now.getTime() >= earliest.getTime();
}

function hasBeenTurnedOff(
  device: DeviceTimes,
): device is DeviceTimes & { onAt: Date; offAt: Date } {
  return Boolean(device.onAt) && Boolean(device.offAt);
}
