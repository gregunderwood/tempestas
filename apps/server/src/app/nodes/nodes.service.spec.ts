import { ConflictException } from '@nestjs/common';
import { SystemClock } from '../common/clock';
import type { Repository } from 'typeorm';
import {
  AgentApp,
  NodeKind,
  NodeStatus,
  type NodeCapabilities,
} from '@tempestas/domain';
import type { HardwareService, NodeHello } from '../hardware/hardware.service';
import type { DeviceEntity } from '../devices/models';
import type { SensorReadingEntity } from '../readings/models';
import type { ZoneEntity } from '../zones/models';
import { NodesService } from './nodes.service';
import type { NodeEntity } from './models';
import { AgentReleasesService } from '../agent-releases/agent-releases.service';
import {
  makeAgentReleasesRoot,
  writeBundle,
} from '../agent-releases/agent-release-bundles.fixtures';

const NO_AGENT_RELEASES_DIRECTORY = '/nonexistent/agent-releases';

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

function makeService(
  initial: NodeEntity[] = [],
  zones: ZoneEntity[] = [],
  agentReleases = new AgentReleasesService(NO_AGENT_RELEASES_DIRECTORY),
) {
  const rows = [...initial];
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
  const readingRepository = {
    createQueryBuilder: () => aggregate,
  } as unknown as Repository<SensorReadingEntity>;
  const zoneRepository = {
    findOne: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        zones.find((zone) => zone.id === where.id) ?? null,
    ),
  } as unknown as Repository<ZoneEntity>;
  const hardware = {} as unknown as HardwareService;

  const service = new NodesService(
    nodeRepository,
    deviceRepository,
    readingRepository,
    zoneRepository,
    hardware,
    new SystemClock(),
    agentReleases,
  );
  return { service, rows, nodeRepository };
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
      agentReleases,
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
