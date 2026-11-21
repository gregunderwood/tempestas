import { describe, expect, it } from 'vitest';
import type { PinStateReport } from '../hardware/hardware.service';
import {
  judgeTransition,
  resolveEnergised,
  resolveRecordedAt,
  type LastKnown,
} from './pin-transition';

const AT = new Date('2026-09-10T18:03:00Z');

function report(overrides: Partial<PinStateReport> = {}): PinStateReport {
  return {
    nodeId: 'elantris',
    pin: 5,
    level: 0,
    known: true,
    observedAt: AT,
    live: true,
    ...overrides,
  };
}

function last(overrides: Partial<LastKnown> = {}): LastKnown {
  return {
    level: 1,
    known: true,
    observedAt: new Date(AT.getTime() - 60_000),
    ...overrides,
  };
}

describe('judgeTransition', () => {
  it('records the first sight of a pin, so later changes have an anchor', () => {
    expect(judgeTransition(null, report())).toEqual({
      action: 'record',
      reason: 'first-sight',
    });
  });

  it('records a level change', () => {
    expect(judgeTransition(last({ level: 1 }), report({ level: 0 }))).toEqual({
      action: 'record',
      reason: 'level-changed',
    });
  });

  it('ignores a repeat of the level it already holds', () => {
    // Retained gpio/state is republished on every reconnect; no relay moved.
    expect(judgeTransition(last({ level: 0 }), report({ level: 0 }))).toEqual({
      action: 'skip',
      reason: 'unchanged',
    });
  });

  it('records losing track of a pin, because unknown is not off', () => {
    expect(
      judgeTransition(
        last({ level: 0, known: true }),
        report({ level: null, known: false }),
      ),
    ).toEqual({ action: 'record', reason: 'became-unknown' });
  });

  it('does not record staying unknown', () => {
    expect(
      judgeTransition(
        last({ level: null, known: false }),
        report({ level: null, known: false }),
      ),
    ).toEqual({ action: 'skip', reason: 'unchanged' });
  });

  it('records recovering from unknown even to the same level', () => {
    // Going unknown -> 0 is a real event: we now know something we did not.
    expect(
      judgeTransition(
        last({ level: null, known: false }),
        report({ level: 0 }),
      ),
    ).toEqual({ action: 'record', reason: 'level-changed' });
  });

  it('refuses an observation older than what is already recorded', () => {
    // A replay overwriting a newer observation would invent a transition backwards in time.
    const older = report({
      level: 0,
      observedAt: new Date(AT.getTime() - 120_000),
      live: false,
    });
    expect(judgeTransition(last({ level: 1 }), older)).toEqual({
      action: 'skip',
      reason: 'stale',
    });
  });

  // patji, 2026-11-18: a reboot left its clock behind, and skipping its failsafe report hid it.
  it('records a LIVE change even when the node dates it in the past', () => {
    const behind = report({
      level: 0,
      observedAt: new Date(AT.getTime() - 120_000),
      live: true,
    });
    expect(judgeTransition(last({ level: 1 }), behind)).toEqual({
      action: 'record',
      reason: 'level-changed',
    });
  });

  it('accepts an observation at exactly the recorded time', () => {
    const same = report({ level: 0, observedAt: AT });
    expect(
      judgeTransition(last({ level: 1, observedAt: AT }), same).action,
    ).toBe('record');
  });
});

describe('resolveEnergised', () => {
  it('reads an active-LOW device', () => {
    expect(resolveEnergised(0, true, 0)).toBe(true);
    expect(resolveEnergised(1, true, 0)).toBe(false);
  });

  it('reads an active-HIGH device the other way round', () => {
    // BCM 26, the MH light, on the same box as four active-LOW channels.
    expect(resolveEnergised(1, true, 1)).toBe(true);
    expect(resolveEnergised(0, true, 1)).toBe(false);
  });

  it('is null when the level is unknown, never false', () => {
    expect(resolveEnergised(null, false, 0)).toBeNull();
  });

  it('is null when no device claims the pin', () => {
    expect(resolveEnergised(0, true, null)).toBeNull();
    expect(resolveEnergised(0, true, undefined)).toBeNull();
  });
});

describe('resolveRecordedAt', () => {
  const RECEIVED = new Date(AT.getTime() + 5_000);

  it("files a report under the node's own timestamp", () => {
    expect(resolveRecordedAt(last(), report(), RECEIVED)).toEqual(AT);
  });

  it('files a live report from a clock that is behind at receipt, keeping history in order', () => {
    const behind = report({ observedAt: new Date(AT.getTime() - 120_000) });
    expect(
      resolveRecordedAt(last({ observedAt: AT }), behind, RECEIVED),
    ).toEqual(RECEIVED);
  });

  it('keeps the first sight of a pin at its own timestamp', () => {
    expect(resolveRecordedAt(null, report(), RECEIVED)).toEqual(AT);
  });
});
