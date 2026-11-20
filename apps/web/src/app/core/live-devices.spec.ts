import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import type { Device } from '@tempestas/domain';
import { fakeRealtime } from '../testing/fake-realtime';
import { ApiService } from './api.service';
import { recordDevicePush, type PushedDevice } from './device-pushes';
import {
  applyNewerPushes,
  injectLiveDevices,
  keepNewerFetch,
} from './live-devices';
import { RealtimeService } from './realtime.service';

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
    devices: [device('heater', false), device('tape', false)],
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
      pushesOf([device('heater', true), 1_000]),
    );
    expect(isOnOf(merged)).toEqual([true, false]);
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
    expect(merged).toEqual(fetched.devices);
  });
});

describe('keepNewerFetch', () => {
  const older = { devices: [device('heater', false)], requestedAt: 1_000 };
  const newer = { devices: [device('heater', true)], requestedAt: 2_000 };

  it('ignores a response to an older request that arrives last', () => {
    expect(keepNewerFetch(newer, older)).toBe(newer);
    expect(keepNewerFetch(older, newer)).toBe(newer);
  });
});

describe('injectLiveDevices', () => {
  it('fetches the devices again every time the socket reconnects', () => {
    const fetchDevices = vi.fn(() => of([device('heater', false)]));
    const realtime = fakeRealtime();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { devices: fetchDevices } },
        { provide: RealtimeService, useValue: realtime },
      ],
    });
    TestBed.runInInjectionContext(() => injectLiveDevices());
    TestBed.tick();
    expect(fetchDevices).toHaveBeenCalledTimes(1);

    realtime.connectionCount.update((count) => count + 1);
    TestBed.tick();
    expect(fetchDevices).toHaveBeenCalledTimes(2);
  });
});
