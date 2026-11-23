import { signal } from '@angular/core';
import type {
  Device,
  Node,
  Reading,
  RulesCycle,
  SystemStatus,
} from '@tempestas/domain';
import {
  storeDevicePush,
  type NumberedPush,
  type PushedDevice,
} from '../core/device-pushes';
import { recordNodePush, type PushedNode } from '../core/node-pushes';
import type { RealtimeService } from '../core/realtime.service';

export type FakeRealtime = Pick<
  RealtimeService,
  | 'readings'
  | 'status'
  | 'connected'
  | 'reconnectCount'
  | 'devicePushes'
  | 'recentDevicePushes'
  | 'nodePushes'
  | 'latestRulesCycle'
  | 'serverClockOffsetMilliseconds'
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
    nodePushes: signal<ReadonlyMap<string, PushedNode>>(new Map()),
    latestRulesCycle: signal<RulesCycle | null>(null),
    serverClockOffsetMilliseconds: signal(0),
    ...overrides,
  };
}

export function pushDevice(realtime: FakeRealtime, device: Device): void {
  storeDevicePush(realtime, device, Date.now());
}

export function pushNode(realtime: FakeRealtime, node: Node): void {
  realtime.nodePushes.update((pushes) =>
    recordNodePush(pushes, node, Date.now()),
  );
}
