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
  appendDevicePush,
  recordDevicePush,
  type NumberedPush,
  type PushedDevice,
} from './device-pushes';

/**
 * The socket feed, as signals.
 *
 * socket.io rather than a raw WebSocket because a Pi on home WiFi needs
 * reconnection and an event envelope, and the old feed had neither.
 *
 * Note what is NOT here: device state is not treated as authoritative. It
 * arrives as a patch on top of what `GET /api/devices` said, because the server
 * derives `isOn` from timestamps and a socket message can always be missed.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService implements OnDestroy {
  /** Latest reading per sensor, keyed `node/sensor` - a node may carry several probes. */
  readonly readings = signal<Record<string, Reading>>({});
  readonly status = signal<SystemStatus | null>(null);
  readonly connected = signal(false);
  readonly reconnectCount = signal(0);
  readonly devicePushes = signal<ReadonlyMap<string, PushedDevice>>(new Map());
  /** Every push in arrival order, so two switches of one relay between reads are both seen. */
  readonly recentDevicePushes = signal<readonly NumberedPush[]>([]);
  readonly latestRulesCycle = signal<RulesCycle | null>(null);

  private socket?: Socket;
  private hasConnectedBefore = false;

  connect(): void {
    if (this.socket) {
      return;
    }
    this.socket = io({ transports: ['websocket', 'polling'] });

    this.socket.on('connect', () => this.recordConnect());
    this.socket.on('disconnect', () => this.connected.set(false));

    this.socket.on(REALTIME_EVENTS.readingLatest, (reading: Reading) => {
      this.readings.update((all) => ({
        ...all,
        [sensorKey(reading)]: reading,
      }));
    });
    this.socket.on(REALTIME_EVENTS.deviceState, (device: Device) => {
      const receivedAt = Date.now();
      this.devicePushes.update((pushes) =>
        recordDevicePush(pushes, device, receivedAt),
      );
      this.recentDevicePushes.update((recentPushes) =>
        appendDevicePush(recentPushes, { device, receivedAt }),
      );
    });
    this.socket.on(REALTIME_EVENTS.systemStatus, (status: SystemStatus) => {
      this.status.set(status);
      // The server forgets its cycle when it stops leading but sends no event saying so.
      if (status.isLeading === false) this.latestRulesCycle.set(null);
    });
    this.socket.on(REALTIME_EVENTS.rulesCycle, (cycle: RulesCycle) => {
      this.latestRulesCycle.set(cycle);
    });
  }

  private recordConnect(): void {
    if (this.hasConnectedBefore) {
      this.reconnectCount.update((count) => count + 1);
    }
    this.hasConnectedBefore = true;
    this.connected.set(true);
  }

  ngOnDestroy(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
