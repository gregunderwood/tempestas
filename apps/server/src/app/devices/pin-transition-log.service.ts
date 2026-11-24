import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import {
  HardwareService,
  type NodeAvailability,
  type PinStateReport,
} from '../hardware/hardware.service';
import { toPinKey } from '../hardware/pin-key';
import { DeviceEntity, PinTransitionEntity } from './models';
import { Clock } from '../common/clock';
import {
  judgeTransition,
  resolveEnergised,
  resolveRecordedAt,
  type LastKnown,
  type TransitionReason,
} from './pin-transition';
import { findDeviceOnPin } from './find-device-on-pin';

const DEFAULT_QUERY_LIMIT = 1000;
const MAX_QUERY_LIMIT = 10_000;

export interface TransitionQuery {
  from?: Date;
  to?: Date;
  nodeId?: string;
  limit?: number;
}

// Its own subscription: reconciliation skips commanded changes. See docs/Infrastructure/Database.md
@Injectable()
export class PinTransitionLog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PinTransitionLog.name);
  private readonly subscriptions = new Subscription();
  // A cache seeded from the table, so a restart cannot invent a transition from retained state.
  private readonly lastWrittenByPin = new Map<string, LastKnown>();

  constructor(
    @InjectRepository(PinTransitionEntity)
    private readonly transitions: Repository<PinTransitionEntity>,
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    private readonly hardware: HardwareService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.subscriptions.add(
      this.hardware.pinStates$.subscribe((report) => {
        // Caught here so one failure cannot end the subscription and leave a silent gap.
        void this.record(report).catch((error: unknown) => {
          this.logger.error(
            `Logging ${report.nodeId} pin ${report.pin} failed: ${String(error)}`,
          );
        });
      }),
    );
    this.subscriptions.add(
      this.hardware.availability$.subscribe((availability) => {
        if (availability.online) return;
        void this.recordNodeOffline(availability).catch((error: unknown) => {
          this.logger.error(
            `Logging ${availability.nodeId} going offline failed: ${String(error)}`,
          );
        });
      }),
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  // Oldest first: the consumer is a fitting script replaying a night in order.
  async query(filters: TransitionQuery): Promise<PinTransitionEntity[]> {
    const queryBuilder = this.transitions
      .createQueryBuilder('pinTransition')
      .orderBy('pinTransition.observedAt', 'ASC')
      .limit(Math.min(filters.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));
    if (filters.from) {
      queryBuilder.andWhere('pinTransition.observedAt >= :from', {
        from: filters.from,
      });
    }
    if (filters.to) {
      queryBuilder.andWhere('pinTransition.observedAt <= :to', {
        to: filters.to,
      });
    }
    if (filters.nodeId) {
      queryBuilder.andWhere('pinTransition.nodeId = :nodeId', {
        nodeId: filters.nodeId,
      });
    }
    return queryBuilder.getMany();
  }

  async record(report: PinStateReport): Promise<void> {
    const pinKey = toPinKey(report.nodeId, report.pin);
    const last = await this.readLastKnown(pinKey, report);
    const verdict = judgeTransition(last, report);
    if (verdict.action === 'skip') return;
    await this.write(
      report,
      resolveRecordedAt(last, report, this.clock.now()),
      verdict.reason,
    );
  }

  // A dropped node sends no gpio/state, so without this row its last run would last until it returned.
  async recordNodeOffline(availability: NodeAvailability): Promise<void> {
    const latestRows = await this.findLatestRowPerPin(availability.nodeId);
    for (const row of latestRows) {
      const pinKey = toPinKey(row.nodeId, row.pin);
      const last = this.lastWrittenByPin.get(pinKey) ?? toLastKnown(row);
      if (!last.known) continue;
      await this.write(
        toUnknownReport(row.nodeId, row.pin, availability.at),
        laterOf(availability.at, last.observedAt),
        'node-offline',
      );
    }
  }

  private async write(
    report: PinStateReport,
    observedAt: Date,
    reason: TransitionReason,
  ): Promise<void> {
    const device = await findDeviceOnPin(
      this.devices,
      report.nodeId,
      report.pin,
    );

    await this.transitions.insert({
      nodeId: report.nodeId,
      pin: report.pin,
      level: report.level,
      known: report.known,
      energised: resolveEnergised(report.level, report.known, device?.onLevel),
      deviceId: device?.id ?? null,
      role: device?.role ?? null,
      reason,
      observedAt,
    });

    this.lastWrittenByPin.set(toPinKey(report.nodeId, report.pin), {
      level: report.level,
      known: report.known,
      observedAt,
    });

    this.logger.log(describeTransition(report, device, reason));
  }

  private findLatestRowPerPin(nodeId: string): Promise<PinTransitionEntity[]> {
    return this.transitions
      .createQueryBuilder('pinTransition')
      .distinctOn(['pinTransition.pin'])
      .where('pinTransition.nodeId = :nodeId', { nodeId })
      .orderBy('pinTransition.pin')
      .addOrderBy('pinTransition.observedAt', 'DESC')
      .getMany();
  }

  private async readLastKnown(
    pinKey: string,
    report: PinStateReport,
  ): Promise<LastKnown | null> {
    const cached = this.lastWrittenByPin.get(pinKey);
    if (cached) return cached;

    const row = await this.transitions.findOne({
      where: { nodeId: report.nodeId, pin: report.pin },
      order: { observedAt: 'DESC' },
    });
    if (!row) return null;

    const seeded = toLastKnown(row);
    this.lastWrittenByPin.set(pinKey, seeded);
    return seeded;
  }
}

function toLastKnown(row: PinTransitionEntity): LastKnown {
  return { level: row.level, known: row.known, observedAt: row.observedAt };
}

function toUnknownReport(
  nodeId: string,
  pin: number,
  observedAt: Date,
): PinStateReport {
  return { nodeId, pin, level: null, known: false, observedAt, live: true };
}

// Kept after the last row even when the node's clock ran ahead, so history stays in order.
function laterOf(first: Date, second: Date): Date {
  return first.getTime() >= second.getTime() ? first : second;
}

function describeTransition(
  report: PinStateReport,
  device: DeviceEntity | null,
  reason: TransitionReason,
): string {
  const level = report.known ? report.level : 'UNKNOWN';
  const deviceName = device ? ` (${device.name})` : '';
  return `${report.nodeId} pin ${report.pin} -> ${level}${deviceName} [${reason}]`;
}
