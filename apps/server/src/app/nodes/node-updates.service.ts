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
import {
  AgentReleasesService,
  describeWhyNotUpdatable,
} from '../agent-releases/agent-releases.service';
import { Clock } from '../common/clock';
import { describeError } from '../common/describe-error';
import {
  HardwareService,
  type UpdateStatusReport,
} from '../hardware/hardware.service';
import { translateHardwareError } from '../hardware/hardware-http-error';
import { SensorReadingEntity } from '../readings/models';
import { NodeEntity, NodeUpdateEntity } from './models';
import { isNodeOnline } from './node-registry';
import {
  applyUpdateStatus,
  findRollBackVersion,
  findUpdateRefusal,
  isNewsAbout,
  isStalled,
  readReleasesAddress,
  timeOut,
  toNodeUpdate,
  type ReleasesAddress,
  type UpdateCandidate,
  type UpdateConditions,
} from './node-update-rules';

export const STALLED_UPDATE_SWEEP_MS = 30_000;
const AGENT_RELEASES_URL_SETTING = 'AGENT_RELEASES_URL';

interface UpdateTarget {
  version: string;
  isRollBack: boolean;
}

interface UpdateHistory {
  lastUpdate: NodeUpdateEntity | null;
  lastHealthyUpdate: NodeUpdateEntity | null;
}

const NO_HISTORY: UpdateHistory = { lastUpdate: null, lastHealthyUpdate: null };

@Injectable()
export class NodeUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NodeUpdatesService.name);
  private readonly subscriptions = new Subscription();
  private readonly changes = new Subject<void>();
  private readonly releasesAddress: ReleasesAddress;
  private queue: Promise<unknown> = Promise.resolve();

  /** Fires when any node's update summary may have changed, including the one-at-a-time block. */
  readonly changes$: Observable<void> = this.changes.asObservable();

  constructor(
    @InjectRepository(NodeEntity)
    private readonly nodes: Repository<NodeEntity>,
    @InjectRepository(NodeUpdateEntity)
    private readonly updates: Repository<NodeUpdateEntity>,
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    private readonly hardware: HardwareService,
    private readonly agentReleases: AgentReleasesService,
    private readonly clock: Clock,
    config: ConfigService,
  ) {
    this.releasesAddress = readReleasesAddress(
      config.get<string>(AGENT_RELEASES_URL_SETTING, ''),
    );
  }

  onModuleInit(): void {
    if ('problem' in this.releasesAddress) {
      this.logger.warn(
        `Nodes cannot be updated from the web: ${this.releasesAddress.problem}`,
      );
    }
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

  updateToOffered(nodeId: string, confirmedVersion: string): Promise<void> {
    return this.runSerially(async () => {
      const node = await this.findNode(nodeId);
      const version = requireConfirmedVersion(
        node,
        this.agentReleases.findAvailableUpdate(node),
        confirmedVersion,
      );
      await this.send(node, { version, isRollBack: false });
    });
  }

  rollBack(nodeId: string, confirmedVersion: string): Promise<void> {
    return this.runSerially(async () => {
      const node = await this.findNode(nodeId);
      const history = await this.findHistories([node.id]);
      const version = requireConfirmedVersion(
        node,
        this.findOfferedRollBack(
          node,
          history.get(node.id)?.lastHealthyUpdate ?? null,
        ),
        confirmedVersion,
      );
      await this.send(node, { version, isRollBack: true });
    });
  }

  async summarize(
    candidates: UpdateCandidate[],
  ): Promise<Map<string, NodeUpdateSummary>> {
    const histories = await this.findHistories(
      candidates.map((candidate) => candidate.node.id),
    );
    const conditions = await this.readConditions();
    return new Map(
      candidates.map((candidate) => {
        const { lastUpdate, lastHealthyUpdate } =
          histories.get(candidate.node.id) ?? NO_HISTORY;
        const summary: NodeUpdateSummary = {
          notUpdatableBecause: describeWhyNotUpdatable(candidate.node),
          blockedBecause:
            findUpdateRefusal(candidate, conditions)?.message ?? null,
          rollBackVersion: this.findOfferedRollBack(
            candidate.node,
            lastHealthyUpdate,
          ),
          lastUpdate: lastUpdate ? toNodeUpdate(lastUpdate) : null,
        };
        return [candidate.node.id, summary];
      }),
    );
  }

  @Interval(STALLED_UPDATE_SWEEP_MS)
  sweepStalledUpdates(): Promise<void> {
    return this.runLogged('time out stalled updates', () =>
      this.timeOutStalledUpdates(),
    );
  }

  // Published before it is saved: the queue holds the node's first status until the save is done.
  private async send(node: NodeEntity, target: UpdateTarget): Promise<void> {
    const candidate = { node, isOnline: await this.isOnline(node) };
    const refusal = findUpdateRefusal(candidate, await this.readConditions());
    if (refusal) throw new ConflictException(refusal);

    const app = node.agentName as AgentApp;
    const bundle = this.agentReleases.findBundle(app, target.version);
    if (!bundle || !('url' in this.releasesAddress)) {
      throw new ConflictException({
        code: ApiErrorCode.UpdateNotAvailable,
        message: `${app} ${target.version} is not offered.`,
      });
    }

    const id = randomUUID();
    try {
      await this.hardware.sendUpdate(node.slug, {
        id,
        app,
        version: target.version,
        manifestUrl: this.releasesAddress.url + bundle.release.manifestPath,
        manifestSha256: bundle.release.manifestSha256,
      });
    } catch (error: unknown) {
      throw translateHardwareError(error);
    }
    await this.updates.save(
      this.updates.create({
        id,
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
    this.logger.warn(
      `Sent "${node.slug}" ${target.isRollBack ? 'a roll back' : 'an update'} from ${node.agentVersion} to ${target.version} (update ${id})`,
    );
    this.changes.next();
  }

  private async recordStatus(status: UpdateStatusReport): Promise<void> {
    const update = await this.findUpdateFrom(status);
    if (!update || !isNewsAbout(update, status)) return;
    applyUpdateStatus(update, status, this.clock.now());
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
      releasesUrlProblem:
        'problem' in this.releasesAddress ? this.releasesAddress.problem : null,
      isLeader: this.hardware.isLeader,
      updateInProgress: inProgress ? { nodeSlug: inProgress.node.slug } : null,
    };
  }

  // The page's own `online`, so a node it shows as offline is never sent an update.
  private async isOnline(node: NodeEntity): Promise<boolean> {
    const latestReading = await this.readings.findOne({
      where: { nodeId: node.id },
      order: { createdAt: 'DESC' },
    });
    return isNodeOnline(
      {
        online: node.online,
        lastSeenAt: node.lastSeenAt,
        latestReadingAt: latestReading?.createdAt ?? null,
      },
      this.clock.now(),
    );
  }

  // Every row, newest first: a node has one per update, so this stays small.
  private async findHistories(
    nodeIds: string[],
  ): Promise<Map<string, UpdateHistory>> {
    if (nodeIds.length === 0) return new Map();
    const newestFirst = await this.updates.find({
      where: { nodeId: In(nodeIds) },
      order: { startedAt: 'DESC' },
    });
    const histories = new Map<string, UpdateHistory>();
    for (const update of newestFirst) {
      const history = histories.get(update.nodeId) ?? { ...NO_HISTORY };
      history.lastUpdate ??= update;
      if (update.outcome === NodeUpdateOutcome.Healthy) {
        history.lastHealthyUpdate ??= update;
      }
      histories.set(update.nodeId, history);
    }
    return histories;
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
  private runSerially<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private runLogged(action: string, task: () => Promise<void>): Promise<void> {
    return this.runSerially(task).catch((error: unknown) => {
      this.logger.error(`Could not ${action}: ${describeError(error)}`);
    });
  }
}

// What the page offered can change while the confirmation is open, by another browser or a deploy.
function requireConfirmedVersion(
  node: NodeEntity,
  offeredVersion: string | null,
  confirmedVersion: string,
): string {
  if (offeredVersion === null) {
    throw new ConflictException({
      code: ApiErrorCode.UpdateNotAvailable,
      message: `${confirmedVersion} is no longer offered for "${node.slug}".`,
    });
  }
  if (offeredVersion !== confirmedVersion) {
    throw new ConflictException({
      code: ApiErrorCode.UpdateNotAvailable,
      message: `"${node.slug}" is now offered ${offeredVersion}, not ${confirmedVersion}. Check the page and confirm again.`,
    });
  }
  return offeredVersion;
}
