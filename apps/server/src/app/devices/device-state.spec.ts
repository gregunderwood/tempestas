import { canTurnOn, canTurnOnAt, isOn, type DeviceTimes } from './device-state';

const at = (iso: string) => new Date(iso);
const device = (p: Partial<DeviceTimes> = {}): DeviceTimes => ({
  onAt: null,
  offAt: null,
  onDelayDuration: 300,
  ...p,
});

describe('isOn', () => {
  it('is off when it has never been on', () => {
    expect(isOn(device())).toBe(false);
  });

  it('is on when it has an onAt and no offAt', () => {
    expect(isOn(device({ onAt: at('2026-01-10T10:00:00Z') }))).toBe(true);
  });

  it('is on when onAt is after offAt', () => {
    expect(
      isOn(
        device({
          onAt: at('2026-01-10T10:00:00Z'),
          offAt: at('2026-01-10T09:00:00Z'),
        }),
      ),
    ).toBe(true);
  });

  it('is off when onAt is before offAt', () => {
    expect(
      isOn(
        device({
          onAt: at('2026-01-10T09:00:00Z'),
          offAt: at('2026-01-10T10:00:00Z'),
        }),
      ),
    ).toBe(false);
  });

  it('treats an exact onAt === offAt tie as OFF, pinning the strict > in the original', () => {
    const t = at('2026-01-10T10:00:00Z');
    expect(isOn(device({ onAt: t, offAt: t }))).toBe(false);
  });
});

describe('canTurnOnAt', () => {
  it('returns null while the device is on', () => {
    expect(
      canTurnOnAt(device({ onAt: at('2026-01-10T10:00:00Z') })),
    ).toBeNull();
  });

  it('returns null when it has never been on', () => {
    expect(canTurnOnAt(device())).toBeNull();
  });

  it('returns offAt + onDelayDuration once it has cycled', () => {
    const d = device({
      onAt: at('2026-01-10T09:00:00Z'),
      offAt: at('2026-01-10T10:00:00Z'),
      onDelayDuration: 300,
    });
    expect(canTurnOnAt(d)?.toISOString()).toBe('2026-01-10T10:05:00.000Z');
  });
});

describe('canTurnOn', () => {
  it('is false while the device is on', () => {
    const d = device({ onAt: at('2026-01-10T10:00:00Z') });
    expect(canTurnOn(d, at('2026-01-10T12:00:00Z'))).toBe(false);
  });

  // The regression that would otherwise brick every newly created device.
  it('is TRUE for a device that has never been on, even at the exact same instant', () => {
    const now = at('2026-01-10T10:00:00Z');
    expect(canTurnOn(device(), now)).toBe(true);
  });

  it('is false while still inside the cooldown', () => {
    const d = device({
      onAt: at('2026-01-10T09:00:00Z'),
      offAt: at('2026-01-10T10:00:00Z'),
      onDelayDuration: 300,
    });
    expect(canTurnOn(d, at('2026-01-10T10:04:59Z'))).toBe(false);
  });

  it('is true at exactly offAt + delay, pinning the boundary', () => {
    const d = device({
      onAt: at('2026-01-10T09:00:00Z'),
      offAt: at('2026-01-10T10:00:00Z'),
      onDelayDuration: 300,
    });
    expect(canTurnOn(d, at('2026-01-10T10:05:00Z'))).toBe(true);
  });

  it('is true after the cooldown', () => {
    const d = device({
      onAt: at('2026-01-10T09:00:00Z'),
      offAt: at('2026-01-10T10:00:00Z'),
      onDelayDuration: 300,
    });
    expect(canTurnOn(d, at('2026-01-10T10:06:00Z'))).toBe(true);
  });

  it('allows an immediate restart when onDelayDuration is 0', () => {
    const d = device({
      onAt: at('2026-01-10T09:00:00Z'),
      offAt: at('2026-01-10T10:00:00Z'),
      onDelayDuration: 0,
    });
    expect(canTurnOn(d, at('2026-01-10T10:00:00Z'))).toBe(true);
  });

  it('does not throw when offAt is in the future (clock skew)', () => {
    const d = device({
      onAt: at('2026-01-10T09:00:00Z'),
      offAt: at('2026-01-10T23:00:00Z'),
      onDelayDuration: 300,
    });
    expect(canTurnOn(d, at('2026-01-10T10:00:00Z'))).toBe(false);
  });

  /**
   * America/Vancouver falls back at 2026-11-01T09:00:00Z: 01:59 PDT (-07:00) is
   * followed by 01:00 PST (-08:00). These two instants read the SAME wall clock
   * of 01:30 but are an hour apart in real time. Comparing instants, the 300s
   * cooldown has long expired. Comparing wall clocks, it would look like zero
   * elapsed time. This is the bug class the port exists to eliminate.
   */
  it('compares instants, not wall clocks, across a DST fall-back', () => {
    const offAtPdt = at('2026-11-01T08:30:00Z'); // 01:30:00 PDT
    const nowPst = at('2026-11-01T09:30:00Z'); //   01:30:00 PST, one hour later
    const d = device({
      onAt: at('2026-11-01T08:00:00Z'),
      offAt: offAtPdt,
      onDelayDuration: 300,
    });
    expect(nowPst.getTime() - offAtPdt.getTime()).toBe(3_600_000);
    expect(canTurnOn(d, nowPst)).toBe(true);
  });
});
