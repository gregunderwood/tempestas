import { isOn } from './device-state';
import {
  correctionPatch,
  reconcilePinState,
  type PinObservation,
  type ReconcileTarget,
} from './reconcile-pin-state';

const T = (iso: string) => new Date(iso);
const NOW = T('2026-09-10T21:00:00Z');

// Active-LOW relay: 0 is energised. Same as every relay on the real panel.
function device(over: Partial<ReconcileTarget> = {}): ReconcileTarget {
  return {
    onAt: null,
    offAt: null,
    onDelayDuration: 300,
    onLevel: 0,
    ...over,
  };
}

function seen(
  level: 0 | 1 | null,
  observedAt: Date,
  known = level !== null,
): PinObservation {
  return { level, known, observedAt };
}

describe('reconcilePinState', () => {
  // The exact failure seen end to end: the node failed safe on the controller's
  // last will, the relay opened, and the row still said the burner was running.
  it('corrects a row that claims on when the hardware reports de-energised', () => {
    const verdict = reconcilePinState(
      device({ onAt: T('2026-09-10T20:20:00Z') }),
      seen(1, T('2026-09-10T20:50:00Z')),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'correct', hardwareOn: false });
  });

  it('corrects a row that claims off when the hardware reports energised', () => {
    const verdict = reconcilePinState(
      device({
        onAt: T('2026-09-10T19:00:00Z'),
        offAt: T('2026-09-10T20:00:00Z'),
      }),
      seen(0, T('2026-09-10T20:30:00Z')),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'correct', hardwareOn: true });
  });

  it('does nothing when they already agree', () => {
    const verdict = reconcilePinState(
      device({ onAt: T('2026-09-10T20:20:00Z') }),
      seen(0, T('2026-09-10T20:50:00Z')),
      NOW,
    );
    expect(verdict.action).toBe('none');
  });

  // Unknown is not off. Reporting a burner relay as off because a node cannot
  // read its pad is the lie the `known` flag exists to prevent.
  it('refuses to act on an unknown level', () => {
    const verdict = reconcilePinState(
      device({ onAt: T('2026-09-10T20:20:00Z') }),
      seen(null, T('2026-09-10T20:50:00Z'), false),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'none', reason: /unknown/ });
  });

  // `gpio/state` is retained, so a controller gets one replayed on subscribe.
  // If we have commanded the pin since the node published it, ours is newer and
  // believing the retained value would undo a command that succeeded.
  it('ignores an observation older than the row', () => {
    const verdict = reconcilePinState(
      device({ onAt: T('2026-09-10T20:55:00Z') }),
      seen(1, T('2026-09-10T20:30:00Z')),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'none', reason: /at least as/ });
  });

  it('ignores an observation exactly as old as the row', () => {
    const at = T('2026-09-10T20:55:00Z');
    const verdict = reconcilePinState(device({ onAt: at }), seen(1, at), NOW);
    expect(verdict.action).toBe('none');
  });

  // A node's clock can run ahead. Left unclamped, a skewed timestamp parks the
  // cooldown in the future and locks the heater out for as long as the skew.
  it('clamps a forward-dated observation to now', () => {
    const verdict = reconcilePinState(
      device({ onAt: T('2026-09-10T20:20:00Z') }),
      seen(1, T('2026-09-10T23:00:00Z')),
      NOW,
    );
    expect(verdict).toMatchObject({ action: 'correct' });
    expect((verdict as { at: Date }).at).toEqual(NOW);
  });

  // Polarity is per device: the greenhouse's Single Light is active-HIGH while
  // every relay on elantris is active-LOW, so `onLevel` decides, not the level.
  it('reads onLevel rather than assuming active-LOW', () => {
    const verdict = reconcilePinState(
      device({ onLevel: 1, onAt: T('2026-09-10T20:20:00Z') }),
      seen(1, T('2026-09-10T20:50:00Z')),
      NOW,
    );
    expect(verdict.action).toBe('none'); // level 1 IS on here
  });
});

describe('correctionPatch', () => {
  // The audit trail: turning a device off records when the relay really opened
  // and leaves `onAt` alone, so the minimum-off window runs from the true off
  // moment and is never shorter than reality.
  it('writes offAt and never touches onAt when the hardware is off', () => {
    const at = T('2026-09-10T20:50:00Z');
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
    const at = T('2026-09-10T20:50:00Z');
    expect(
      correctionPatch({ action: 'correct', hardwareOn: true, at, reason: 'x' }),
    ).toEqual({ onAt: at });
  });

  // The ordering guard in reconcilePinState guarantees the observation is newer
  // than every timestamp on the row, so applying the patch always flips the
  // derived state. This pins that the two functions agree about it.
  it('applying a correction flips isOn, given the ordering guard', () => {
    const row = device({ onAt: T('2026-09-10T20:20:00Z') });
    expect(isOn(row)).toBe(true);
    const verdict = reconcilePinState(
      row,
      seen(1, T('2026-09-10T20:50:00Z')),
      NOW,
    );
    expect(isOn({ ...row, ...correctionPatch(verdict as never) })).toBe(false);
  });
});
