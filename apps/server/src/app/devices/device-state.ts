/**
 * Device on/off state and the anti-short-cycle interlock, as pure functions.
 *
 * There is no `is_on` column: state is derived from the on/off timestamps, and
 * the minimum-off time from `offAt + onDelayDuration`. That is how the Python
 * system worked and it is worth keeping - the timestamps are the audit trail.
 *
 * RULE: nothing in this file may call `new Date()`. Time enters as an argument.
 * That is what makes the DST and boundary tests below possible at all.
 */

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

/**
 * The instant at which this device may next be turned on.
 *
 * `null` means "no constraint" - either it has never been on, or it is already
 * on (in which case turning on does not apply; check `isOn` first). Callers
 * that need to tell those apart have `isOn` alongside.
 */
export function canTurnOnAt(device: DeviceTimes): Date | null {
  if (isOn(device)) {
    return null;
  }
  if (!device.onAt || !device.offAt) {
    // Never been on: no cooldown has started, so it may go on immediately.
    return null;
  }
  return new Date(device.offAt.getTime() + device.onDelayDuration * 1000);
}

/**
 * ⚠ THE PORTING LANDMINE.
 *
 * Python read:
 *     def can_turn_on(self):
 *         if self.is_on(): return False
 *         return self.can_turn_on_at() < datetime.utcnow()
 *     def can_turn_on_at(self):
 *         ...
 *         else: return datetime.utcnow()      # a SECOND, LATER call
 *
 * For a device that has never been on, that compares `t0 < t1` where t1 was
 * sampled microseconds after t0 - so it is True. Port it naively with a single
 * injected `now` and you get `now < now` => False, and a freshly created device
 * can NEVER be turned on, by automation or by hand. The `null` branch above
 * plus the `>=` here are what keep the real behaviour.
 */
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
