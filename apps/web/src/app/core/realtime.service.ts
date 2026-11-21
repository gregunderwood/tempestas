import { Injectable, OnDestroy, signal } from '@angular/core';
import { io, type Socket } from 'socket.io-client';
import {
  REALTIME_EVENTS,
  sensorKey,
  type Device,
  type Reading,
  type RulesCycle,
  type SystemStatus,
} from '@tempestas/domain';
import {
  storeDevicePush,
  type NumberedPush,
  type PushedDevice,
} from './device-pushes';

const SOCKET_TRANSPORTS = ['websocket', 'polling'];

// Network delay makes this read slightly low, which ages a timestamp by milliseconds too few.
export function measureServerClockOffset(
  status: SystemStatus,
  receivedAt: number,
): number {
  const offset = Date.parse(status.sentAt) - receivedAt;
  // A status without a readable sentAt would make every age NaN and silence the stall alert.
  return Number.isFinite(offset) ? offset : 0;
}

// Device state arrives as a patch on what the API said, since a socket message can always be missed.
@Injectable({ providedIn: 'root' })
export class RealtimeService implements OnDestroy {
  readonly readings = signal<Record<string, Reading>>({});
  readonly status = signal<SystemStatus | null>(null);
  readonly connected = signal(false);
  readonly reconnectCount = signal(0);
  readonly devicePushes = signal<ReadonlyMap<string, PushedDevice>>(new Map());
  // Every push in arrival order, so two switches of one relay between reads are both seen.
  readonly recentDevicePushes = signal<readonly NumberedPush[]>([]);
  readonly latestRulesCycle = signal<RulesCycle | null>(null);
  readonly serverClockOffsetMilliseconds = signal(0);

  private socket?: Socket;
  private hasConnectedBefore = false;

  connect(): void {
    if (this.socket) return;
    const socket = io({ transports: SOCKET_TRANSPORTS });
    this.socket = socket;

    socket.on('connect', () => this.recordConnect());
    socket.on('disconnect', () => this.connected.set(false));
    socket.on(REALTIME_EVENTS.readingLatest, (reading: Reading) =>
      this.recordReading(reading),
    );
    socket.on(REALTIME_EVENTS.deviceState, (device: Device) =>
      storeDevicePush(this, device, Date.now()),
    );
    socket.on(REALTIME_EVENTS.systemStatus, (status: SystemStatus) =>
      this.recordStatus(status),
    );
    socket.on(REALTIME_EVENTS.rulesCycle, (cycle: RulesCycle) =>
      this.latestRulesCycle.set(cycle),
    );
  }

  ngOnDestroy(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private recordConnect(): void {
    if (this.hasConnectedBefore) {
      this.reconnectCount.update((count) => count + 1);
    }
    this.hasConnectedBefore = true;
    this.connected.set(true);
  }

  private recordReading(reading: Reading): void {
    this.readings.update((readings) => ({
      ...readings,
      [sensorKey(reading)]: reading,
    }));
  }

  private recordStatus(status: SystemStatus): void {
    this.status.set(status);
    this.serverClockOffsetMilliseconds.set(
      measureServerClockOffset(status, Date.now()),
    );
    // The server forgets its cycle when it stops leading but sends no event saying so.
    if (status.isLeading === false) this.latestRulesCycle.set(null);
  }
}
