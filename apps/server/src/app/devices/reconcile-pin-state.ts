// Pure: nothing here may call `new Date()`. Policy in docs/Safety.md, "The hardware wins".

import type { GpioLevel } from '@tempestas/domain';
import { isOn, type DeviceTimes } from './device-state';

export interface PinObservation {
  level: GpioLevel | null;
  /** `false` means unknown. Unknown is NOT off. */
  known: boolean;
  /** The node's own `gpio/state` timestamp, not our receive time. */
  observedAt: Date;
  /** Published while we were listening, not a retained replay; only a replay can be old. */
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

type Correction = Extract<Reconciliation, { action: 'correct' }>;

export function reconcilePinState(
  device: ReconcileTarget,
  observation: PinObservation,
  now: Date,
): Reconciliation {
  if (!isLevelKnown(observation)) {
    return { action: 'none', reason: 'hardware level is unknown' };
  }
  if (isRetainedReplayNoNewerThanRow(device, observation, now)) {
    return { action: 'none', reason: 'the device row is at least as current' };
  }

  const hardwareOn = observation.level === device.onLevel;
  if (hardwareOn === isOn(device)) {
    return { action: 'none', reason: 'hardware and the row agree' };
  }

  return {
    action: 'correct',
    hardwareOn,
    at: chooseCorrectionTime(device, observation, now),
    reason: hardwareOn
      ? 'hardware reports energised, the row said off'
      : 'hardware reports de-energised, the row said on',
  };
}

// Turning off leaves `onAt` alone: the timestamps are the audit trail.
export function correctionPatch(correction: Correction): {
  onAt?: Date;
  offAt?: Date;
} {
  return correction.hardwareOn
    ? { onAt: correction.at }
    : { offAt: correction.at };
}

function isLevelKnown(observation: PinObservation): boolean {
  return observation.known && observation.level !== null;
}

function isRetainedReplayNoNewerThanRow(
  device: ReconcileTarget,
  observation: PinObservation,
  now: Date,
): boolean {
  return (
    !observation.live &&
    isNoNewerThanRow(device, clampToNow(observation.observedAt, now))
  );
}

// A live report dated before the row means the node's clock is behind, so it is dated at receipt.
function chooseCorrectionTime(
  device: ReconcileTarget,
  observation: PinObservation,
  now: Date,
): Date {
  const observedAt = clampToNow(observation.observedAt, now);
  return isNoNewerThanRow(device, observedAt) ? now : observedAt;
}

// A node clock running ahead would otherwise park the cooldown in the future.
function clampToNow(instant: Date, now: Date): Date {
  return instant.getTime() > now.getTime() ? now : instant;
}

function isNoNewerThanRow(device: DeviceTimes, instant: Date): boolean {
  return instant.getTime() <= lastTransitionTime(device);
}

function lastTransitionTime(device: DeviceTimes): number {
  return Math.max(
    device.onAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    device.offAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
}
