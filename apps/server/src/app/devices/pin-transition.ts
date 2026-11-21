import type { GpioLevel } from '@tempestas/domain';
import type { PinStateReport } from '../hardware/hardware.service';

/** What the log last wrote for one pin; `null` in its place means no history at all. */
export interface LastKnown {
  level: GpioLevel | null;
  known: boolean;
  observedAt: Date;
}

export type TransitionVerdict =
  | {
      action: 'record';
      reason: 'first-sight' | 'level-changed' | 'became-unknown';
    }
  | { action: 'skip'; reason: 'unchanged' | 'stale' };

export function judgeTransition(
  last: LastKnown | null,
  report: PinStateReport,
): TransitionVerdict {
  if (last === null) {
    // Anchors the series, so a later change has something to be a change from.
    return { action: 'record', reason: 'first-sight' };
  }
  if (isOlderRetainedReplay(last, report)) {
    return { action: 'skip', reason: 'stale' };
  }
  if (!report.known) {
    return last.known
      ? { action: 'record', reason: 'became-unknown' }
      : { action: 'skip', reason: 'unchanged' };
  }
  if (!last.known || last.level !== report.level) {
    return { action: 'record', reason: 'level-changed' };
  }
  return { action: 'skip', reason: 'unchanged' };
}

/** Resolved at write time, because `onLevel` is editable and must not rewrite history. */
export function resolveEnergised(
  level: GpioLevel | null,
  known: boolean,
  onLevel: GpioLevel | null | undefined,
): boolean | null {
  if (!known || level === null || onLevel === null || onLevel === undefined) {
    return null;
  }
  return level === onLevel;
}

export function resolveRecordedAt(
  last: LastKnown | null,
  report: PinStateReport,
  receivedAt: Date,
): Date {
  if (last !== null && isLiveFromClockBehind(last, report)) {
    return receivedAt;
  }
  return report.observedAt;
}

function isDatedBefore(report: PinStateReport, last: LastKnown): boolean {
  return report.observedAt.getTime() < last.observedAt.getTime();
}

function isOlderRetainedReplay(
  last: LastKnown,
  report: PinStateReport,
): boolean {
  return !report.live && isDatedBefore(report, last);
}

// A live report is never old; dated in the past, it is the node's clock that is behind.
function isLiveFromClockBehind(
  last: LastKnown,
  report: PinStateReport,
): boolean {
  return report.live && isDatedBefore(report, last);
}
