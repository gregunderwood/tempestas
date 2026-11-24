import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { In, Repository } from 'typeorm';
import { Subject, Subscription, type Observable } from 'rxjs';
import {
  ApiErrorCode,
  NodeUpdateOutcome,
  type AgentApp,
  type NodeUpdateSummary,
} from '@tempestas/domain';
import { AgentReleasesService } from '../agent-releases/agent-releases.service';
import { Clock } from '../common/clock';
import { describeError } from '../common/describe-error';
import {
  HardwareService,
  type UpdateStatusReport,
} from '../hardware/hardware.service';
import { translateHardwareError } from '../hardware/hardware-http-error';
import { NodeEntity, NodeUpdateEntity } from './models';
import {
  applyUpdateStatus,
  findRollBackVersion,
  findUpdateRefusal,
  isStalled,
  timeOut,
  toNodeUpdate,
  type UpdateConditions,
} from './node-update-rules';

export const STALLED_UPDATE_SWEEP_MS = 30_000;
const AGENT_RELEASES_URL_SETTING = 'AGENT_RELEASES_URL';
const TRAILING_SLASHES = /\/+$/;

interface UpdateTarget {
  version: string;
  isRollBack: boolean;
}

// Sends one node at a time an update from the web, and keeps what each node reported.
@Injectable()
export class NodeUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NodeUpdatesService.name);
  private readonly subscriptions = new Subscription();
  private readonly changes = new Subject<void>();
  private readonly releasesUrl: string | null;
  private queue: Promise<unknown> = Promise.resolve();

  /** Fires when any node's update summary may have changed, including the one-at-a-time block. */
  readonly changes$: Observable<void> = this.changes.asObservable();

  constructor(
    @InjectRepository(NodeEntity)
    private readonly nodes: Repository<NodeEntity>,
    @InjectRepository(NodeUpdateEntity)
    private readonly updates: Repository<NodeUpdateEntity>,
    private readonly hardware: HardwareService,
    private readonly agentReleases: AgentReleasesService,
    private readonly clock: Clock,
    config: ConfigService,
  ) {
    this.releasesUrl = readReleasesUrl(config);
  }

  onModuleInit(): void {
    this.subscriptions.add(
      this.hardware.updateStatuses$.subscribe((status) =>
        this.runLogged('record an update status', () =>
          this.recordStatus(status),
        ),
      ),
    );
  }

  onModuleDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  updateToOffered(nodeId: string): Promise<void> {
    return this.serially(async () => {
      const node = await this.findNode(nodeId);
      const version = this.agentReleases.findAvailableUpdate(node);
      if (!version) {
        throw new ConflictException({
          code: ApiErrorCode.UpdateNotAvailable,
          message: `No newer release is offered for "${node.slug}".`,
        });
      }
      await this.send(node, { version, isRollBack: false });
    });
  }

  rollBack(nodeId: string): Promise<void> {
    return this.serially(async () => {
      const node = await this.findNode(nodeId);
      const version = this.findOfferedRollBack(
        node,
        await this.findLastHealthyUpdate(node.id),
      );
      if (!version) {
        throw new ConflictException({
          code: ApiErrorCode.UpdateNotAvailable,
          message: `"${node.slug}" has no earlier release to roll back to.`,
        });
      }
      await this.send(node, { version, isRollBack: true });
    });
  }

  async summarize(
    nodes: NodeEntity[],
  ): Promise<Map<string, NodeUpdateSummary>> {
    const ids = nodes.map((node) => node.id);
    const latestUpdates = await this.findLatestUpdates(ids, {});
    const lastHealthyUpdates = await this.findLatestUpdates(ids, {
      outcome: NodeUpdateOutcome.Healthy,
    });
    const conditions = await this.readConditions();
    return new Map(
      nodes.map((node) => {
        const lastUpdate = latestUpdates.get(node.id) ?? null;
        const summary: NodeUpdateSummary = {
          blockedBecause: findUpdateRefusal(node, conditions)?.message ?? null,
          rollBackVersion: this.findOfferedRollBack(
            node,
            lastHealthyUpdates.get(node.id) ?? null,
          ),
          lastUpdate: lastUpdate ? toNodeUpdate(lastUpdate) : null,
        };
        return [node.id, summary];
      }),
    );
  }

  @Interval(STALLED_UPDATE_SWEEP_MS)
  sweepStalledUpdates(): Promise<void> {
    return this.runLogged('time out stalled updates', () =>
      this.timeOutStalledUpdates(),
    );
  }

  private async send(node: NodeEntity, target: UpdateTarget): Promise<void> {
    const refusal = findUpdateRefusal(node, await this.readConditions());
    if (refusal) throw new ConflictException(refusal);

    const app = node.agentName as AgentApp;
    const bundle = this.agentReleases.findBundle(app, target.version);
    if (!bundle || !this.releasesUrl) {
      throw new ConflictException({
        code: ApiErrorCode.UpdateNotAvailable,
        message: `${app} ${target.version} is not offered.`,
      });
    }

    // Saved before the publish: a fast node can report before `sendUpdate` resolves.
    const update = await this.updates.save(
      this.updates.create({
        id: randomUUID(),
        nodeId: node.id,
        app,
        fromVersion: node.agentVersion,
        toVersion: target.version,
        isRollBack: target.isRollBack,
        lastState: null,
        outcome: NodeUpdateOutcome.InProgress,
        reason: null,
        startedAt: this.clock.now(),
        finishedAt: null,
      }),
    );
    try {
      await this.hardware.sendUpdate(node.slug, {
        id: update.id,
        app,
        version: target.version,
        manifestUrl: this.releasesUrl + bundle.release.manifestPath,
        manifestSha256: bundle.release.manifestSha256,
      });
    } catch (error: unknown) {
      await this.updates.delete(update.id);
      throw translateHardwareError(error);
    }
    this.logger.warn(
      `Sent "${node.slug}" ${target.isRollBack ? 'a roll back' : 'an update'} from ${node.agentVersion} to ${target.version} (update ${update.id})`,
    );
    this.changes.next();
  }

  private async recordStatus(status: UpdateStatusReport): Promise<void> {
    const update = await this.findUpdateFrom(status);
    if (!update) return;
    if (!applyUpdateStatus(update, status, this.clock.now())) return;
    await this.updates.save(update);
    this.logStatus(status, update);
    this.changes.next();
  }

  private async timeOutStalledUpdates(): Promise<void> {
    const now = this.clock.now();
    const inProgress = await this.updates.find({
      where: { outcome: NodeUpdateOutcome.InProgress },
    });
    const stalled = inProgress.filter((update) => isStalled(update, now));
    for (const update of stalled) {
      timeOut(update, now);
      await this.updates.save(update);
      this.logger.warn(`Update ${update.id} timed out: ${update.reason}`);
    }
    if (stalled.length > 0) this.changes.next();
  }

  // The status topic carries the node's slug, so a node can only speak for its own updates.
  private async findUpdateFrom(
    status: UpdateStatusReport,
  ): Promise<NodeUpdateEntity | null> {
    if (!isUUID(status.id)) return null;
    const update = await this.updates.findOne({
      where: { id: status.id },
      relations: { node: true },
    });
    if (!update || update.node.slug !== status.nodeId) {
      this.logger.debug(
        `Update status ${status.id} from "${status.nodeId}" matches no update sent to it`,
      );
      return null;
    }
    return update;
  }

  private logStatus(
    status: UpdateStatusReport,
    update: NodeUpdateEntity,
  ): void {
    const message = `"${status.nodeId}" update ${update.id} to ${update.toVersion}: ${status.state}${status.reason ? ` (${status.reason})` : ''}`;
    if (update.outcome === NodeUpdateOutcome.Healthy) {
      this.logger.log(message);
    } else if (update.outcome === NodeUpdateOutcome.InProgress) {
      this.logger.debug(message);
    } else {
      this.logger.warn(message);
    }
  }

  private findOfferedRollBack(
    node: NodeEntity,
    lastHealthyUpdate: NodeUpdateEntity | null,
  ): string | null {
    const version = findRollBackVersion(node, lastHealthyUpdate);
    if (!version || !node.agentName) return null;
    return this.agentReleases.findBundle(node.agentName, version)
      ? version
      : null;
  }

  private async readConditions(): Promise<UpdateConditions> {
    const inProgress = await this.updates.findOne({
      where: { outcome: NodeUpdateOutcome.InProgress },
      relations: { node: true },
    });
    return {
      isReleasesUrlSet: this.releasesUrl !== null,
      isLeader: this.hardware.isLeader,
      updateInProgress: inProgress ? { nodeSlug: inProgress.node.slug } : null,
    };
  }

  private async findLatestUpdates(
    nodeIds: string[],
    filter: Partial<Pick<NodeUpdateEntity, 'outcome'>>,
  ): Promise<Map<string, NodeUpdateEntity>> {
    if (nodeIds.length === 0) return new Map();
    const rows = await this.updates
      .createQueryBuilder('update')
      .distinctOn(['update.nodeId'])
      .where({ ...filter, nodeId: In(nodeIds) })
      .orderBy('update.nodeId')
      .addOrderBy('update.startedAt', 'DESC')
      .getMany();
    return new Map(rows.map((row) => [row.nodeId, row]));
  }

  private async findLastHealthyUpdate(
    nodeId: string,
  ): Promise<NodeUpdateEntity | null> {
    return this.updates.findOne({
      where: { nodeId, outcome: NodeUpdateOutcome.Healthy },
      order: { startedAt: 'DESC' },
    });
  }

  private async findNode(id: string): Promise<NodeEntity> {
    const node = await this.nodes.findOne({ where: { id } });
    if (!node) {
      throw new NotFoundException({
        code: ApiErrorCode.NotFound,
        message: `Node ${id} not found`,
      });
    }
    return node;
  }

  // One at a time, so two quick presses cannot both pass the one-node-at-a-time check.
  private serially<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private runLogged(action: string, task: () => Promise<void>): Promise<void> {
    return this.serially(task).catch((error: unknown) => {
      this.logger.error(`Could not ${action}: ${describeError(error)}`);
    });
  }
}

function readReleasesUrl(config: ConfigService): string | null {
  const url = config.get<string>(AGENT_RELEASES_URL_SETTING, '').trim();
  return url === '' ? null : url.replace(TRAILING_SLASHES, '');
}
