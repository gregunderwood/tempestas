import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { Clock } from '../common/clock';
import { describeError } from '../common/describe-error';
import {
  HardwareService,
  type SensorSample,
} from '../hardware/hardware.service';
import { NodesService, type SampleRejection } from '../nodes/nodes.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NodeEntity } from '../nodes/models';
import { SensorReadingEntity } from './models';

export type IngestResult = 'persisted' | 'duplicate' | 'discarded';

// A pending node discards ~8,640 samples a day; one summary per interval keeps the admit WARN visible.
const DISCARD_LOG_INTERVAL_MS = 15 * 60 * 1000;

interface DiscardTally {
  count: number;
  lastLoggedAtMs: number;
}

interface PersistedRow {
  id: string;
  created_at: string | Date;
}

@Injectable()
export class ReadingsIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReadingsIngestService.name);
  private readonly subscriptions = new Subscription();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly discardTallies = new Map<string, DiscardTally>();

  constructor(
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    private readonly nodes: NodesService,
    private readonly hardware: HardwareService,
    private readonly clock: Clock,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.subscriptions.add(
      this.hardware.samples$.subscribe((sample) => this.enqueue(sample)),
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  async ingest(sample: SensorSample): Promise<IngestResult> {
    const resolution = await this.nodes.resolveForSample(sample.nodeId);
    // `=== false`, not `!`: comparing against the literal is what narrows the union.
    if (resolution.accepted === false) {
      this.recordDiscard(sample.nodeId, resolution.reason);
      return 'discarded';
    }

    const persistedRow = await this.insertUnlessDuplicate(
      sample,
      resolution.node,
    );
    if (!persistedRow) {
      this.logger.debug(
        `Duplicate sample from "${sample.nodeId}" seq ${sample.nodeSeq} ignored`,
      );
      return 'duplicate';
    }

    this.publishPersisted(sample, persistedRow);
    await this.nodes.noteReading(
      resolution.node.id,
      new Date(persistedRow.created_at),
    );
    return 'persisted';
  }

  private enqueue(sample: SensorSample): void {
    this.queue = this.queue
      .then(() => this.ingest(sample))
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to ingest a sample from "${sample.nodeId}": ${describeError(error)}`,
        );
      });
  }

  // RETURNING is empty on a conflict, which is how a duplicate is spotted without a second query.
  private async insertUnlessDuplicate(
    sample: SensorSample,
    node: NodeEntity,
  ): Promise<PersistedRow | undefined> {
    const result = await this.readings
      .createQueryBuilder()
      .insert()
      .values({
        nodeId: node.id,
        bootId: node.bootId,
        sensorId: sample.sensorId,
        temperature: sample.temperature,
        humidity: sample.humidity,
        co2: roundCo2(sample.co2),
        nodeSeq: sample.nodeSeq === null ? null : String(sample.nodeSeq),
      })
      .orIgnore()
      .returning('*')
      .execute();

    const written: PersistedRow[] = Array.isArray(result.raw) ? result.raw : [];
    return written[0];
  }

  private publishPersisted(
    sample: SensorSample,
    persistedRow: PersistedRow,
  ): void {
    this.realtime.publishReading({
      id: persistedRow.id,
      nodeId: sample.nodeId,
      sensorId: sample.sensorId,
      temperature: sample.temperature,
      humidity: sample.humidity,
      co2: roundCo2(sample.co2),
      createdAt: new Date(persistedRow.created_at).toISOString(),
    });
  }

  private recordDiscard(nodeId: string, reason: SampleRejection): void {
    const nowMs = this.clock.now().getTime();
    const tally = this.discardTallies.get(nodeId);

    if (!tally) {
      this.discardTallies.set(nodeId, { count: 0, lastLoggedAtMs: nowMs });
      this.logger.warn(
        `Discarding readings from "${nodeId}" (${reason}) - admit the node to start believing it`,
      );
      return;
    }

    tally.count += 1;
    if (!isSummaryDue(tally, nowMs)) return;
    this.logger.warn(
      `Discarded ${tally.count} further readings from "${nodeId}" (${reason})`,
    );
    tally.count = 0;
    tally.lastLoggedAtMs = nowMs;
  }
}

function roundCo2(co2: number | null): number | null {
  return co2 === null ? null : Math.round(co2);
}

function isSummaryDue(tally: DiscardTally, nowMs: number): boolean {
  return nowMs - tally.lastLoggedAtMs >= DISCARD_LOG_INTERVAL_MS;
}
