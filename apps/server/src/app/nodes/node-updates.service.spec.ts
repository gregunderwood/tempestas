import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import { FindOperator, type Repository } from 'typeorm';
import {
  AgentApp,
  ApiErrorCode,
  NodeStatus,
  NodeUpdateOutcome,
  UpdateState,
  type NodeCapabilities,
} from '@tempestas/domain';
import { AgentReleasesService } from '../agent-releases/agent-releases.service';
import {
  makeAgentReleasesRoot,
  writeBundle,
} from '../agent-releases/agent-release-bundles.fixtures';
import { FixedClock } from '../common/clock';
import {
  HardwareError,
  type HardwareService,
  type UpdateOrder,
  type UpdateStatusReport,
} from '../hardware/hardware.service';
import type { SensorReadingEntity } from '../readings/models';
import type { NodeEntity, NodeUpdateEntity } from './models';
import { SILENCE_LIMIT_MS } from './node-update-rules';
import { NodeUpdatesService } from './node-updates.service';

const NOW = new Date('2026-11-24T12:00:00Z');
const RELEASES_URL = 'http://192.168.2.70:7000';

const CAPABILITIES: NodeCapabilities = {
  contractVersion: 1,
  contractMinor: 1,
  sensors: [],
  hasRtc: true,
};

function patji(overrides: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id: 'patji-uuid',
    slug: 'patji',
    status: NodeStatus.Admitted,
    online: true,
    agentName: AgentApp.Linux,
    agentVersion: '1.1.0',
    lastSeenAt: NOW,
    capabilities: CAPABILITIES,
    ...overrides,
  } as NodeEntity;
}

function matches(row: NodeUpdateEntity, where: Record<string, unknown>) {
  return Object.entries(where).every(([field, value]) => {
    const stored = row[field as keyof NodeUpdateEntity];
    return value instanceof FindOperator
      ? (value.value as unknown[]).includes(stored)
      : stored === value;
  });
}

function newestFirst(first: NodeUpdateEntity, second: NodeUpdateEntity) {
  return second.startedAt.getTime() - first.startedAt.getTime();
}

interface Scenario {
  nodes?: NodeEntity[];
  releasesUrl?: string;
  isLeader?: boolean;
  hasRecentReading?: boolean;
}

async function makeService({
  nodes = [patji()],
  releasesUrl = RELEASES_URL,
  isLeader = true,
  hasRecentReading = true,
}: Scenario = {}) {
  const root = makeAgentReleasesRoot();
  writeBundle(root, AgentApp.Linux, '1.1.0');
  writeBundle(root, AgentApp.Linux, '1.1.1');
  const agentReleases = new AgentReleasesService(root);
  await agentReleases.onModuleInit();

  const updateRows: NodeUpdateEntity[] = [];
  const withNode = (row: NodeUpdateEntity) => ({
    ...row,
    node: nodes.find((node) => node.id === row.nodeId) as NodeEntity,
  });
  const nodeRepository = {
    findOne: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        nodes.find((node) => node.id === where.id) ?? null,
    ),
  } as unknown as Repository<NodeEntity>;
  const updateRepository = {
    create: (fields: NodeUpdateEntity) => ({ ...fields }),
    save: vi.fn(async (row: NodeUpdateEntity) => {
      const index = updateRows.findIndex((stored) => stored.id === row.id);
      if (index === -1) updateRows.push(row);
      else updateRows[index] = row;
      return row;
    }),
    find: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      updateRows
        .filter((row) => matches(row, where))
        .sort(newestFirst)
        .map(withNode),
    ),
    findOne: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const [found] = updateRows
        .filter((row) => matches(row, where))
        .sort(newestFirst);
      return found ? withNode(found) : null;
    }),
  } as unknown as Repository<NodeUpdateEntity>;
  const clock = new FixedClock(NOW);
  const readingRepository = {
    findOne: async () => (hasRecentReading ? { createdAt: clock.now() } : null),
  } as unknown as Repository<SensorReadingEntity>;

  const statuses = new Subject<UpdateStatusReport>();
  const sendUpdate = vi.fn(async () => undefined);
  const hardware = {
    isLeader,
    sendUpdate,
    updateStatuses$: statuses.asObservable(),
  } as unknown as HardwareService;

  const service = new NodeUpdatesService(
    nodeRepository,
    updateRepository,
    readingRepository,
    hardware,
    agentReleases,
    clock,
    new ConfigService({ AGENT_RELEASES_URL: releasesUrl }),
  );
  service.onModuleInit();
  const changes = vi.fn();
  service.changes$.subscribe(changes);

  async function deliver(status: UpdateStatusReport) {
    statuses.next(status);
    await settle();
  }

  async function report(state: UpdateState, reason: string | null = null) {
    const [update] = updateRows;
    await deliver({ nodeId: 'patji', id: update.id, state, reason });
  }

  return {
    service,
    updateRows,
    updateRepository,
    sendUpdate,
    clock,
    changes,
    report,
    deliver,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('NodeUpdatesService.updateToOffered', () => {
  it('sends the offered release with its manifest address, and records it in progress', async () => {
    const { service, updateRows, sendUpdate, changes } = await makeService();

    await service.updateToOffered('patji-uuid', '1.1.1');

    expect(updateRows).toHaveLength(1);
    expect(updateRows[0]).toMatchObject({
      nodeId: 'patji-uuid',
      fromVersion: '1.1.0',
      toVersion: '1.1.1',
      isRollBack: false,
      outcome: NodeUpdateOutcome.InProgress,
      startedAt: NOW,
      lastHeardAt: NOW,
    });
    expect(sendUpdate).toHaveBeenCalledWith('patji', {
      id: updateRows[0].id,
      app: AgentApp.Linux,
      version: '1.1.1',
      manifestUrl: `${RELEASES_URL}/api/agent-releases/agent-linux/1.1.1/manifest.json`,
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(changes).toHaveBeenCalled();
  });

  it('drops a trailing slash from the configured address', async () => {
    const { service, sendUpdate } = await makeService({
      releasesUrl: `${RELEASES_URL}/`,
    });

    await service.updateToOffered('patji-uuid', '1.1.1');

    expect(sendUpdate).toHaveBeenCalledWith(
      'patji',
      expect.objectContaining({
        manifestUrl: expect.stringMatching(
          /^http:\/\/192\.168\.2\.70:7000\/api\//,
        ),
      }),
    );
  });

  it('refuses while no releases address is set', async () => {
    const { service, sendUpdate } = await makeService({ releasesUrl: '' });

    await expect(
      service.updateToOffered('patji-uuid', '1.1.1'),
    ).rejects.toMatchObject({
      response: { code: ApiErrorCode.UpdatesNotConfigured },
    });
    expect(sendUpdate).not.toHaveBeenCalled();
  });

  it('refuses a node already on the newest release', async () => {
    const { service } = await makeService({
      nodes: [patji({ agentVersion: '1.1.1' })],
    });

    await expect(
      service.updateToOffered('patji-uuid', '1.1.1'),
    ).rejects.toMatchObject({
      response: { code: ApiErrorCode.UpdateNotAvailable },
    });
  });

  it('refuses a second update while the first is in progress, even on a double press', async () => {
    const { service, sendUpdate } = await makeService({
      nodes: [patji(), patji({ id: 'elantris-uuid', slug: 'elantris' })],
    });

    const results = await Promise.allSettled([
      service.updateToOffered('patji-uuid', '1.1.1'),
      service.updateToOffered('elantris-uuid', '1.1.1'),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(sendUpdate).toHaveBeenCalledTimes(1);
  });

  it('records nothing when the update could not be sent, so no node stays blocked', async () => {
    const { service, updateRows, sendUpdate, changes } = await makeService();
    sendUpdate.mockRejectedValueOnce(
      new HardwareError(ApiErrorCode.HardwareUnreachable, 'broker gone'),
    );

    await expect(
      service.updateToOffered('patji-uuid', '1.1.1'),
    ).rejects.toMatchObject({ status: 503 });
    expect(updateRows).toHaveLength(0);
    expect(changes).not.toHaveBeenCalled();
  });

  it('logs the id of an update it sent but could not record', async () => {
    const { service, updateRepository, sendUpdate } = await makeService();
    vi.mocked(updateRepository.save).mockRejectedValueOnce(
      new Error('database gone'),
    );
    const logError = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(
      service.updateToOffered('patji-uuid', '1.1.1'),
    ).rejects.toThrow('database gone');

    const [, order] = sendUpdate.mock.lastCall as unknown as [
      string,
      UpdateOrder,
    ];
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(
        `update ${order.id} to 1.1.1, but could not record it`,
      ),
    );
    logError.mockRestore();
  });

  it('refuses a version the operator did not confirm', async () => {
    const { service, sendUpdate } = await makeService();

    await expect(
      service.updateToOffered('patji-uuid', '1.1.2'),
    ).rejects.toMatchObject({
      response: {
        code: ApiErrorCode.UpdateNotAvailable,
        message: expect.stringContaining('now offered 1.1.1, not 1.1.2'),
      },
    });
    expect(sendUpdate).not.toHaveBeenCalled();
  });

  it('refuses a node the page shows as offline, though its stored flag says online', async () => {
    const { service, sendUpdate } = await makeService({
      nodes: [patji({ lastSeenAt: null })],
      hasRecentReading: false,
    });

    await expect(
      service.updateToOffered('patji-uuid', '1.1.1'),
    ).rejects.toMatchObject({ response: { code: ApiErrorCode.NodeOffline } });
    expect(sendUpdate).not.toHaveBeenCalled();
  });

  it('refuses an address no node could download from', async () => {
    const { service } = await makeService({ releasesUrl: '192.168.2.70:7000' });

    await expect(
      service.updateToOffered('patji-uuid', '1.1.1'),
    ).rejects.toMatchObject({
      response: {
        code: ApiErrorCode.UpdatesNotConfigured,
        message: expect.stringContaining(
          'is not a plain http(s) server address',
        ),
      },
    });
  });
});

describe('NodeUpdatesService.summarize', () => {
  it('shows the newest update and offers a roll back after a healthy one', async () => {
    const node = patji();
    const { service, report } = await makeService({ nodes: [node] });
    await service.updateToOffered('patji-uuid', '1.1.1');
    await report(UpdateState.Healthy);
    node.agentVersion = '1.1.1';

    const summary = (await service.summarize([{ node, isOnline: true }])).get(
      'patji-uuid',
    );

    expect(summary).toMatchObject({
      notUpdatableBecause: null,
      blockedBecause: null,
      rollBackVersion: '1.1.0',
      lastUpdate: {
        toVersion: '1.1.1',
        outcome: NodeUpdateOutcome.Healthy,
      },
    });
  });

  it('blocks every node while one is updating', async () => {
    const elantris = patji({ id: 'elantris-uuid', slug: 'elantris' });
    const { service } = await makeService({ nodes: [patji(), elantris] });
    await service.updateToOffered('patji-uuid', '1.1.1');

    const summary = (
      await service.summarize([{ node: elantris, isOnline: true }])
    ).get('elantris-uuid');

    expect(summary?.blockedBecause).toContain('"patji" is updating');
    expect(summary?.lastUpdate).toBeNull();
  });

  it('says why an agent that cannot take the command is never offered one', async () => {
    const braize = patji({
      id: 'braize-uuid',
      slug: 'braize',
      agentName: AgentApp.MicroPython,
      agentVersion: '1.0.8',
      capabilities: { ...CAPABILITIES, contractMinor: 0 },
    });
    const { service } = await makeService({ nodes: [braize] });

    const summary = (
      await service.summarize([{ node: braize, isOnline: true }])
    ).get('braize-uuid');

    expect(summary?.notUpdatableBecause).toContain('needs contract 1.1');
  });
});

describe('NodeUpdatesService status tracking', () => {
  it('follows the node through to healthy', async () => {
    const { service, updateRows, report } = await makeService();
    await service.updateToOffered('patji-uuid', '1.1.1');

    await report(UpdateState.Installing);
    expect(updateRows[0].lastState).toBe(UpdateState.Installing);

    await report(UpdateState.Healthy);
    expect(updateRows[0]).toMatchObject({
      outcome: NodeUpdateOutcome.Healthy,
      finishedAt: NOW,
    });
  });

  it('ignores a status for an update it never sent', async () => {
    const { service, updateRows, deliver } = await makeService();
    await service.updateToOffered('patji-uuid', '1.1.1');

    await deliver({
      nodeId: 'patji',
      id: 'not-a-uuid',
      state: UpdateState.Failed,
      reason: null,
    });

    expect(updateRows[0].outcome).toBe(NodeUpdateOutcome.InProgress);
  });

  it("ignores a status about another node's update", async () => {
    const { service, updateRows, deliver } = await makeService();
    await service.updateToOffered('patji-uuid', '1.1.1');

    await deliver({
      nodeId: 'elantris',
      id: updateRows[0].id,
      state: UpdateState.Failed,
      reason: null,
    });

    expect(updateRows[0].outcome).toBe(NodeUpdateOutcome.InProgress);
  });

  it('times out an update with no final state, which frees the next one', async () => {
    const { service, updateRows, clock, sendUpdate } = await makeService();
    await service.updateToOffered('patji-uuid', '1.1.1');

    clock.set(new Date(NOW.getTime() + SILENCE_LIMIT_MS));
    await service.sweepStalledUpdates();

    expect(updateRows[0].outcome).toBe(NodeUpdateOutcome.TimedOut);
    await service.updateToOffered('patji-uuid', '1.1.1');
    expect(sendUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('NodeUpdatesService.rollBack', () => {
  it('sends the version from before the last healthy update', async () => {
    const node = patji();
    const { service, updateRows, sendUpdate, report } = await makeService({
      nodes: [node],
    });
    await service.updateToOffered('patji-uuid', '1.1.1');
    await report(UpdateState.Healthy);
    node.agentVersion = '1.1.1';

    await service.rollBack('patji-uuid', '1.1.0');

    expect(sendUpdate).toHaveBeenLastCalledWith(
      'patji',
      expect.objectContaining({ version: '1.1.0' }),
    );
    expect(updateRows.at(-1)).toMatchObject({
      fromVersion: '1.1.1',
      toVersion: '1.1.0',
      isRollBack: true,
    });
  });

  it('refuses when there is nothing to roll back to', async () => {
    const { service } = await makeService();

    await expect(service.rollBack('patji-uuid', '1.1.0')).rejects.toMatchObject(
      {
        response: { code: ApiErrorCode.UpdateNotAvailable },
      },
    );
  });
});
