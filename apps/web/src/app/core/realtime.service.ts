import { Injectable, OnDestroy, signal } from '@angular/core';
import { io, type Socket } from 'socket.io-client';
import {
  REALTIME_EVENTS,
  sensorKey,
  type Device,
  type Reading,
  type RulesTick,
  type SystemStatus,
} from '@tempestas/domain';

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
  /** The most recent device state pushed, for a screen to merge in. */
  readonly deviceState = signal<Device | null>(null);
  /** The newest rules cycle - every zone's inputs and decisions. Replayed on connect. */
  readonly rulesTick = signal<RulesTick | null>(null);

  private socket?: Socket;

  connect(): void {
    if (this.socket) {
      return;
    }
    this.socket = io({ transports: ['websocket', 'polling'] });

    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));

    this.socket.on(REALTIME_EVENTS.readingLatest, (reading: Reading) => {
      this.readings.update((all) => ({
        ...all,
        [sensorKey(reading)]: reading,
      }));
    });
    this.socket.on(REALTIME_EVENTS.deviceState, (device: Device) => {
      this.deviceState.set(device);
    });
    this.socket.on(REALTIME_EVENTS.systemStatus, (status: SystemStatus) => {
      this.status.set(status);
    });
    this.socket.on(REALTIME_EVENTS.rulesEvaluation, (tick: RulesTick) => {
      this.rulesTick.set(tick);
    });
  }

  ngOnDestroy(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
