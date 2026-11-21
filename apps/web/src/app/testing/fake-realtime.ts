import { signal } from '@angular/core';
import type {
  Device,
  Reading,
  RulesCycle,
  SystemStatus,
} from '@tempestas/domain';
import {
  appendDevicePush,
  recordDevicePush,
  type NumberedPush,
  type PushedDevice,
} from '../core/device-pushes';
import type { RealtimeService } from '../core/realtime.service';

export type FakeRealtime = Pick<
  RealtimeService,
  | 'readings'
  | 'status'
  | 'connected'
  | 'reconnectCount'
  | 'devicePushes'
  | 'recentDevicePushes'
  | 'latestRulesCycle'
>;

export function fakeRealtime(
  overrides: Partial<FakeRealtime> = {},
): FakeRealtime {
  return {
    readings: signal<Record<string, Reading>>({}),
    status: signal<SystemStatus | null>(null),
    connected: signal(true),
    reconnectCount: signal(0),
    devicePushes: signal<ReadonlyMap<string, PushedDevice>>(new Map()),
    recentDevicePushes: signal<readonly NumberedPush[]>([]),
    latestRulesCycle: signal<RulesCycle | null>(null),
    ...overrides,
  };
}

export function pushDevice(realtime: FakeRealtime, device: Device): void {
  const receivedAt = Date.now();
  realtime.devicePushes.update((pushes) =>
    recordDevicePush(pushes, device, receivedAt),
  );
  realtime.recentDevicePushes.update((recentPushes) =>
    appendDevicePush(recentPushes, { device, receivedAt }),
  );
}
