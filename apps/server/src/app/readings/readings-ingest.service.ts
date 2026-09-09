import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { Clock } from '../common/clock';
import { HardwareService, type SensorSample } from '../hardware/hardware.service';
import { NodesService, type SampleRejection } from '../nodes/nodes.service';
import { SensorReadingEntity } from './models';

export type IngestResult = 'persisted' | 'duplicate' | 'discarded';

/**
 * A node in `pending` produces ~8,640 discarded samples a day. Logging each one
 * would bury the single line that matters, which is the WARN saying a new node
 * is waiting to be admitted. So: log the first, then at most one summary line
 * per interval carrying the count.
 */
const DISCARD_LOG_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The only writer of `sensor_readings`, and the enforcement point for the
 * admission gate: a sample from a node no human has admitted is DISCARDED, not
 * stored-and-ignored. Nothing downstream - rules, stats, the dashboard - has to
 * remember to re-check, because unbelievable data never enters the table.
 */
@Injectable()
export class ReadingsIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReadingsIngestService.name);
  private readonly subscriptions = new Subscription();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly discards = new Map<string, { count: number; lastLoggedAtMs: number }>();

  constructor(
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    private readonly nodes: NodesService,
    private readonly hardware: HardwareService,
    private readonly clock: Clock
  ) {}

  onModuleInit(): void {
    this.subscriptions.add(
      this.hardware.samples$.subscribe((sample) => {
        this.queue = this.queue
          .then(() => this.ingest(sample))
          .catch((err: unknown) => {
            this.logger.error(
              `Failed to ingest a sample from "${sample.nodeId}": ${
                err instanceof Error ? err.message : err
              }`
            );
          });
      })
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  async ingest(sample: SensorSample): Promise<IngestResult> {
    const resolution = await this.nodes.resolveForSample(sample.nodeId);
    // `=== false`, not `!`: an equality check against the literal is what
    // narrows the union, so `reason` is reachable without a cast.
    if (resolution.accepted === false) {
      this.noteDiscard(sample.nodeId, resolution.reason);
      return 'discarded';
    }

    // ON CONFLICT DO NOTHING against uq_readings_node_sensor_seq. MQTT QoS 1 is
    // at-least-once, and a duplicate sample would mean a duplicate rules
    // evaluation. A node that publishes no `seq` gets no protection here -
    // NULLs are distinct in a unique index - which is why the contract asks for
    // one.
    const result = await this.readings
      .createQueryBuilder()
      .insert()
      .values({
        nodeId: resolution.node.id,
        sensorId: sample.sensorId,
        temperature: sample.temperature,
        humidity: sample.humidity,
        // Null means "unknown", never zero: the node reports validity honestly
        // and never substitutes a last-known-good value.
        co2: sample.co2 === null ? null : Math.round(sample.co2),
        nodeSeq: sample.nodeSeq === null ? null : String(sample.nodeSeq),
      })
      .orIgnore()
      .execute();

    const inserted = Array.isArray(result.raw) ? result.raw.length > 0 : true;
    if (!inserted) {
      this.logger.debug(
        `Duplicate sample from "${sample.nodeId}" seq ${sample.nodeSeq} ignored`
      );
      return 'duplicate';
    }
    return 'persisted';
  }

  private noteDiscard(nodeId: string, reason: SampleRejection): void {
    const nowMs = this.clock.now().getTime();
    const seen = this.discards.get(nodeId);

    if (!seen) {
      this.discards.set(nodeId, { count: 0, lastLoggedAtMs: nowMs });
      this.logger.warn(
        `Discarding readings from "${nodeId}" (${reason}) - admit the node to start believing it`
      );
      return;
    }

    seen.count += 1;
    if (nowMs - seen.lastLoggedAtMs >= DISCARD_LOG_INTERVAL_MS) {
      this.logger.warn(
        `Discarded ${seen.count} further readings from "${nodeId}" (${reason})`
      );
      seen.count = 0;
      seen.lastLoggedAtMs = nowMs;
    }
  }
}
