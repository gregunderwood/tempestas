import type { GpioLevel } from '@tempestas/domain';
import type { PinStateReport } from '../hardware/hardware.service';

/**
 * What the log already believes about one pin.
 *
 * `null` means nothing has ever been recorded for it, which is different from
 * "recorded as unknown" - the first is no history, the second is history.
 */
export interface LastKnown {
  level: GpioLevel | null;
  known: boolean;
  observedAt: Date;
}

export type TransitionVerdict =
  | { action: 'record'; reason: 'first-sight' | 'level-changed' | 'became-unknown' }
  | { action: 'skip'; reason: 'unchanged' | 'stale' };

/**
 * Should this report become a row?
 *
 * Pure, because the interesting cases are all about ordering and repetition
 * rather than about a database.
 *
 * Two things make this more than `level !== last.level`:
 *
 * - **Retained state republishes on every connect.** A node reconnecting
 *   re-announces the level it already had. Logging that would put a transition
 *   in the record where no relay moved, which is exactly the kind of false
 *   entry that makes a log untrustworthy for fitting.
 * - **Reports can arrive out of order.** QoS 1 permits redelivery, and a
 *   reconnect replays retained state that may be older than something already
 *   seen. An older observation must never overwrite a newer one.
 */
export function judgeTransition(
  last: LastKnown | null,
  report: PinStateReport,
): TransitionVerdict {
  if (last === null) {
    // Worth a row even though no relay moved: it anchors the series, so a
    // later change has something to be a change FROM.
    return { action: 'record', reason: 'first-sight' };
  }

  if (report.observedAt.getTime() < last.observedAt.getTime()) {
    return { action: 'skip', reason: 'stale' };
  }

  if (!report.known) {
    // Unknown is not off, and losing track of a burner relay is an event.
    return last.known
      ? { action: 'record', reason: 'became-unknown' }
      : { action: 'skip', reason: 'unchanged' };
  }

  if (!last.known || last.level !== report.level) {
    return { action: 'record', reason: 'level-changed' };
  }
  return { action: 'skip', reason: 'unchanged' };
}

/**
 * Did this level mean the device was ON, at the time it was observed?
 *
 * Resolved at write time and stored, rather than derived later from the device
 * row. `onLevel` is editable - the MH light is active-HIGH on the same board
 * where four channels are active-LOW - so a row edited next month would
 * silently rewrite what last month's history meant.
 */
export function energisedBy(
  level: GpioLevel | null,
  known: boolean,
  onLevel: GpioLevel | null | undefined,
): boolean | null {
  if (!known || level === null || onLevel === null || onLevel === undefined) return null;
  return level === onLevel;
}
