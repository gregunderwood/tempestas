/**
 * Reconciling a device row against what the hardware actually reports.
 *
 * A node can change a line without being told to: the dead-man trips, or the
 * server's own last-will fires and the node fails safe. The relay is then off
 * while the `devices` row still says on - and that row is what the UI and the
 * anti-short-cycle interlock read, so the next attempt to turn the burner on
 * returns 409 because the row believes it is already running. On a cold night
 * that is a heater staying off because a database disagrees with a relay.
 *
 * The policy: **the hardware wins for the level, and a disagreement raises an
 * alarm.** A divergence means something already went wrong, so it is corrected
 * loudly rather than tidied away.
 *
 * RULE: nothing in this file may call `new Date()`. Time enters as an argument,
 * same as `device-state.ts`, because the whole point is timestamp ordering.
 */

import type { GpioLevel } from '@tempestas/domain';
import { isOn, type DeviceTimes } from './device-state';

/** What a node says one of its lines is doing, and when it saw that. */
export interface PinObservation {
  level: GpioLevel | null;
  /** `false` means unknown. Unknown is NOT off. */
  known: boolean;
  /** The `ts` from the node's `gpio/state`, not our receive time. */
  observedAt: Date;
  /**
   * Published while we were listening, rather than a retained message the
   * broker replayed when we subscribed. A live report is the current truth
   * whatever its timestamp says; only a replay can be genuinely old.
   */
  live: boolean;
}

export interface ReconcileTarget extends DeviceTimes {
  /** The level that means energised for this device. Active-LOW relays use 0. */
  onLevel: GpioLevel;
}

export type Reconciliation =
  | { readonly action: 'none'; readonly reason: string }
  | {
      readonly action: 'correct';
      readonly hardwareOn: boolean;
      readonly at: Date;
      readonly reason: string;
    };

/**
 * Decide whether a device row has to be corrected to match its hardware.
 *
 * The ordering check is what makes the rest safe: a correction is only ever
 * applied when the observation is *newer* than the row's last transition, so
 * writing the timestamp is guaranteed to flip the derived state and there is no
 * case where a correction lands the row in the state it was already in.
 */
export function reconcilePinState(
  device: ReconcileTarget,
  observation: PinObservation,
  now: Date,
): Reconciliation {
  if (!observation.known || observation.level === null) {
    // The node cannot read the pad, or has not claimed it. Reporting a burner
    // relay as off on the strength of that is the exact lie `known` exists to
    // prevent, so the row keeps whatever it had.
    return { action: 'none', reason: 'hardware level is unknown' };
  }

  // A node's clock can run ahead of ours. Clamping forward-dated observations
  // to `now` keeps a skewed node from parking a device's cooldown in the
  // future, which would lock a heater out for as long as the skew.
  let at =
    observation.observedAt.getTime() > now.getTime()
      ? now
      : observation.observedAt;

  const lastTransition = Math.max(
    device.onAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    device.offAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  if (at.getTime() <= lastTransition) {
    if (!observation.live) {
      // Our row is at least as current as this observation - a retained
      // `gpio/state` replayed on subscribe that predates a command we have
      // since sent. Believing it would undo the newer truth.
      return {
        action: 'none',
        reason: 'the device row is at least as current',
      };
    }
    // Live, yet dated before our row: the node's clock is behind, not the
    // report. A Pi has no RTC and boots on the time it saved at shutdown
    // until NTP answers. patji, 2026-11-18: rebooted 3.5 min slow, failed
    // safe to ON, and its report predated the rule's last "off" - so the row
    // stayed off, every tick was answered "already off", and the heater could
    // never be turned off again. Dated at receipt, which only ever makes a
    // cooldown start later than reality, never earlier.
    at = now;
  }

  const hardwareOn = observation.level === device.onLevel;
  if (hardwareOn === isOn(device)) {
    return { action: 'none', reason: 'hardware and the row agree' };
  }

  return {
    action: 'correct',
    hardwareOn,
    at,
    reason: hardwareOn
      ? 'hardware reports energised, the row said off'
      : 'hardware reports de-energised, the row said on',
  };
}

/**
 * The timestamp change a correction implies. Split out so the alarm text and
 * the write cannot disagree about what happened.
 *
 * Note what is absent: turning a device off rewrites `offAt` and **leaves
 * `onAt` alone**. The timestamps are the audit trail, and `offAt` is recorded
 * at the moment the node actually observed the line - so the minimum-off window
 * runs from when the relay really opened and is never shorter than reality.
 */
export function correctionPatch(
  correction: Extract<Reconciliation, { action: 'correct' }>,
): { onAt?: Date; offAt?: Date } {
  return correction.hardwareOn
    ? { onAt: correction.at }
    : { offAt: correction.at };
}
