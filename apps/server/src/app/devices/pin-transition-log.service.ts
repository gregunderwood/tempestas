import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Subscription } from 'rxjs';
import { HardwareService, type PinStateReport } from '../hardware/hardware.service';
import { DeviceEntity, PinTransitionEntity } from './models';
import { energisedBy, judgeTransition, type LastKnown } from './pin-transition';

/**
 * Writes the relay history that `devices` cannot keep.
 *
 * Subscribes to `pinStates$` directly rather than hanging off reconciliation,
 * and that is the point: `DevicesService.reconcile` returns early for pins it
 * is mid-command on, so a logger wired in there would miss every COMMANDED
 * change and record only the autonomous ones - the exact inverse of what is
 * wanted. This sees both.
 */
@Injectable()
export class PinTransitionLog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PinTransitionLog.name);
  private subscription?: Subscription;

  /**
   * `node:pin` -> what was last written.
   *
   * A cache, never the source of truth: it is seeded from the table on first
   * sight of each pin, so a server restart does not invent a transition out of
   * the retained state every node republishes on connect.
   */
  private readonly lastWritten = new Map<string, LastKnown>();

  constructor(
    @InjectRepository(PinTransitionEntity)
    private readonly transitions: Repository<PinTransitionEntity>,
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    private readonly hardware: HardwareService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.hardware.pinStates$.subscribe((report) => {
      void this.record(report).catch((err: unknown) => {
        // Never allowed to kill the subscription. Losing the log quietly is
        // worse than a noisy failure, because the gap only shows up months
        // later when somebody tries to fit against it.
        this.logger.error(
          `Logging ${report.nodeId} pin ${report.pin} failed: ${String(err)}`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private async lastFor(key: string, report: PinStateReport): Promise<LastKnown | null> {
    const cached = this.lastWritten.get(key);
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
    this.lastWritten.set(key, seeded);
    return seeded;
  }

  /**
   * The history of every line in a window, oldest first.
   *
   * Oldest first because the consumer is a fitting script replaying a night in
   * order, not a UI showing the most recent thing.
   */
  async query(opts: {
    from?: Date;
    to?: Date;
    nodeId?: string;
    limit?: number;
  }): Promise<PinTransitionEntity[]> {
    const qb = this.transitions
      .createQueryBuilder('t')
      .orderBy('t.observedAt', 'ASC')
      .limit(Math.min(opts.limit ?? 1000, 10_000));
    if (opts.from) qb.andWhere('t.observedAt >= :from', { from: opts.from });
    if (opts.to) qb.andWhere('t.observedAt <= :to', { to: opts.to });
    if (opts.nodeId) qb.andWhere('t.nodeId = :nodeId', { nodeId: opts.nodeId });
    return qb.getMany();
  }

  async record(report: PinStateReport): Promise<void> {
    const key = `${report.nodeId}:${report.pin}`;
    const last = await this.lastFor(key, report);
    const verdict = judgeTransition(last, report);
    if (verdict.action === 'skip') return;

    // The device is the INTERPRETATION, resolved now and then frozen into the
    // row. The pin and the level are the fact.
    const device = await this.devices.findOne({
      where: { gpio: report.pin, node: { slug: report.nodeId } },
      relations: { node: true },
    });

    await this.transitions.insert({
      nodeId: report.nodeId,
      pin: report.pin,
      level: report.level,
      known: report.known,
      energised: energisedBy(report.level, report.known, device?.onLevel),
      deviceId: device?.id ?? null,
      role: device?.role ?? null,
      reason: verdict.reason,
      observedAt: report.observedAt,
    });

    this.lastWritten.set(key, {
      level: report.level,
      known: report.known,
      observedAt: report.observedAt,
    });

    this.logger.log(
      `${report.nodeId} pin ${report.pin} -> ` +
        `${report.known ? report.level : 'UNKNOWN'}` +
        `${device ? ` (${device.name})` : ''} [${verdict.reason}]`,
    );
  }
}
