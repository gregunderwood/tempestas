import { describe, expect, it } from 'vitest';
import type { Device } from '@tempestas/domain';
import { recordDevicePush, type PushedDevice } from './device-pushes';
import { applyNewerPushes, findNewestUnlistedPushAt } from './live-devices';

const device = (id: string, isOn: boolean): Device =>
  ({ id, name: id, isOn }) as Device;

function pushesOf(
  ...pushes: [Device, number][]
): ReadonlyMap<string, PushedDevice> {
  return pushes.reduce(
    (recorded, [pushedDevice, receivedAt]) =>
      recordDevicePush(recorded, pushedDevice, receivedAt),
    new Map<string, PushedDevice>() as ReadonlyMap<string, PushedDevice>,
  );
}

const isOnOf = (devices: Device[]): boolean[] =>
  devices.map((merged) => merged.isOn);

describe('applyNewerPushes', () => {
  const fetched = {
    payload: [device('heater', false), device('tape', false)],
    requestedAt: 1_000,
  };

  it('applies a push for every device, not only the newest push', () => {
    const merged = applyNewerPushes(
      fetched,
      pushesOf([device('heater', true), 2_000], [device('tape', true), 2_001]),
    );
    expect(isOnOf(merged)).toEqual([true, true]);
  });

  it('keeps a push received after the request was sent', () => {
    const merged = applyNewerPushes(
      fetched,
      pushesOf([device('heater', true), 1_001]),
    );
    expect(isOnOf(merged)).toEqual([true, false]);
  });

  it('keeps a push received in the same millisecond the request was sent', () => {
    const merged = applyNewerPushes(
      fetched,
      pushesOf([device('heater', true), 1_000]),
    );
    expect(isOnOf(merged)).toEqual([true, false]);
  });

  it('has no devices before the first response', () => {
    expect(applyNewerPushes(null, pushesOf())).toEqual([]);
  });

  it('lets a later fetch win over an older push', () => {
    const merged = applyNewerPushes(
      { ...fetched, requestedAt: 5_000 },
      pushesOf([device('heater', true), 2_000]),
    );
    expect(isOnOf(merged)).toEqual([false, false]);
  });

  it('ignores a push for a device the fetch does not list', () => {
    const merged = applyNewerPushes(
      fetched,
      pushesOf([device('ghost', true), 9_000]),
    );
    expect(merged).toEqual(fetched.payload);
  });
});

describe('findNewestUnlistedPushAt', () => {
  const fetched = { payload: [device('heater', false)], requestedAt: 1_000 };

  it('asks for a refetch when a device added after the fetch is pushed', () => {
    expect(
      findNewestUnlistedPushAt(
        fetched,
        pushesOf([device('fan', false), 2_000]),
      ),
    ).toBe(2_000);
  });

  it('does not ask again once a later fetch has been sent', () => {
    expect(
      findNewestUnlistedPushAt(
        { ...fetched, requestedAt: 3_000 },
        pushesOf([device('fan', false), 2_000]),
      ),
    ).toBeNull();
  });

  it('does not ask for a push about a device already listed', () => {
    expect(
      findNewestUnlistedPushAt(
        fetched,
        pushesOf([device('heater', true), 2_000]),
      ),
    ).toBeNull();
  });

  it('waits for the first fetch', () => {
    expect(
      findNewestUnlistedPushAt(null, pushesOf([device('fan', false), 2_000])),
    ).toBeNull();
  });
});
