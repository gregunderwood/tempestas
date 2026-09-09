import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import {
  ApiErrorCode,
  NodeStatus,
  type Node,
  type NodeId,
} from '@tempestas/domain';
import {
  HardwareService,
  type NodeAvailability,
  type NodeHello,
} from '../hardware/hardware.service';
import { DeviceEntity } from '../devices/models';
import { SensorReadingEntity } from '../readings/models';
import { ZoneEntity } from '../zones/models';
import { NodeEntity } from './models';
import type { AdmitNodeDto } from './dto/admit-node.dto';
import type { UpdateNodeDto } from './dto/update-node.dto';
import {
  acceptsSamples,
  newNodeFromHello,
  patchFromHello,
  type HelloFacts,
} from './node-registry';

/** Why a sample was refused. Carried so the log line can say which it was. */
export type SampleRejection = 'unknown-node' | 'pending' | 'disabled';

export type SampleResolution =
  | { accepted: true; node: NodeEntity }
  | { accepted: false; reason: SampleRejection };

/**
 * The node registry: the only writer of a node's identity, and the gate every
 * inbound reading passes through.
 *
 * Two subscriptions drive it - `hello` (a node announcing what it is) and
 * availability (its LWT). Both are funnelled through one serial queue: they
 * arrive from the broker with no ordering guarantee between them, and a `hello`
 * racing its own status message must not produce two rows for one slug.
 */
@Injectable()
export class NodesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NodesService.name);
  private readonly subscriptions = new Subscription();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectRepository(NodeEntity)
    private readonly nodes: Repository<NodeEntity>,
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zones: Repository<ZoneEntity>,
    private readonly hardware: HardwareService,
  ) {}

  onModuleInit(): void {
    this.subscriptions.add(
      this.hardware.hello$.subscribe((hello) =>
        this.enqueue(() => this.handleHello(hello)),
      ),
    );
    this.subscriptions.add(
      this.hardware.availability$.subscribe((a) =>
        this.enqueue(() => this.handleAvailability(a)),
      ),
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  /**
   * One task at a time, and a failure never breaks the chain: an unreachable
   * database during one `hello` must not silently unsubscribe the registry for
   * the rest of the process's life.
   */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      this.logger.error(
        `Registry task failed: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  async handleHello(hello: NodeHello): Promise<void> {
    const facts = toFacts(hello);
    const existing = await this.nodes.findOne({
      where: { slug: facts.nodeId },
    });

    if (!existing) {
      await this.nodes.save(this.nodes.create(newNodeFromHello(facts)));
      // WARN, not LOG: this is the one registry event that needs a human.
      this.logger.warn(
        `Node "${facts.nodeId}" announced itself and is PENDING - it receives no commands and ` +
          `its readings are DISCARDED until it is admitted.`,
      );
      return;
    }

    const { patch, outcome } = patchFromHello(existing, facts);
    Object.assign(existing, patch);
    await this.nodes.save(existing);

    switch (outcome) {
      case 'rebooted':
        this.logger.log(
          `Node "${facts.nodeId}" rebooted (bootId ${facts.bootId})`,
        );
        break;
      case 'capabilities-changed':
        this.logger.warn(
          `Node "${facts.nodeId}" changed its capabilities - a device may now be bound to a pin ` +
            `the node no longer exposes`,
        );
        break;
      case 'agent-upgraded':
        this.logger.log(
          `Node "${facts.nodeId}" agent is now ${facts.agentVersion}`,
        );
        break;
      case 'seen':
        this.logger.debug(`Node "${facts.nodeId}" re-announced, unchanged`);
        break;
    }
  }

  async handleAvailability(availability: NodeAvailability): Promise<void> {
    const row = await this.nodes.findOne({
      where: { slug: availability.nodeId },
    });
    if (!row) {
      // Registration happens on `hello`, which is the only channel carrying
      // capabilities. A retained status for a slug we have never met is either
      // a node that has not re-announced yet or a stale retained message.
      this.logger.debug(
        `Ignoring status for unregistered node "${availability.nodeId}"`,
      );
      return;
    }

    const changed = row.online !== availability.online;
    row.online = availability.online;
    // Only an ONLINE transition is a sighting. Leaving lastSeenAt alone on an
    // LWT is what makes "offline since" answerable at all.
    if (availability.online) row.lastSeenAt = availability.at;
    await this.nodes.save(row);

    if (!changed) return;
    if (availability.online) {
      this.logger.log(`Node "${row.slug}" is online`);
    } else {
      // Stale is not off. The pins of a node that dropped are UNKNOWN.
      this.logger.warn(
        `Node "${row.slug}" went OFFLINE - its pin states are now unknown, not off`,
      );
    }
  }

  /**
   * The gate. Called for every inbound sample, and the reason a stray node on
   * the WiFi cannot inject a reading that starts a burner.
   */
  async resolveForSample(nodeId: NodeId): Promise<SampleResolution> {
    const node = await this.nodes.findOne({ where: { slug: nodeId } });
    if (!node) return { accepted: false, reason: 'unknown-node' };
    if (!acceptsSamples(node.status)) {
      return {
        accepted: false,
        reason: node.status === NodeStatus.Disabled ? 'disabled' : 'pending',
      };
    }
    return { accepted: true, node };
  }

  async findAll(): Promise<Node[]> {
    const rows = await this.nodes.find({ order: { slug: 'ASC' } });
    return this.decorate(rows);
  }

  async findOne(id: string): Promise<Node> {
    const [dto] = await this.decorate([await this.findOneEntity(id)]);
    return dto;
  }

  async findOneEntity(id: string): Promise<NodeEntity> {
    const row = await this.nodes.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException({
        code: ApiErrorCode.NotFound,
        message: `Node ${id} not found`,
      });
    }
    return row;
  }

  /**
   * The one click. Idempotent on purpose - a double-click on an admit button
   * must not raise a 409 at the operator.
   */
  async admit(id: string, dto: AdmitNodeDto): Promise<Node> {
    const row = await this.findOneEntity(id);
    const was = row.status;
    await this.applyHumanFields(row, dto);
    row.status = NodeStatus.Admitted;
    await this.nodes.save(row);

    if (was !== NodeStatus.Admitted) {
      this.logger.warn(
        `Node "${row.slug}" ADMITTED (was ${was}) - its readings will now persist and it may be commanded`,
      );
    }
    return this.findOne(id);
  }

  /**
   * The terminal state for a node that should never be believed: unlike
   * deleting it, a `hello` cannot bring it back, because a hello never moves
   * status. Its devices stop being drivable via the same `acceptsCommands` gate.
   */
  async disable(id: string): Promise<Node> {
    const row = await this.findOneEntity(id);
    const was = row.status;
    row.status = NodeStatus.Disabled;
    await this.nodes.save(row);
    if (was !== NodeStatus.Disabled) {
      this.logger.warn(
        `Node "${row.slug}" DISABLED (was ${was}) - no commands, no readings`,
      );
    }
    return this.findOne(id);
  }

  async update(id: string, dto: UpdateNodeDto): Promise<Node> {
    const row = await this.findOneEntity(id);
    await this.applyHumanFields(row, dto);
    await this.nodes.save(row);
    return this.findOne(id);
  }

  /**
   * Only a pending node. `sensor_readings` cascades on node delete, so deleting
   * an admitted node would silently take its history with it - `disable` is the
   * operation that means "stop trusting this", and it keeps the data.
   */
  async remove(id: string): Promise<void> {
    const row = await this.findOneEntity(id);
    if (row.status !== NodeStatus.Pending) {
      throw new ConflictException({
        code: ApiErrorCode.NodeNotDeletable,
        message: `Node "${row.slug}" is ${row.status}; only a pending node may be deleted. Disable it instead.`,
        details: { status: row.status },
      });
    }
    await this.nodes.remove(row);
    this.logger.warn(
      `Pending node "${row.slug}" deleted; it will return as pending if it says hello again`,
    );
  }

  private async applyHumanFields(
    row: NodeEntity,
    dto: AdmitNodeDto | UpdateNodeDto,
  ): Promise<void> {
    if (dto.zoneId !== undefined) {
      const zone = await this.zones.findOne({ where: { id: dto.zoneId } });
      if (!zone) {
        throw new NotFoundException({
          code: ApiErrorCode.NotFound,
          message: `Zone ${dto.zoneId} not found`,
        });
      }
      row.zoneId = zone.id;
    }
    if (dto.displayName !== undefined) row.displayName = dto.displayName;
    if (dto.location !== undefined) row.location = dto.location;
  }

  /**
   * `deviceCount` and `latestReadingAt` come from two grouped aggregates rather
   * than a per-node query, so the nodes list stays three round-trips regardless
   * of how many nodes exist.
   */
  private async decorate(rows: NodeEntity[]): Promise<Node[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const counts = await this.devices
      .createQueryBuilder('d')
      .select('d.nodeId', 'nodeId')
      .addSelect('COUNT(*)', 'count')
      .where('d.nodeId IN (:...ids)', { ids })
      .groupBy('d.nodeId')
      .getRawMany<{ nodeId: string; count: string }>();

    const latest = await this.readings
      .createQueryBuilder('r')
      .select('r.nodeId', 'nodeId')
      .addSelect('MAX(r.createdAt)', 'latest')
      .where('r.nodeId IN (:...ids)', { ids })
      .groupBy('r.nodeId')
      .getRawMany<{ nodeId: string; latest: Date | string }>();

    const countBy = new Map(counts.map((c) => [c.nodeId, Number(c.count)]));
    const latestBy = new Map(
      latest.map((l) => [l.nodeId, new Date(l.latest).toISOString()]),
    );

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      location: row.location,
      kind: row.kind,
      status: row.status,
      online: row.online,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      agentVersion: row.agentVersion,
      capabilities: row.capabilities,
      zoneId: row.zoneId,
      deviceCount: countBy.get(row.id) ?? 0,
      latestReadingAt: latestBy.get(row.id) ?? null,
    }));
  }
}

function toFacts(hello: NodeHello): HelloFacts {
  return {
    nodeId: hello.nodeId,
    kind: hello.kind,
    agentVersion: hello.agentVersion,
    capabilities: hello.capabilities,
    bootId: hello.bootId,
    receivedAt: hello.receivedAt,
  };
}
