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
  type RulesCycle,
  type SystemStatus,
  type UnsentSystemStatus,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { describeError } from '../common/describe-error';
import { LAN_ORIGINS } from '../common/lan-origins';

@WebSocketGateway({ cors: { origin: LAN_ORIGINS } })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server?: Server;

  // Per sensor: replayed per node, a new dashboard would show one probe per node until the others spoke.
  private lastReadingBySensor = new Map<string, Reading>();
  private lastStatus: UnsentSystemStatus | null = null;
  private latestRulesCycle: RulesCycle | null = null;
  private connectedClientCount = 0;

  constructor(private readonly clock: Clock) {}

  handleConnection(client: Socket): void {
    this.connectedClientCount += 1;
    this.replayCurrentPicture(client);
    this.logger.debug(`Client connected (${this.connectedClientCount} total)`);
  }

  handleDisconnect(): void {
    this.connectedClientCount = Math.max(0, this.connectedClientCount - 1);
    this.logger.debug(
      `Client disconnected (${this.connectedClientCount} remaining)`,
    );
  }

  publishReading(reading: Reading): void {
    this.lastReadingBySensor.set(sensorKey(reading), reading);
    this.emit(REALTIME_EVENTS.readingLatest, reading);
  }

  // Not cached: GET /api/devices is authoritative, and a replayed copy could contradict it.
  publishDeviceState(device: Device): void {
    this.emit(REALTIME_EVENTS.deviceState, device);
  }

  publishSystemStatus(status: UnsentSystemStatus): void {
    this.lastStatus = status;
    this.emit(REALTIME_EVENTS.systemStatus, this.stampSentAt(status));
  }

  publishRulesCycle(cycle: RulesCycle): void {
    this.latestRulesCycle = cycle;
    this.emit(REALTIME_EVENTS.rulesCycle, cycle);
  }

  forgetRulesCycle(): void {
    this.latestRulesCycle = null;
  }

  connectedClients(): number {
    return this.connectedClientCount;
  }

  private replayCurrentPicture(client: Socket): void {
    for (const reading of this.lastReadingBySensor.values()) {
      client.emit(REALTIME_EVENTS.readingLatest, reading);
    }
    if (this.lastStatus) {
      client.emit(
        REALTIME_EVENTS.systemStatus,
        this.stampSentAt(this.lastStatus),
      );
    }
    if (this.latestRulesCycle) {
      client.emit(REALTIME_EVENTS.rulesCycle, this.latestRulesCycle);
    }
  }

  private stampSentAt(status: UnsentSystemStatus): SystemStatus {
    return { ...status, sentAt: this.clock.now().toISOString() };
  }

  // Never throws: every caller is mid-way through an ingest, a relay write or an evaluation.
  private emit(event: string, payload: unknown): void {
    try {
      this.server?.emit(event, payload);
    } catch (error: unknown) {
      this.logger.warn(`Failed to emit ${event}: ${describeError(error)}`);
    }
  }
}
