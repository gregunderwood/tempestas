import { signal } from '@angular/core';
import type {
  Device,
  Reading,
  RulesCycle,
  SystemStatus,
} from '@tempestas/domain';
import { recordDevicePush, type PushedDevice } from '../core/device-pushes';
import type { RealtimeService } from '../core/realtime.service';

export type FakeRealtime = Pick<
  RealtimeService,
  | 'readings'
  | 'status'
  | 'connected'
  | 'connectionCount'
  | 'devicePushes'
  | 'latestRulesCycle'
>;

export function fakeRealtime(
  overrides: Partial<FakeRealtime> = {},
): FakeRealtime {
  return {
    readings: signal<Record<string, Reading>>({}),
    status: signal<SystemStatus | null>(null),
    connected: signal(true),
    connectionCount: signal(1),
    devicePushes: signal<ReadonlyMap<string, PushedDevice>>(new Map()),
    latestRulesCycle: signal<RulesCycle | null>(null),
    ...overrides,
  };
}

export function pushDevice(realtime: FakeRealtime, device: Device): void {
  realtime.devicePushes.update((pushes) =>
    recordDevicePush(pushes, device, Date.now()),
  );
}
