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
import {
  HardwareService,
  type SensorSample,
} from '../hardware/hardware.service';
import { NodesService, type SampleRejection } from '../nodes/nodes.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
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
  private readonly discards = new Map<
    string,
    { count: number; lastLoggedAtMs: number }
  >();

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
      this.hardware.samples$.subscribe((sample) => {
        this.queue = this.queue
          .then(() => this.ingest(sample))
          .catch((err: unknown) => {
            this.logger.error(
              `Failed to ingest a sample from "${sample.nodeId}": ${
                err instanceof Error ? err.message : err
              }`,
            );
          });
      }),
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

    // ON CONFLICT DO NOTHING against uq_readings_node_sensor_boot_seq. MQTT QoS
    // 1 is at-least-once, and a duplicate sample would mean a duplicate rules
    // evaluation.
    //
    // The key includes the node's boot generation because a node's sequence
    // counter restarts at 1 when its agent does. Without that, every sample
    // after a node reboot collided with the previous boot's rows and was
    // dropped - which presents as a stale sensor rather than as an error.
    //
    // A node that publishes no `seq`, or has no bootId yet, gets no protection
    // here: NULLs are distinct in a unique index. That is why the contract asks
    // every node for a seq.
    const result = await this.readings
      .createQueryBuilder()
      .insert()
      .values({
        nodeId: resolution.node.id,
        bootId: resolution.node.bootId,
        sensorId: sample.sensorId,
        temperature: sample.temperature,
        humidity: sample.humidity,
        // Null means "unknown", never zero: the node reports validity honestly
        // and never substitutes a last-known-good value.
        co2: sample.co2 === null ? null : Math.round(sample.co2),
        nodeSeq: sample.nodeSeq === null ? null : String(sample.nodeSeq),
      })
      .orIgnore()
      // RETURNING gives us the server-stamped id and created_at, so the socket
      // payload is the row that was actually written rather than a
      // reconstruction of it. It also stays empty on a conflict, which is how a
      // duplicate is detected without a second query.
      .returning('*')
      .execute();

    const written = Array.isArray(result.raw) ? result.raw : [];
    if (written.length === 0) {
      this.logger.debug(
        `Duplicate sample from "${sample.nodeId}" seq ${sample.nodeSeq} ignored`,
      );
      return 'duplicate';
    }

    this.realtime.publishReading({
      id: written[0].id,
      nodeId: sample.nodeId,
      sensorId: sample.sensorId,
      temperature: sample.temperature,
      humidity: sample.humidity,
      co2: sample.co2 === null ? null : Math.round(sample.co2),
      createdAt: new Date(written[0].created_at).toISOString(),
    });
    return 'persisted';
  }

  private noteDiscard(nodeId: string, reason: SampleRejection): void {
    const nowMs = this.clock.now().getTime();
    const seen = this.discards.get(nodeId);

    if (!seen) {
      this.discards.set(nodeId, { count: 0, lastLoggedAtMs: nowMs });
      this.logger.warn(
        `Discarding readings from "${nodeId}" (${reason}) - admit the node to start believing it`,
      );
      return;
    }

    seen.count += 1;
    if (nowMs - seen.lastLoggedAtMs >= DISCARD_LOG_INTERVAL_MS) {
      this.logger.warn(
        `Discarded ${seen.count} further readings from "${nodeId}" (${reason})`,
      );
      seen.count = 0;
      seen.lastLoggedAtMs = nowMs;
    }
  }
}
