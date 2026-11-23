import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import {
  ApiErrorCode,
  describeAgent,
  NodeStatus,
  type Node,
  type NodeCapabilities,
  type NodeId,
} from '@tempestas/domain';
import {
  HardwareService,
  type NodeAvailability,
  type NodeHello,
} from '../hardware/hardware.service';
import { AgentReleasesService } from '../agent-releases/agent-releases.service';
import { Clock } from '../common/clock';
import { describeError } from '../common/describe-error';
import { DeviceEntity } from '../devices/models';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SensorReadingEntity } from '../readings/models';
import { ZoneEntity } from '../zones/models';
import { NodeEntity } from './models';
import type { NodeOperatorFieldsDto } from './dto/node-operator-fields.dto';
import type { AdmitNodeDto } from './dto/admit-node.dto';
import type { UpdateNodeDto } from './dto/update-node.dto';
import {
  acceptsSamples,
  findContractStanding,
  newNodeFromHello,
  patchFromHello,
  pinsWithdrawn,
  type HelloFacts,
  type HelloOutcome,
  isNodeOnline,
  NODE_OFFLINE_AFTER_MS,
  type NodeOnlineEvidence,
} from './node-registry';

export type SampleRejection = 'unknown-node' | 'pending' | 'disabled';

export type SampleResolution =
  | { accepted: true; node: NodeEntity }
  | { accepted: false; reason: SampleRejection };

interface NodeCounts {
  total: number;
  online: number;
  pending: number;
}

interface HelloContext {
  node: NodeEntity;
  previousCapabilities: NodeCapabilities;
  facts: HelloFacts;
}

type HelloOutcomeReporter = (context: HelloContext) => void | Promise<void>;

interface PublishedLiveness {
  evidence: NodeOnlineEvidence;
  isPublishedOnline: boolean;
}

// Derived `online` lapses with the clock, not with a save, so something has to look.
export const ONLINE_SWEEP_INTERVAL_MS = 30_000;

const COUNT_ONLINE_NODES = `COUNT(*) FILTER (WHERE node.online AND (
           node.last_seen_at >= :cutoff
           OR EXISTS (
             SELECT 1 FROM sensor_readings reading
             WHERE reading.node_id = node.id AND reading.created_at >= :cutoff
           )
         ))`;

const COUNT_PENDING_NODES = `COUNT(*) FILTER (WHERE node.status = 'pending')`;

// hello and availability share one serial queue: the broker does not order them.
@Injectable()
export class NodesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NodesService.name);
  private readonly subscriptions = new Subscription();
  private queue: Promise<void> = Promise.resolve();
  private readonly publishedLiveness = new Map<string, PublishedLiveness>();

  private readonly helloOutcomeReporters: Record<
    HelloOutcome,
    HelloOutcomeReporter
  > = {
    rebooted: ({ facts }) =>
      this.logger.log(
        `Node "${facts.nodeId}" rebooted (bootId ${facts.bootId})`,
      ),
    'capabilities-changed': (context) => this.reportWithdrawnPins(context),
    'agent-upgraded': ({ facts }) =>
      this.logger.log(
        `Node "${facts.nodeId}" agent is now ${describeAgent(facts)}`,
      ),
    seen: ({ facts }) =>
      this.logger.debug(`Node "${facts.nodeId}" re-announced, unchanged`),
  };

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
    private readonly realtime: RealtimeGateway,
    private readonly clock: Clock,
    private readonly agentReleases: AgentReleasesService,
  ) {}

  onModuleInit(): void {
    this.subscriptions.add(
      this.hardware.hello$.subscribe((hello) =>
        this.enqueue(() => this.handleHello(hello)),
      ),
    );
    this.subscriptions.add(
      this.hardware.availability$.subscribe((availability) =>
        this.enqueue(() => this.handleAvailability(availability)),
      ),
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  async handleHello(hello: NodeHello): Promise<void> {
    const facts = toHelloFacts(hello);
    const existing = await this.nodes.findOne({
      where: { slug: facts.nodeId },
    });
    if (!existing) {
      await this.registerPendingNode(facts);
      return;
    }

    const previousCapabilities = existing.capabilities;
    const { patch, outcomes } = patchFromHello(existing, facts);
    Object.assign(existing, patch);
    await this.nodes.save(existing);

    for (const outcome of outcomes) {
      await this.helloOutcomeReporters[outcome]({
        node: existing,
        previousCapabilities,
        facts,
      });
    }
    await this.publishNodeState(existing);
  }

  async handleAvailability(availability: NodeAvailability): Promise<void> {
    const node = await this.nodes.findOne({
      where: { slug: availability.nodeId },
    });
    if (!node) {
      // Only `hello` carries capabilities, so a status alone never registers a node.
      this.logger.debug(
        `Ignoring status for unregistered node "${availability.nodeId}"`,
      );
      return;
    }

    const hasChanged = node.online !== availability.online;
    node.online = availability.online;
    // Only an online transition is a sighting, which is what makes "offline since" answerable.
    if (availability.online) node.lastSeenAt = availability.at;
    await this.nodes.save(node);
    await this.publishNodeState(node);

    if (!hasChanged) return;
    this.logAvailabilityChange(node);
  }

  noteReading(nodeId: string, createdAt: Date): Promise<void> {
    const liveness = this.publishedLiveness.get(nodeId);
    if (!liveness) return Promise.resolve();
    liveness.evidence.latestReadingAt = newerOf(
      liveness.evidence.latestReadingAt,
      createdAt,
    );
    if (!hasOnlineChanged(liveness, this.clock.now())) return Promise.resolve();
    return this.enqueue(() => this.republishNode(nodeId));
  }

  @Interval(ONLINE_SWEEP_INTERVAL_MS)
  publishLapsedNodes(): Promise<void> {
    const now = this.clock.now();
    const changedIds = [...this.publishedLiveness]
      .filter(([, liveness]) => hasOnlineChanged(liveness, now))
      .map(([id]) => id);
    for (const id of changedIds) {
      this.enqueue(() => this.republishNode(id));
    }
    return this.queue;
  }

  async resolveForSample(nodeId: NodeId): Promise<SampleResolution> {
    const node = await this.nodes.findOne({ where: { slug: nodeId } });
    if (!node) return { accepted: false, reason: 'unknown-node' };
    if (!acceptsSamples(node.status)) {
      return { accepted: false, reason: rejectionFor(node.status) };
    }
    return { accepted: true, node };
  }

  // The SQL twin of `isNodeOnline`: if they disagree, the health endpoint contradicts the nodes screen.
  async counts(): Promise<NodeCounts> {
    const cutoff = new Date(this.clock.now().getTime() - NODE_OFFLINE_AFTER_MS);
    const row = await this.nodes
      .createQueryBuilder('node')
      .select('COUNT(*)', 'total')
      .addSelect(COUNT_ONLINE_NODES, 'online')
      .addSelect(COUNT_PENDING_NODES, 'pending')
      .setParameter('cutoff', cutoff)
      .getRawOne<{ total: string; online: string; pending: string }>();

    return {
      total: Number(row?.total ?? 0),
      online: Number(row?.online ?? 0),
      pending: Number(row?.pending ?? 0),
    };
  }

  async findAll(): Promise<Node[]> {
    const entities = await this.nodes.find({ order: { slug: 'ASC' } });
    return this.decorate(entities);
  }

  async findOne(id: string): Promise<Node> {
    const [node] = await this.decorate([await this.findOneEntity(id)]);
    return node;
  }

  async findOneEntity(id: string): Promise<NodeEntity> {
    const node = await this.nodes.findOne({ where: { id } });
    if (!node) {
      throw new NotFoundException({
        code: ApiErrorCode.NotFound,
        message: `Node ${id} not found`,
      });
    }
    return node;
  }

  // Idempotent on purpose: a double-clicked admit button must not raise a 409 at the operator.
  admit(id: string, admission: AdmitNodeDto): Promise<Node> {
    return this.moveToStatus(
      id,
      NodeStatus.Admitted,
      (node, previousStatus) =>
        `Node "${node.slug}" ADMITTED (was ${previousStatus}) - its readings will now persist and it may be commanded`,
      (node) => this.applyOperatorFields(node, admission),
    );
  }

  disable(id: string): Promise<Node> {
    return this.moveToStatus(
      id,
      NodeStatus.Disabled,
      (node, previousStatus) =>
        `Node "${node.slug}" DISABLED (was ${previousStatus}) - no commands, no readings`,
    );
  }

  async update(id: string, changes: UpdateNodeDto): Promise<Node> {
    const node = await this.findOneEntity(id);
    await this.applyOperatorFields(node, changes);
    await this.nodes.save(node);
    return this.publishNodeState(node);
  }

  // Only a pending node: deleting cascades its readings, and `disable` is the reject that keeps them.
  async remove(id: string): Promise<void> {
    const node = await this.findOneEntity(id);
    if (node.status !== NodeStatus.Pending) {
      throw new ConflictException({
        code: ApiErrorCode.NodeNotDeletable,
        message: `Node "${node.slug}" is ${node.status}; only a pending node may be deleted. Disable it instead.`,
        details: { status: node.status },
      });
    }
    await this.nodes.remove(node);
    this.publishedLiveness.delete(id);
    this.logger.warn(
      `Pending node "${node.slug}" deleted; it will return as pending if it says hello again`,
    );
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.logger.error(`Registry task failed: ${describeError(error)}`);
    });
    return this.queue;
  }

  private async registerPendingNode(facts: HelloFacts): Promise<void> {
    const node = await this.nodes.save(
      this.nodes.create(newNodeFromHello(facts)),
    );
    await this.publishNodeState(node);
    this.logger.warn(
      `Node "${facts.nodeId}" announced itself and is PENDING - it receives no commands and ` +
        `its readings are DISCARDED until it is admitted.`,
    );
  }

  private async reportWithdrawnPins({
    node,
    previousCapabilities,
    facts,
  }: HelloContext): Promise<void> {
    const withdrawn = pinsWithdrawn(previousCapabilities, facts.capabilities);
    if (withdrawn.length === 0) {
      this.logger.warn(`Node "${facts.nodeId}" changed its capabilities`);
      return;
    }

    const devicesOnNode = await this.devices.find({
      where: { nodeId: node.id },
    });
    const orphaned = devicesOnNode.filter((device) =>
      withdrawn.includes(device.gpio),
    );
    if (orphaned.length === 0) {
      this.logger.warn(
        `Node "${facts.nodeId}" withdrew pins [${withdrawn.join(', ')}]; nothing was bound to them`,
      );
      return;
    }
    this.logger.error(
      `Node "${facts.nodeId}" withdrew pins [${withdrawn.join(', ')}], ORPHANING ` +
        orphaned
          .map((device) => `"${device.name}" (pin ${device.gpio})`)
          .join(', ') +
        ` - every attempt to drive them will fail at the node until this is resolved`,
    );
  }

  private logAvailabilityChange(node: NodeEntity): void {
    if (node.online) {
      this.logger.log(`Node "${node.slug}" is online`);
      return;
    }
    this.logger.warn(
      `Node "${node.slug}" went OFFLINE - its pin states are now unknown, not off`,
    );
  }

  private async moveToStatus(
    id: string,
    targetStatus: NodeStatus,
    describeTransition: (
      node: NodeEntity,
      previousStatus: NodeStatus,
    ) => string,
    applyFields?: (node: NodeEntity) => Promise<void>,
  ): Promise<Node> {
    const node = await this.findOneEntity(id);
    const previousStatus = node.status;
    await applyFields?.(node);
    node.status = targetStatus;
    await this.nodes.save(node);
    if (previousStatus !== targetStatus) {
      this.logger.warn(describeTransition(node, previousStatus));
    }
    return this.publishNodeState(node);
  }

  private async publishNodeState(entity: NodeEntity): Promise<Node> {
    const [node] = await this.decorate([entity]);
    this.realtime.publishNodeState(node);
    this.publishedLiveness.set(node.id, {
      evidence: {
        online: entity.online,
        lastSeenAt: entity.lastSeenAt,
        latestReadingAt: parseInstant(node.latestReadingAt),
      },
      isPublishedOnline: node.online,
    });
    return node;
  }

  private async republishNode(id: string): Promise<void> {
    const node = await this.nodes.findOne({ where: { id } });
    if (!node) {
      this.publishedLiveness.delete(id);
      return;
    }
    await this.publishNodeState(node);
  }

  private async applyOperatorFields(
    node: NodeEntity,
    fields: NodeOperatorFieldsDto,
  ): Promise<void> {
    if (fields.zoneId !== undefined) {
      node.zoneId = await this.findZoneId(fields.zoneId);
    }
    if (fields.displayName !== undefined) node.displayName = fields.displayName;
    if (fields.location !== undefined) node.location = fields.location;
  }

  private async findZoneId(zoneId: string): Promise<string> {
    const zone = await this.zones.findOne({ where: { id: zoneId } });
    if (!zone) {
      throw new NotFoundException({
        code: ApiErrorCode.NotFound,
        message: `Zone ${zoneId} not found`,
      });
    }
    return zone.id;
  }

  // Two grouped aggregates, so the nodes list stays three round-trips however many nodes exist.
  private async decorate(nodes: NodeEntity[]): Promise<Node[]> {
    if (nodes.length === 0) return [];
    const ids = nodes.map((node) => node.id);
    const deviceCounts = await this.countDevicesByNode(ids);
    const latestReadings = await this.findLatestReadingByNode(ids);
    const now = this.clock.now();

    return nodes.map((node) => {
      const latestReadingAt = latestReadings.get(node.id) ?? null;
      return {
        id: node.id,
        slug: node.slug,
        displayName: node.displayName,
        location: node.location,
        kind: node.kind,
        status: node.status,
        online: isNodeOnline(
          {
            online: node.online,
            lastSeenAt: node.lastSeenAt,
            latestReadingAt,
          },
          now,
        ),
        lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
        agentName: node.agentName,
        agentVersion: node.agentVersion,
        contractStanding: findContractStanding(node.capabilities),
        availableUpdate: this.agentReleases.findAvailableUpdate(node),
        capabilities: node.capabilities,
        zoneId: node.zoneId,
        deviceCount: deviceCounts.get(node.id) ?? 0,
        latestReadingAt: latestReadingAt?.toISOString() ?? null,
      };
    });
  }

  private async countDevicesByNode(
    ids: string[],
  ): Promise<Map<string, number>> {
    const rows = await this.devices
      .createQueryBuilder('device')
      .select('device.nodeId', 'nodeId')
      .addSelect('COUNT(*)', 'count')
      .where('device.nodeId IN (:...ids)', { ids })
      .groupBy('device.nodeId')
      .getRawMany<{ nodeId: string; count: string }>();
    return new Map(rows.map((row) => [row.nodeId, Number(row.count)]));
  }

  private async findLatestReadingByNode(
    ids: string[],
  ): Promise<Map<string, Date>> {
    const rows = await this.readings
      .createQueryBuilder('reading')
      .select('reading.nodeId', 'nodeId')
      .addSelect('MAX(reading.createdAt)', 'latest')
      .where('reading.nodeId IN (:...ids)', { ids })
      .groupBy('reading.nodeId')
      .getRawMany<{ nodeId: string; latest: Date | string }>();
    return new Map(rows.map((row) => [row.nodeId, new Date(row.latest)]));
  }
}

function hasOnlineChanged(liveness: PublishedLiveness, now: Date): boolean {
  return isNodeOnline(liveness.evidence, now) !== liveness.isPublishedOnline;
}

function newerOf(known: Date | null, candidate: Date): Date {
  if (known === null) return candidate;
  return candidate > known ? candidate : known;
}

function parseInstant(isoInstant: string | null): Date | null {
  return isoInstant === null ? null : new Date(isoInstant);
}

function rejectionFor(status: NodeStatus): SampleRejection {
  return status === NodeStatus.Disabled ? 'disabled' : 'pending';
}

function toHelloFacts(hello: NodeHello): HelloFacts {
  return {
    nodeId: hello.nodeId,
    kind: hello.kind,
    agentName: hello.agentName,
    agentVersion: hello.agentVersion,
    capabilities: hello.capabilities,
    bootId: hello.bootId,
    receivedAt: hello.receivedAt,
  };
}
