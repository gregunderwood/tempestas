import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  REALTIME_EVENTS,
  sensorKey,
  type Device,
  type Reading,
  type RulesTick,
  type SystemStatus,
} from '@tempestas/domain';

/**
 * Fan-out to browsers. Named events on one socket, and nothing else.
 *
 * socket.io rather than a raw `rxjs/webSocket`: the old feed had no event
 * envelope and no reconnect, and a Pi on home WiFi needs both. Named events let
 * one connection carry readings, device state and system status.
 *
 * This class holds no repository and makes no decision. It caches the last value
 * of each event purely so a browser that connects mid-cycle renders immediately
 * instead of showing an empty dashboard for ten seconds - which matters most for
 * `system:status`, since that is what raises the stale-sensor banner.
 */
@WebSocketGateway({
  cors: {
    origin: [
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
    ],
  },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server?: Server;

  private lastReadings = new Map<string, Reading>();
  private lastStatus: SystemStatus | null = null;
  private lastTick: RulesTick | null = null;
  private clients = 0;

  handleConnection(client: Socket): void {
    this.clients += 1;
    // Replay the current picture to this client only.
    for (const reading of this.lastReadings.values()) {
      client.emit(REALTIME_EVENTS.readingLatest, reading);
    }
    if (this.lastStatus) {
      client.emit(REALTIME_EVENTS.systemStatus, this.lastStatus);
    }
    if (this.lastTick) {
      client.emit(REALTIME_EVENTS.rulesEvaluation, this.lastTick);
    }
    this.logger.debug(`Client connected (${this.clients} total)`);
  }

  handleDisconnect(): void {
    this.clients = Math.max(0, this.clients - 1);
    this.logger.debug(`Client disconnected (${this.clients} remaining)`);
  }

  publishReading(reading: Reading): void {
    // Keyed per sensor: replayed by node, a newly opened dashboard would see one
    // probe per node until the others next spoke.
    this.lastReadings.set(sensorKey(reading), reading);
    this.emit(REALTIME_EVENTS.readingLatest, reading);
  }

  publishDeviceState(device: Device): void {
    // Deliberately not cached: device state is authoritative from
    // `GET /api/devices`, and a cached copy replayed on connect could contradict
    // it. A client renders devices from the API and patches them from here.
    this.emit(REALTIME_EVENTS.deviceState, device);
  }

  publishSystemStatus(status: SystemStatus): void {
    this.lastStatus = status;
    this.emit(REALTIME_EVENTS.systemStatus, status);
  }

  /**
   * Cached and replayed, unlike device state: a rules cycle is a snapshot that
   * the next one wholly replaces. A server that stops evaluating (demoted to
   * follower) clears it, so a replayed copy is never older than the loop.
   */
  publishRulesTick(tick: RulesTick): void {
    this.lastTick = tick;
    this.emit(REALTIME_EVENTS.rulesEvaluation, tick);
  }

  /** Stop replaying a cycle this server no longer stands behind. */
  clearRulesTick(): void {
    this.lastTick = null;
  }

  connectedClients(): number {
    return this.clients;
  }

  /**
   * A socket failure must never propagate into the caller. Every publisher here
   * is mid-way through something that matters more than the dashboard - an
   * ingest, a relay write, a rules evaluation - and none of them should fail
   * because a browser went away.
   */
  private emit(event: string, payload: unknown): void {
    try {
      this.server?.emit(event, payload);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to emit ${event}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
