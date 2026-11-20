import { signal } from '@angular/core';
import type {
  Device,
  Reading,
  RulesCycle,
  SystemStatus,
} from '@tempestas/domain';
import { recordDevicePush, type PushedDevice } from '../core/live-devices';
import type { RealtimeService } from '../core/realtime.service';

export type FakeRealtime = Pick<
  RealtimeService,
  'readings' | 'status' | 'connected' | 'devicePushes' | 'rulesCycle'
>;

export function fakeRealtime(
  overrides: Partial<FakeRealtime> = {},
): FakeRealtime {
  return {
    readings: signal<Record<string, Reading>>({}),
    status: signal<SystemStatus | null>(null),
    connected: signal(true),
    devicePushes: signal<ReadonlyMap<string, PushedDevice>>(new Map()),
    rulesCycle: signal<RulesCycle | null>(null),
    ...overrides,
  };
}

export function pushDevice(realtime: FakeRealtime, device: Device): void {
  realtime.devicePushes.update((pushes) =>
    recordDevicePush(pushes, device, Date.now()),
  );
}
