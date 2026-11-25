import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import {
  NODE_HEALTH_DEFAULT_DAYS,
  NODE_HEALTH_GAP_MINUTES,
  NodeStatus,
  NodeUpdateOutcome,
  type Node,
  type NodeHealthQuery,
  type NodeHealthReport,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { MILLISECONDS_PER_DAY } from '../common/time-units';
import { NodeUpdateEntity } from '../nodes/models';
import { NodesService } from '../nodes/nodes.service';
import { SensorReadingEntity } from '../readings/models';
import {
  findNodeReadingSpans,
  findReadingBreaks,
} from '../readings/reading-breaks';
import type { ReadingWindow } from '../readings/reading-window';
import {
  resolveDefaultTimezone,
  resolveZoneDaylight,
} from '../readings/zone-daylight';
import { ZoneEntity } from '../zones/models';
import {
  summariseNodeHealth,
  type HealthNode,
  type NodeVersionChange,
} from './node-health';

@Injectable()
export class NodeHealthService {
  constructor(
    @InjectRepository(ZoneEntity)
    private readonly zones: Repository<ZoneEntity>,
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    @InjectRepository(NodeUpdateEntity)
    private readonly updates: Repository<NodeUpdateEntity>,
    private readonly nodes: NodesService,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async buildNodeHealth(query: NodeHealthQuery): Promise<NodeHealthReport> {
    const days = query.days ?? NODE_HEALTH_DEFAULT_DAYS;
    const now = this.clock.now();
    const window = {
      from: new Date(now.getTime() - days * MILLISECONDS_PER_DAY),
      to: now,
    };
    const [nodes, breaks, readingSpans, versionChanges] = await Promise.all([
      this.findHealthNodes(),
      findReadingBreaks(this.readings, window, NODE_HEALTH_GAP_MINUTES),
      findNodeReadingSpans(this.readings, window),
      this.findVersionChanges(window),
    ]);
    return {
      days,
      generatedAt: now.toISOString(),
      nodes: summariseNodeHealth({
        nodes,
        breaks,
        readingSpans,
        versionChanges,
        gapMinutes: NODE_HEALTH_GAP_MINUTES,
        now,
      }),
    };
  }

  private async findHealthNodes(): Promise<HealthNode[]> {
    const [nodes, zones] = await Promise.all([
      this.nodes.findAll(),
      this.zones.find(),
    ]);
    return nodes
      .filter((node) => node.status === NodeStatus.Admitted)
      .sort((first, second) => first.slug.localeCompare(second.slug))
      .map((node) => ({
        nodeId: node.slug,
        nodeName: node.displayName,
        timezone: this.resolveTimezone(node, zones),
        hasSensors: node.capabilities.sensors.length > 0,
      }));
  }

  // History, not control: a node with no zone still gets the deployment's timezone.
  private resolveTimezone(node: Node, zones: readonly ZoneEntity[]): string {
    const zone = zones.find((candidate) => candidate.id === node.zoneId);
    return resolveZoneDaylight(
      zone?.rulesConfig,
      resolveDefaultTimezone(this.config),
    ).timezone;
  }

  private async findVersionChanges(
    window: ReadingWindow,
  ): Promise<NodeVersionChange[]> {
    const healthyUpdates = await this.updates.find({
      where: {
        outcome: NodeUpdateOutcome.Healthy,
        finishedAt: MoreThanOrEqual(window.from),
      },
      relations: { node: true },
    });
    return healthyUpdates.filter(hasFinished).map((update) => ({
      nodeId: update.node.slug,
      fromVersion: update.fromVersion,
      toVersion: update.toVersion,
      isRollBack: update.isRollBack,
      at: update.finishedAt.toISOString(),
    }));
  }
}

type FinishedUpdate = NodeUpdateEntity & { finishedAt: Date };

// The query already requires finishedAt; this only tells the compiler so.
function hasFinished(update: NodeUpdateEntity): update is FinishedUpdate {
  return update.finishedAt !== null;
}
