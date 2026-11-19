import { describe, expect, it } from 'vitest';
import type { PinStateReport } from '../hardware/hardware.service';
import {
  energisedBy,
  judgeTransition,
  recordedAt,
  type LastKnown,
} from './pin-transition';

const AT = new Date('2026-09-10T18:03:00Z');

function report(over: Partial<PinStateReport> = {}): PinStateReport {
  return {
    nodeId: 'elantris',
    pin: 5,
    level: 0,
    known: true,
    observedAt: AT,
    live: true,
    ...over,
  };
}

function last(over: Partial<LastKnown> = {}): LastKnown {
  return {
    level: 1,
    known: true,
    observedAt: new Date(AT.getTime() - 60_000),
    ...over,
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
    // THE case this exists for: retained gpio/state is republished on every
    // reconnect. Logging those would fill the record with transitions where no
    // relay moved, and the whole point of the log is fitting against real ones.
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
    // A reconnect replays retained state, and QoS 1 permits redelivery. An
    // older observation overwriting a newer one would invent a transition that
    // ran backwards in time.
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

  // patji, 2026-11-18: rebooted with its clock 3.5 min slow, failed safe, and
  // its live report was dated before the last commanded change. Skipping it
  // erased the one transition that mattered.
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

describe('energisedBy', () => {
  it('reads an active-LOW device', () => {
    expect(energisedBy(0, true, 0)).toBe(true);
    expect(energisedBy(1, true, 0)).toBe(false);
  });

  it('reads an active-HIGH device the other way round', () => {
    // BCM 26, the MH light, on the same box as four active-LOW channels.
    expect(energisedBy(1, true, 1)).toBe(true);
    expect(energisedBy(0, true, 1)).toBe(false);
  });

  it('is null when the level is unknown, never false', () => {
    expect(energisedBy(null, false, 0)).toBeNull();
  });

  it('is null when no device claims the pin', () => {
    expect(energisedBy(0, true, null)).toBeNull();
    expect(energisedBy(0, true, undefined)).toBeNull();
  });
});

describe('recordedAt', () => {
  const RECEIVED = new Date(AT.getTime() + 5_000);

  it("files a report under the node's own timestamp", () => {
    expect(recordedAt(last(), report(), RECEIVED)).toEqual(AT);
  });

  it('files a live report from a clock that is behind at receipt, keeping history in order', () => {
    const behind = report({ observedAt: new Date(AT.getTime() - 120_000) });
    expect(recordedAt(last({ observedAt: AT }), behind, RECEIVED)).toEqual(
      RECEIVED,
    );
  });

  it('keeps the first sight of a pin at its own timestamp', () => {
    expect(recordedAt(null, report(), RECEIVED)).toEqual(AT);
  });
});
