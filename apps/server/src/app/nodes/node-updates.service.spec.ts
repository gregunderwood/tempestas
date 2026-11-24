import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import type { Repository } from 'typeorm';
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
  type UpdateStatusReport,
} from '../hardware/hardware.service';
import type { NodeEntity, NodeUpdateEntity } from './models';
import { FINAL_STATE_WAIT_MS } from './node-update-rules';
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
    capabilities: CAPABILITIES,
    ...overrides,
  } as NodeEntity;
}

function matches(row: NodeUpdateEntity, where: Partial<NodeUpdateEntity>) {
  return Object.entries(where).every(
    ([field, value]) => row[field as keyof NodeUpdateEntity] === value,
  );
}

interface Scenario {
  nodes?: NodeEntity[];
  releasesUrl?: string;
  isLeader?: boolean;
}

async function makeService({
  nodes = [patji()],
  releasesUrl = RELEASES_URL,
  isLeader = true,
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
    delete: vi.fn(async (id: string) => {
      updateRows.splice(
        updateRows.findIndex((row) => row.id === id),
        1,
      );
    }),
    find: vi.fn(async ({ where }: { where: Partial<NodeUpdateEntity> }) =>
      updateRows.filter((row) => matches(row, where)).map(withNode),
    ),
    findOne: vi.fn(async ({ where }: { where: Partial<NodeUpdateEntity> }) => {
      const found = updateRows
        .filter((row) => matches(row, where))
        .sort(
          (first, second) =>
            second.startedAt.getTime() - first.startedAt.getTime(),
        )[0];
      return found ? withNode(found) : null;
    }),
  } as unknown as Repository<NodeUpdateEntity>;

  const statuses = new Subject<UpdateStatusReport>();
  const sendUpdate = vi.fn(async () => undefined);
  const hardware = {
    isLeader,
    sendUpdate,
    updateStatuses$: statuses.asObservable(),
  } as unknown as HardwareService;
  const clock = new FixedClock(NOW);

  const service = new NodeUpdatesService(
    nodeRepository,
    updateRepository,
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

  return { service, updateRows, sendUpdate, clock, changes, report, deliver };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('NodeUpdatesService.updateToOffered', () => {
  it('sends the offered release with its manifest address, and records it in progress', async () => {
    const { service, updateRows, sendUpdate, changes } = await makeService();

    await service.updateToOffered('patji-uuid');

    expect(updateRows).toHaveLength(1);
    expect(updateRows[0]).toMatchObject({
      nodeId: 'patji-uuid',
      fromVersion: '1.1.0',
      toVersion: '1.1.1',
      isRollBack: false,
      outcome: NodeUpdateOutcome.InProgress,
      startedAt: NOW,
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

    await service.updateToOffered('patji-uuid');

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

    await expect(service.updateToOffered('patji-uuid')).rejects.toMatchObject({
      response: { code: ApiErrorCode.UpdatesNotConfigured },
    });
    expect(sendUpdate).not.toHaveBeenCalled();
  });

  it('refuses a node already on the newest release', async () => {
    const { service } = await makeService({
      nodes: [patji({ agentVersion: '1.1.1' })],
    });

    await expect(service.updateToOffered('patji-uuid')).rejects.toMatchObject({
      response: { code: ApiErrorCode.UpdateNotAvailable },
    });
  });

  it('refuses a second update while the first is in progress, even on a double press', async () => {
    const { service, sendUpdate } = await makeService({
      nodes: [patji(), patji({ id: 'elantris-uuid', slug: 'elantris' })],
    });

    const results = await Promise.allSettled([
      service.updateToOffered('patji-uuid'),
      service.updateToOffered('elantris-uuid'),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(sendUpdate).toHaveBeenCalledTimes(1);
  });

  it('forgets the update when it could not be sent', async () => {
    const { service, updateRows, sendUpdate } = await makeService();
    sendUpdate.mockRejectedValueOnce(
      new HardwareError(ApiErrorCode.HardwareUnreachable, 'broker gone'),
    );

    await expect(service.updateToOffered('patji-uuid')).rejects.toMatchObject({
      status: 503,
    });
    expect(updateRows).toHaveLength(0);
  });
});

describe('NodeUpdatesService status tracking', () => {
  it('follows the node through to healthy', async () => {
    const { service, updateRows, report } = await makeService();
    await service.updateToOffered('patji-uuid');

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
    await service.updateToOffered('patji-uuid');

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
    await service.updateToOffered('patji-uuid');

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
    await service.updateToOffered('patji-uuid');

    clock.set(new Date(NOW.getTime() + FINAL_STATE_WAIT_MS));
    await service.sweepStalledUpdates();

    expect(updateRows[0].outcome).toBe(NodeUpdateOutcome.TimedOut);
    await service.updateToOffered('patji-uuid');
    expect(sendUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('NodeUpdatesService.rollBack', () => {
  it('sends the version from before the last healthy update', async () => {
    const node = patji();
    const { service, updateRows, sendUpdate, report } = await makeService({
      nodes: [node],
    });
    await service.updateToOffered('patji-uuid');
    await report(UpdateState.Healthy);
    node.agentVersion = '1.1.1';

    await service.rollBack('patji-uuid');

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

    await expect(service.rollBack('patji-uuid')).rejects.toMatchObject({
      response: { code: ApiErrorCode.UpdateNotAvailable },
    });
  });
});
