import type { Device } from '@tempestas/domain';

/** One `device:state` push, and when this browser received it. */
export interface PushedDevice {
  device: Device;
  /** `Date.now()` on receipt. */
  receivedAt: number;
}

/** A `GET /api/devices` result, and when the request was SENT. */
export interface FetchedDevices {
  devices: Device[];
  requestedAt: number;
}

export const NO_DEVICES: FetchedDevices = { devices: [], requestedAt: 0 };

/**
 * The devices a screen shows: what the API said, with every push that is newer
 * than that request applied on top.
 *
 * Two ways this used to go wrong, both now impossible:
 *
 * - Keeping only the NEWEST push. Two devices switched by one rules decision
 *   arrive back to back, and the first one reverted to the API's stale copy.
 * - A push that lands before the API response. The response replaced the
 *   list, older than the push it overwrote.
 *
 * Measured against when the request was sent, not when it answered: a push
 * received after the request left describes a state at least as new as
 * anything the response can carry.
 */
export function withPushes(
  fetched: FetchedDevices,
  pushes: ReadonlyMap<string, PushedDevice>,
): Device[] {
  return fetched.devices.map((d) => {
    const pushed = pushes.get(d.id);
    return pushed && pushed.receivedAt >= fetched.requestedAt
      ? pushed.device
      : d;
  });
}
