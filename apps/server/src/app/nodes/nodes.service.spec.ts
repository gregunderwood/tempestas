import { ConflictException } from '@nestjs/common';
import { FixedClock, SystemClock, type Clock } from '../common/clock';
import type { Repository } from 'typeorm';
import {
  AgentApp,
  NodeKind,
  NodeStatus,
  type NodeCapabilities,
} from '@tempestas/domain';
import type { HardwareService, NodeHello } from '../hardware/hardware.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { DeviceEntity } from '../devices/models';
import type { SensorReadingEntity } from '../readings/models';
import type { ZoneEntity } from '../zones/models';
import { NodesService, ONLINE_SWEEP_INTERVAL_MS } from './nodes.service';
import { NODE_OFFLINE_AFTER_MS } from './node-registry';
import type { NodeEntity } from './models';
import type { NodeUpdatesService } from './node-updates.service';
import { EMPTY } from 'rxjs';
import { AgentReleasesService } from '../agent-releases/agent-releases.service';
import {
  makeAgentReleasesRoot,
  writeBundle,
} from '../agent-releases/agent-release-bundles.fixtures';

const NO_AGENT_RELEASES_DIRECTORY = '/nonexistent/agent-releases';

const nodeUpdatesWithNoHistory = {
  changes$: EMPTY,
  summarize: async () => new Map(),
} as unknown as NodeUpdatesService;

const AT = new Date('2026-01-10T12:00:00Z');

const CAPABILITIES: NodeCapabilities = {
  contractVersion: 1,
  gpio: { pins: [16], supportsReadback: true },
  sensors: [
    {
      sensorId: 'scd4x-0',
      kind: 'scd4x',
      metrics: ['co2'],
      sampleIntervalMs: 10_000,
    },
  ],
  hasRtc: true,
};

function hello(overrides: Partial<NodeHello> = {}): NodeHello {
  return {
    nodeId: 'elantris',
    kind: NodeKind.RaspberryPi,
    agentName: 'agent-linux',
    agentVersion: '1.0.0',
    capabilities: CAPABILITIES,
    bootId: 'boot-1',
    receivedAt: AT,
    ...overrides,
  };
}

function node(overrides: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id: 'node-uuid',
    slug: 'elantris',
    displayName: 'Elantris',
    location: null,
    kind: NodeKind.RaspberryPi,
    status: NodeStatus.Admitted,
    capabilities: CAPABILITIES,
    agentVersion: '1.0.0',
    bootId: 'boot-1',
    online: false,
    lastSeenAt: null,
    zoneId: 'zone-uuid',
    ...overrides,
  } as NodeEntity;
}

interface LatestReadingRow {
  nodeId: string;
  latest: Date;
}

interface ServiceCollaborators {
  clock?: Clock;
  agentReleases?: AgentReleasesService;
}

function makeService(
  initial: NodeEntity[] = [],
  zones: ZoneEntity[] = [],
  {
    clock = new SystemClock(),
    agentReleases = new AgentReleasesService(NO_AGENT_RELEASES_DIRECTORY),
  }: ServiceCollaborators = {},
) {
  const rows = [...initial];
  const latestReadingRows: LatestReadingRow[] = [];
  let nextId = 1;

  const nodeRepository = {
    findOne: vi.fn(
      async ({ where }: { where: { slug?: string; id?: string } }) => {
        return (
          rows.find(
            (row) =>
              (where.slug !== undefined && row.slug === where.slug) ||
              (where.id !== undefined && row.id === where.id),
          ) ?? null
        );
      },
    ),
    find: vi.fn(async () => rows),
    create: vi.fn(
      (fields: Partial<NodeEntity>) => ({ ...fields }) as NodeEntity,
    ),
    save: vi.fn(async (row: NodeEntity) => {
      if (!row.id) row.id = `generated-${nextId++}`;
      if (!rows.includes(row)) rows.push(row);
      return row;
    }),
    remove: vi.fn(async (row: NodeEntity) => {
      rows.splice(rows.indexOf(row), 1);
      return row;
    }),
  } as unknown as Repository<NodeEntity>;

  const aggregate = {
    select: () => aggregate,
    addSelect: () => aggregate,
    where: () => aggregate,
    groupBy: () => aggregate,
    getRawMany: async () => [],
  };
  const deviceRepository = {
    createQueryBuilder: () => aggregate,
  } as unknown as Repository<DeviceEntity>;
  const latestReadingAggregate = {
    ...aggregate,
    select: () => latestReadingAggregate,
    addSelect: () => latestReadingAggregate,
    where: () => latestReadingAggregate,
    groupBy: () => latestReadingAggregate,
    getRawMany: async () => latestReadingRows,
  };
  const readingRepository = {
    createQueryBuilder: () => latestReadingAggregate,
  } as unknown as Repository<SensorReadingEntity>;
  const zoneRepository = {
    findOne: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        zones.find((zone) => zone.id === where.id) ?? null,
    ),
  } as unknown as Repository<ZoneEntity>;
  const recordAcceptedHello = vi.fn();
  const hardware = { recordAcceptedHello } as unknown as HardwareService;
  const publishNodeState = vi.fn();
  const realtime = { publishNodeState } as unknown as RealtimeGateway;

  const service = new NodesService(
    nodeRepository,
    deviceRepository,
    readingRepository,
    zoneRepository,
    hardware,
    realtime,
    clock,
    agentReleases,
    nodeUpdatesWithNoHistory,
  );
  return {
    service,
    rows,
    nodeRepository,
    publishNodeState,
    latestReadingRows,
    recordAcceptedHello,
  };
}

describe('NodesService hello ingest', () => {
  it('registers an unknown node as pending', async () => {
    const { service, rows } = makeService();
    await service.handleHello(hello({ nodeId: 'ghost' }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: 'ghost',
      status: NodeStatus.Pending,
      online: true,
      lastSeenAt: AT,
    });
  });

  it('never changes the status of a node that already exists', async () => {
    for (const status of [
      NodeStatus.Pending,
      NodeStatus.Admitted,
      NodeStatus.Disabled,
    ]) {
      const { service, rows } = makeService([node({ status })]);
      await service.handleHello(hello());
      expect(rows[0].status).toBe(status);
    }
  });

  it('refreshes the node-owned facts on a re-announce', async () => {
    const { service, rows } = makeService([
      node({ agentVersion: '0.9.0', online: false }),
    ]);
    await service.handleHello(
      hello({ agentVersion: '1.0.0', bootId: 'boot-2' }),
    );

    expect(rows[0]).toMatchObject({
      agentVersion: '1.0.0',
      bootId: 'boot-2',
      online: true,
      lastSeenAt: AT,
    });
  });

  it('tells the hardware a hello was accepted only once it is stored', async () => {
    const { service, nodeRepository, recordAcceptedHello } = makeService([
      node(),
    ]);
    const announced = hello({ agentVersion: '1.2.0' });
    recordAcceptedHello.mockImplementation(() =>
      expect(nodeRepository.save).toHaveBeenCalled(),
    );

    await service.handleHello(announced);

    expect(recordAcceptedHello).toHaveBeenCalledWith(announced);
  });

  it('tells the hardware a new node said hello once it is stored', async () => {
    const { service, rows, recordAcceptedHello } = makeService();
    const announced = hello({ nodeId: 'ghost' });

    await service.handleHello(announced);

    expect(rows).toHaveLength(1);
    expect(recordAcceptedHello).toHaveBeenCalledWith(announced);
  });

  it('does not call a hello accepted when storing it fails', async () => {
    const { service, nodeRepository, recordAcceptedHello } = makeService([
      node(),
    ]);
    vi.mocked(nodeRepository.save).mockRejectedValueOnce(
      new Error('database is down'),
    );

    await expect(service.handleHello(hello())).rejects.toThrow(
      'database is down',
    );

    expect(recordAcceptedHello).not.toHaveBeenCalled();
  });

  it('leaves the operator-owned fields alone', async () => {
    const { service, rows } = makeService([
      node({ displayName: 'The Brain', location: 'north end' }),
    ]);
    await service.handleHello(hello());
    expect(rows[0]).toMatchObject({
      displayName: 'The Brain',
      location: 'north end',
    });
  });
});

describe('NodesService.findAll', () => {
  it('tells each node the newer release it could be updated to', async () => {
    const root = makeAgentReleasesRoot();
    writeBundle(root, AgentApp.Linux, '1.1.4');
    const agentReleases = new AgentReleasesService(root);
    await agentReleases.onModuleInit();
    const { service } = makeService(
      [
        node({
          agentName: AgentApp.Linux,
          agentVersion: '1.1.3',
          capabilities: { ...CAPABILITIES, contractMinor: 1 },
        }),
      ],
      [],
      { agentReleases },
    );

    const [listed] = await service.findAll();

    expect(listed.availableUpdate).toBe('1.1.4');
  });
});

describe('NodesService availability', () => {
  it('marks a node online and records the sighting', async () => {
    const { service, rows } = makeService([node({ online: false })]);
    await service.handleAvailability({
      nodeId: 'elantris',
      online: true,
      at: AT,
    });
    expect(rows[0]).toMatchObject({ online: true, lastSeenAt: AT });
  });

  it('does not treat an LWT as a sighting', async () => {
    const seen = new Date('2026-01-10T11:00:00Z');
    const { service, rows } = makeService([
      node({ online: true, lastSeenAt: seen }),
    ]);
    await service.handleAvailability({
      nodeId: 'elantris',
      online: false,
      at: AT,
    });
    expect(rows[0]).toMatchObject({ online: false, lastSeenAt: seen });
  });

  it('ignores a status for a node that has never said hello', async () => {
    const { service, rows } = makeService();
    await service.handleAvailability({ nodeId: 'ghost', online: true, at: AT });
    expect(rows).toHaveLength(0);
  });
});

describe('NodesService.resolveForSample', () => {
  it('accepts an admitted node and hands back its uuid for the FK', async () => {
    const { service } = makeService([node()]);
    await expect(service.resolveForSample('elantris')).resolves.toMatchObject({
      accepted: true,
      node: { id: 'node-uuid' },
    });
  });

  it('rejects pending, disabled and unknown, and says which', async () => {
    const { service } = makeService([
      node({ status: NodeStatus.Pending }),
      node({ id: 'other-uuid', slug: 'rejected', status: NodeStatus.Disabled }),
    ]);

    await expect(service.resolveForSample('elantris')).resolves.toEqual({
      accepted: false,
      reason: 'pending',
    });
    await expect(service.resolveForSample('rejected')).resolves.toEqual({
      accepted: false,
      reason: 'disabled',
    });
    await expect(service.resolveForSample('nobody')).resolves.toEqual({
      accepted: false,
      reason: 'unknown-node',
    });
  });
});

describe('NodesService admission lifecycle', () => {
  it('admits a pending node', async () => {
    const { service, rows } = makeService([
      node({ status: NodeStatus.Pending }),
    ]);
    const admitted = await service.admit('node-uuid', {});
    expect(rows[0].status).toBe(NodeStatus.Admitted);
    expect(admitted.status).toBe(NodeStatus.Admitted);
  });

  it('is idempotent, so a double-clicked admit button is not an error', async () => {
    const { service } = makeService([node({ status: NodeStatus.Pending })]);
    await service.admit('node-uuid', {});
    await expect(service.admit('node-uuid', {})).resolves.toMatchObject({
      status: NodeStatus.Admitted,
    });
  });

  it('assigns the zone as part of admitting', async () => {
    const zone = { id: 'zone-2' } as ZoneEntity;
    const { service, rows } = makeService(
      [node({ status: NodeStatus.Pending })],
      [zone],
    );
    await service.admit('node-uuid', {
      zoneId: 'zone-2',
      displayName: 'North End',
    });
    expect(rows[0]).toMatchObject({
      zoneId: 'zone-2',
      displayName: 'North End',
    });
  });

  it('rejects an admit naming a zone that does not exist', async () => {
    const { service, rows } = makeService([
      node({ status: NodeStatus.Pending }),
    ]);
    await expect(
      service.admit('node-uuid', { zoneId: 'no-such-zone' }),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(rows[0].status).toBe(NodeStatus.Pending);
  });

  it('disables a node without deleting its history', async () => {
    const { service, rows } = makeService([node()]);
    await service.disable('node-uuid');
    expect(rows[0].status).toBe(NodeStatus.Disabled);
    expect(rows).toHaveLength(1);
  });

  it('deletes a pending node, so a typo can be cleaned up', async () => {
    const { service, rows } = makeService([
      node({ status: NodeStatus.Pending }),
    ]);
    await service.remove('node-uuid');
    expect(rows).toHaveLength(0);
  });

  it('refuses to delete an admitted node', async () => {
    const { service, rows } = makeService([node()]);
    await expect(service.remove('node-uuid')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('NodesService node:state fan-out', () => {
  it('publishes a newly announced node as pending', async () => {
    const { service, publishNodeState } = makeService();
    await service.handleHello(hello({ nodeId: 'ghost' }));
    expect(publishNodeState).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'ghost', status: NodeStatus.Pending }),
    );
  });

  it('publishes a re-announce with its new agent version', async () => {
    const { service, publishNodeState } = makeService([
      node({ agentVersion: '0.9.0' }),
    ]);
    await service.handleHello(hello({ agentVersion: '1.0.0' }));
    expect(publishNodeState).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'elantris', agentVersion: '1.0.0' }),
    );
  });

  it('publishes a node coming online, and going offline again', async () => {
    const { service, publishNodeState } = makeService([node()]);
    await service.handleAvailability({
      nodeId: 'elantris',
      online: true,
      at: new Date(),
    });
    await service.handleAvailability({
      nodeId: 'elantris',
      online: false,
      at: new Date(),
    });
    expect(
      publishNodeState.mock.calls.map(([published]) => published.online),
    ).toEqual([true, false]);
  });

  it('publishes the release a node could be updated to, as the list does', async () => {
    const root = makeAgentReleasesRoot();
    writeBundle(root, AgentApp.Linux, '1.1.4');
    const agentReleases = new AgentReleasesService(root);
    await agentReleases.onModuleInit();
    const { service, publishNodeState } = makeService(
      [
        node({
          agentName: AgentApp.Linux,
          agentVersion: '1.1.3',
          capabilities: { ...CAPABILITIES, contractMinor: 1 },
        }),
      ],
      [],
      { agentReleases },
    );
    await service.handleAvailability({
      nodeId: 'elantris',
      online: true,
      at: new Date(),
    });
    expect(publishNodeState).toHaveBeenCalledWith(
      expect.objectContaining({ availableUpdate: '1.1.4' }),
    );
  });

  it('publishes nothing for a node that has never said hello', async () => {
    const { service, publishNodeState } = makeService();
    await service.handleAvailability({ nodeId: 'ghost', online: true, at: AT });
    expect(publishNodeState).not.toHaveBeenCalled();
  });

  it('publishes an admission and a disable, and returns what it published', async () => {
    const { service, publishNodeState } = makeService([
      node({ status: NodeStatus.Pending }),
    ]);
    const admitted = await service.admit('node-uuid', {});
    const disabled = await service.disable('node-uuid');
    expect(publishNodeState.mock.calls).toEqual([[admitted], [disabled]]);
    expect(disabled.status).toBe(NodeStatus.Disabled);
  });

  it('publishes an operator edit', async () => {
    const { service, publishNodeState } = makeService([node()]);
    await service.update('node-uuid', { displayName: 'North End' });
    expect(publishNodeState).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'North End' }),
    );
  });

  it('publishes nothing when an admit is refused', async () => {
    const { service, publishNodeState } = makeService([
      node({ status: NodeStatus.Pending }),
    ]);
    await expect(
      service.admit('node-uuid', { zoneId: 'no-such-zone' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(publishNodeState).not.toHaveBeenCalled();
  });
});

describe('NodesService online deadline', () => {
  const HEARD_AT = new Date('2026-01-10T12:00:00Z');
  const PAST_DEADLINE_SECONDS =
    (NODE_OFFLINE_AFTER_MS + ONLINE_SWEEP_INTERVAL_MS) / 1000;
  const BEFORE_DEADLINE_SECONDS = NODE_OFFLINE_AFTER_MS / 1000 - 60;

  function makeHeardService() {
    const clock = new FixedClock(HEARD_AT);
    const made = makeService([node()], [], { clock });
    return { ...made, clock };
  }

  async function hearNode(service: NodesService): Promise<void> {
    await service.handleAvailability({
      nodeId: 'elantris',
      online: true,
      at: HEARD_AT,
    });
  }

  function publishedOnline(
    publishNodeState: ReturnType<typeof vi.fn>,
  ): boolean[] {
    return publishNodeState.mock.calls.map(([published]) => published.online);
  }

  it('publishes a silent node as offline once the deadline passes', async () => {
    const { service, clock, publishNodeState } = makeHeardService();
    await hearNode(service);
    clock.advanceSeconds(BEFORE_DEADLINE_SECONDS);
    await service.publishLapsedNodes();
    clock.advanceSeconds(PAST_DEADLINE_SECONDS - BEFORE_DEADLINE_SECONDS);
    await service.publishLapsedNodes();
    await service.publishLapsedNodes();
    expect(publishedOnline(publishNodeState)).toEqual([true, false]);
  });

  it('keeps a node online while its readings keep coming', async () => {
    const { service, clock, publishNodeState } = makeHeardService();
    await hearNode(service);
    clock.advanceSeconds(BEFORE_DEADLINE_SECONDS);
    await service.noteReading('node-uuid', clock.now());
    clock.advanceSeconds(PAST_DEADLINE_SECONDS - BEFORE_DEADLINE_SECONDS);
    await service.publishLapsedNodes();
    expect(publishedOnline(publishNodeState)).toEqual([true]);
  });

  it('publishes a stale node as online as soon as a reading brings it back', async () => {
    const { service, clock, publishNodeState, latestReadingRows } =
      makeHeardService();
    await hearNode(service);
    clock.advanceSeconds(PAST_DEADLINE_SECONDS);
    await service.publishLapsedNodes();
    latestReadingRows.push({ nodeId: 'node-uuid', latest: clock.now() });
    await service.noteReading('node-uuid', clock.now());
    expect(publishedOnline(publishNodeState)).toEqual([true, false, true]);
  });

  it('leaves a node that said it was offline alone', async () => {
    const { service, clock, publishNodeState } = makeHeardService();
    await service.handleAvailability({
      nodeId: 'elantris',
      online: false,
      at: HEARD_AT,
    });
    clock.advanceSeconds(PAST_DEADLINE_SECONDS);
    await service.publishLapsedNodes();
    await service.noteReading('node-uuid', clock.now());
    expect(publishedOnline(publishNodeState)).toEqual([false]);
  });

  it('forgets a deleted node', async () => {
    const clock = new FixedClock(HEARD_AT);
    const { service, publishNodeState } = makeService(
      [node({ status: NodeStatus.Pending })],
      [],
      { clock },
    );
    await hearNode(service);
    await service.remove('node-uuid');
    clock.advanceSeconds(PAST_DEADLINE_SECONDS);
    await service.publishLapsedNodes();
    expect(publishNodeState).toHaveBeenCalledTimes(1);
  });
});
