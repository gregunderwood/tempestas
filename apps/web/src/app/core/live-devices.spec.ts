import { describe, expect, it } from 'vitest';
import type { Device } from '@tempestas/domain';
import { withPushes, type PushedDevice } from './device-pushes';

const device = (id: string, isOn: boolean): Device =>
  ({ id, name: id, isOn }) as Device;

const pushes = (...p: [Device, number][]): Map<string, PushedDevice> =>
  new Map(p.map(([d, receivedAt]) => [d.id, { device: d, receivedAt }]));

describe('withPushes', () => {
  const fetched = {
    devices: [device('heater', false), device('tape', false)],
    requestedAt: 1_000,
  };

  // One rules decision switches two devices: both pushes must survive, not
  // only the newest (#12).
  it('applies every push, not only the newest', () => {
    const out = withPushes(
      fetched,
      pushes([device('heater', true), 2_000], [device('tape', true), 2_001]),
    );
    expect(out.map((d) => d.isOn)).toEqual([true, true]);
  });

  // A push that arrived after the request left is at least as new as the
  // response, so the response must not overwrite it.
  it('keeps a push received after the request was sent', () => {
    const out = withPushes(fetched, pushes([device('heater', true), 1_000]));
    expect(out[0].isOn).toBe(true);
  });

  it('lets a later fetch win over an older push', () => {
    const out = withPushes(
      { ...fetched, requestedAt: 5_000 },
      pushes([device('heater', true), 2_000]),
    );
    expect(out[0].isOn).toBe(false);
  });

  it('ignores a push for a device the fetch does not list', () => {
    expect(withPushes(fetched, pushes([device('ghost', true), 9_000]))).toEqual(
      fetched.devices,
    );
  });
});
