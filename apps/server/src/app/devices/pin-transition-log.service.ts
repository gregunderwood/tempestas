import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Subscription } from 'rxjs';
import {
  HardwareService,
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
  type TransitionVerdict,
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
  private subscription?: Subscription;
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
    this.subscription = this.hardware.pinStates$.subscribe((report) => {
      // Caught here so one failure cannot end the subscription and leave a silent gap.
      void this.record(report).catch((error: unknown) => {
        this.logger.error(
          `Logging ${report.nodeId} pin ${report.pin} failed: ${String(error)}`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
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
    const observedAt = resolveRecordedAt(last, report, this.clock.now());

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
      reason: verdict.reason,
      observedAt,
    });

    this.lastWrittenByPin.set(pinKey, {
      level: report.level,
      known: report.known,
      observedAt,
    });

    this.logger.log(describeTransition(report, device, verdict));
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

    const seeded: LastKnown = {
      level: row.level,
      known: row.known,
      observedAt: row.observedAt,
    };
    this.lastWrittenByPin.set(pinKey, seeded);
    return seeded;
  }
}

function describeTransition(
  report: PinStateReport,
  device: DeviceEntity | null,
  verdict: TransitionVerdict,
): string {
  const level = report.known ? report.level : 'UNKNOWN';
  const deviceName = device ? ` (${device.name})` : '';
  return `${report.nodeId} pin ${report.pin} -> ${level}${deviceName} [${verdict.reason}]`;
}
