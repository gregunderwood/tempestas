import { isOn } from './device-state';
import {
  correctionPatch,
  reconcileNewMapping,
  reconcilePinState,
  type PinObservation,
  type ReconcileTarget,
} from './reconcile-pin-state';

const instant = (iso: string) => new Date(iso);
const NOW = instant('2026-09-10T21:00:00Z');

// Active-LOW relay: 0 is energised. Same as every relay on the real panel.
function device(overrides: Partial<ReconcileTarget> = {}): ReconcileTarget {
  return {
    onAt: null,
    offAt: null,
    onDelayDuration: 300,
    onLevel: 0,
    ...overrides,
  };
}

function seen(
  level: 0 | 1 | null,
  observedAt: Date,
  known = level !== null,
  live = false,
): PinObservation {
  return { level, known, observedAt, live };
}

describe('reconcilePinState', () => {
  // Seen end to end: the node failed safe on the last will while the row still said on.
  it('corrects a row that claims on when the hardware reports de-energised', () => {
    const verdict = reconcilePinState(
      device({ onAt: instant('2026-09-10T20:20:00Z') }),
      seen(1, instant('2026-09-10T20:50:00Z')),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'correct', hardwareOn: false });
  });

  it('corrects a row that claims off when the hardware reports energised', () => {
    const verdict = reconcilePinState(
      device({
        onAt: instant('2026-09-10T19:00:00Z'),
        offAt: instant('2026-09-10T20:00:00Z'),
      }),
      seen(0, instant('2026-09-10T20:30:00Z')),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'correct', hardwareOn: true });
  });

  it('does nothing when they already agree', () => {
    const verdict = reconcilePinState(
      device({ onAt: instant('2026-09-10T20:20:00Z') }),
      seen(0, instant('2026-09-10T20:50:00Z')),
      NOW,
    );
    expect(verdict.action).toBe('none');
  });

  // Unknown is not off.
  it('refuses to act on an unknown level', () => {
    const verdict = reconcilePinState(
      device({ onAt: instant('2026-09-10T20:20:00Z') }),
      seen(null, instant('2026-09-10T20:50:00Z'), false),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'none', reason: /unknown/ });
  });

  // A retained replay predating our command would undo a command that succeeded.
  it('ignores an observation older than the row', () => {
    const verdict = reconcilePinState(
      device({ onAt: instant('2026-09-10T20:55:00Z') }),
      seen(1, instant('2026-09-10T20:30:00Z')),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'none', reason: /at least as/ });
  });

  it('ignores an observation exactly as old as the row', () => {
    const at = instant('2026-09-10T20:55:00Z');
    const verdict = reconcilePinState(device({ onAt: at }), seen(1, at), NOW);
    expect(verdict.action).toBe('none');
  });

  // Unclamped, a fast node clock parks the cooldown in the future.
  it('clamps a forward-dated observation to now', () => {
    const verdict = reconcilePinState(
      device({ onAt: instant('2026-09-10T20:20:00Z') }),
      seen(1, instant('2026-09-10T23:00:00Z')),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'correct' });
    expect((verdict as { at: Date }).at).toEqual(NOW);
  });

  // Polarity is per device: the Single Light is active-HIGH, the rest active-LOW.
  it('reads onLevel rather than assuming active-LOW', () => {
    const verdict = reconcilePinState(
      device({ onLevel: 1, onAt: instant('2026-09-10T20:20:00Z') }),
      seen(1, instant('2026-09-10T20:50:00Z')),
      NOW,
    );
    expect(verdict.action).toBe('none'); // level 1 IS on here
  });
});

describe('correctionPatch', () => {
  // The audit trail: turning off records when the relay opened and leaves `onAt` alone.
  it('writes offAt and never touches onAt when the hardware is off', () => {
    const at = instant('2026-09-10T20:50:00Z');
    expect(
      correctionPatch({
        action: 'correct',
        hardwareOn: false,
        at,
        reason: 'x',
      }),
    ).toEqual({ offAt: at });
  });

  it('writes onAt when the hardware is on', () => {
    const at = instant('2026-09-10T20:50:00Z');
    expect(
      correctionPatch({ action: 'correct', hardwareOn: true, at, reason: 'x' }),
    ).toEqual({ onAt: at });
  });

  // The ordering guard means a patch always flips the derived state.
  it('applying a correction flips isOn, given the ordering guard', () => {
    const row = device({ onAt: instant('2026-09-10T20:20:00Z') });
    expect(isOn(row)).toBe(true);
    const verdict = reconcilePinState(
      row,
      seen(1, instant('2026-09-10T20:50:00Z')),
      NOW,
    );
    expect(isOn({ ...row, ...correctionPatch(verdict as never) })).toBe(false);
  });
});

// patji, 2026-11-18: rebooted 3.5 min slow, and its failsafe report predated the last "off".
describe('reconcilePinState with a node clock that is behind', () => {
  const lastOff = instant('2026-09-10T20:58:00Z');
  const row = () =>
    device({
      onLevel: 1,
      onAt: instant('2026-09-10T20:30:00Z'),
      offAt: lastOff,
    });
  const slow = instant('2026-09-10T20:57:00Z');

  it('believes a LIVE report dated before the row, and dates it at receipt', () => {
    const verdict = reconcilePinState(row(), seen(1, slow, true, true), NOW);
    expect(verdict).toMatchObject({
      action: 'correct',
      hardwareOn: true,
      at: NOW,
    });
    if (verdict.action !== 'correct') throw new Error('unreachable');
    expect(isOn({ ...row(), ...correctionPatch(verdict) })).toBe(true);
  });

  it('still ignores a retained replay dated before the row', () => {
    expect(
      reconcilePinState(row(), seen(1, slow, true, false), NOW),
    ).toMatchObject({
      action: 'none',
    });
  });

  it('does nothing for a live report that agrees with the row', () => {
    expect(
      reconcilePinState(row(), seen(0, slow, true, true), NOW),
    ).toMatchObject({
      action: 'none',
      reason: 'hardware and the row agree',
    });
  });
});

describe('reconcileNewMapping', () => {
  const turnedOffAt = instant('2026-09-10T20:30:00Z');
  const offRow = () =>
    device({ onAt: instant('2026-09-10T20:00:00Z'), offAt: turnedOffAt });

  // The on level flipped after a restart: the retained replay predates the row's own offAt.
  it('believes a retained replay older than the row, and dates the turn-on after offAt', () => {
    const verdict = reconcileNewMapping(
      { ...offRow(), onLevel: 1 },
      seen(1, instant('2026-09-10T20:29:59Z')),
      NOW,
    );
    expect(verdict).toMatchObject({
      action: 'correct',
      hardwareOn: true,
      at: NOW,
    });
    if (verdict.action !== 'correct') throw new Error('unreachable');
    expect(isOn({ ...offRow(), ...correctionPatch(verdict) })).toBe(true);
  });

  it('keeps the node timestamp when the replay is newer than the row', () => {
    const observedAt = instant('2026-09-10T20:45:00Z');
    const verdict = reconcileNewMapping(
      { ...offRow(), onLevel: 1 },
      seen(1, observedAt),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'correct', at: observedAt });
  });

  it('changes nothing when the level is unknown', () => {
    const verdict = reconcileNewMapping(
      offRow(),
      seen(null, instant('2026-09-10T20:45:00Z')),
      NOW,
    );
    expect(verdict.action).toBe('none');
  });
});
