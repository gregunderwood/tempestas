import type { ConfigService } from '@nestjs/config';
import type { FindManyOptions, Repository } from 'typeorm';
import {
  NodeStatus,
  NodeUpdateOutcome,
  type Node,
  type NodeCapabilities,
} from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import type { NodeUpdateEntity } from '../nodes/models';
import type { NodesService } from '../nodes/nodes.service';
import type { SensorReadingEntity } from '../readings/models';
import {
  SEEDED_HISTORY_BOOT_ID,
  type NodeReadingSpan,
  type ReadingBreak,
} from '../readings/reading-breaks';
import type { ZoneEntity } from '../zones/models';
import { NodeHealthService } from './node-health.service';

const NOW = new Date('2026-11-24T19:00:00Z');
const PUMPHOUSE_ID = 'pumphouse-zone';
const CONFIGURED_TIMEZONE = 'America/Toronto';

const SENSING: NodeCapabilities = {
  contractVersion: 1,
  sensors: [
    {
      sensorId: 'pipe',
      kind: 'ds18b20',
      metrics: ['temperature'],
      sampleIntervalMs: 10_000,
    },
  ],
  hasRtc: true,
};

const ZONES: Partial<ZoneEntity>[] = [
  {
    id: PUMPHOUSE_ID,
    rulesConfig: {
      enabledRoles: [],
      sensorPolicy: { default: { source: 'min', maxAgeMs: 120_000 } },
      rules: {},
      timezone: 'America/Edmonton',
    } as unknown as ZoneEntity['rulesConfig'],
  },
];

function healthNode(slug: string, overrides: Partial<Node> = {}): Node {
  return {
    slug,
    displayName: `${slug} box`,
    status: NodeStatus.Admitted,
    zoneId: null,
    capabilities: SENSING,
    ...overrides,
  } as Node;
}

const NODES: Node[] = [
  healthNode('patji', { zoneId: PUMPHOUSE_ID }),
  healthNode('braize', { capabilities: { ...SENSING, sensors: [] } }),
  healthNode('newcomer', { status: NodeStatus.Pending }),
];

interface FakeTables {
  breaks?: ReadingBreak[];
  readingSpans?: NodeReadingSpan[];
  updates?: Partial<NodeUpdateEntity>[];
}

interface RecordedCalls {
  readingQueries: { sql: string; parameters: unknown[] }[];
  updateQueries: FindManyOptions<NodeUpdateEntity>[];
}

function makeService(tables: FakeTables = {}): {
  service: NodeHealthService;
  calls: RecordedCalls;
} {
  const calls: RecordedCalls = { readingQueries: [], updateQueries: [] };
  const zones = {
    find: async () => ZONES,
  } as unknown as Repository<ZoneEntity>;
  const readings = {
    query: async (sql: string, parameters: unknown[]) => {
      calls.readingQueries.push({ sql, parameters });
      return sql.includes('LAG(')
        ? (tables.breaks ?? [])
        : (tables.readingSpans ?? []);
    },
  } as unknown as Repository<SensorReadingEntity>;
  const updates = {
    find: async (options: FindManyOptions<NodeUpdateEntity>) => {
      calls.updateQueries.push(options);
      return tables.updates ?? [];
    },
  } as unknown as Repository<NodeUpdateEntity>;
  const nodes = { findAll: async () => NODES } as unknown as NodesService;
  const config = {
    get: () => CONFIGURED_TIMEZONE,
  } as unknown as ConfigService;
  const service = new NodeHealthService(
    zones,
    readings,
    updates,
    nodes,
    new FixedClock(NOW),
    config,
  );
  return { service, calls };
}

describe('NodeHealthService.buildNodeHealth', () => {
  it('reports every admitted node by slug over 30 days unless asked', async () => {
    const { service } = makeService();
    const report = await service.buildNodeHealth({});
    expect(report.days).toBe(30);
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.nodes.map((node) => node.nodeId)).toEqual([
      'braize',
      'patji',
    ]);
  });

  it("dates each node in its zone's timezone, or the deployment's without one", async () => {
    const { service } = makeService();
    const report = await service.buildNodeHealth({});
    expect(report.nodes.map((node) => node.timezone)).toEqual([
      CONFIGURED_TIMEZONE,
      'America/Edmonton',
    ]);
  });

  it('says which nodes have no sensors to read gaps from', async () => {
    const { service } = makeService();
    const report = await service.buildNodeHealth({});
    expect(report.nodes.map((node) => node.hasSensors)).toEqual([false, true]);
  });

  it('asks for breaks over the period, with the gap length and the seeded boot id to ignore', async () => {
    const { service, calls } = makeService();
    await service.buildNodeHealth({ days: 7 });
    const sevenDaysAgo = new Date('2026-11-17T19:00:00Z');
    expect(calls.readingQueries.map((query) => query.parameters)).toEqual([
      [sevenDaysAgo, NOW, 5, SEEDED_HISTORY_BOOT_ID],
      [sevenDaysAgo, NOW],
    ]);
  });

  it('turns breaks into gaps and reboots on their node', async () => {
    const { service } = makeService({
      breaks: [
        {
          nodeId: 'patji',
          previousAt: new Date('2026-11-12T09:30:00Z'),
          at: new Date('2026-11-12T13:00:00Z'),
          isGap: true,
          isNewBoot: true,
        },
      ],
      readingSpans: [
        {
          nodeId: 'patji',
          firstAt: new Date('2026-10-25T19:00:00Z'),
          lastAt: new Date('2026-11-24T18:59:50Z'),
        },
      ],
    });
    const report = await service.buildNodeHealth({});
    const patji = report.nodes[1];
    expect(patji.firstReadingAt).toBe('2026-10-25T19:00:00.000Z');
    expect(patji.gaps.map((gap) => gap.minutes)).toEqual([210]);
    expect(patji.reboots).toEqual([{ at: '2026-11-12T13:00:00.000Z' }]);
  });

  it('lists healthy updates finished in the period as version changes', async () => {
    const { service, calls } = makeService({
      updates: [
        {
          node: { slug: 'patji' } as NodeUpdateEntity['node'],
          fromVersion: '1.0.3',
          toVersion: '1.1.0',
          isRollBack: false,
          finishedAt: new Date('2026-11-20T12:00:00Z'),
          lastHeardAt: new Date('2026-11-20T11:59:00Z'),
        },
      ],
    });
    const report = await service.buildNodeHealth({});
    expect(calls.updateQueries[0].where).toMatchObject({
      outcome: NodeUpdateOutcome.Healthy,
    });
    expect(report.nodes[1].versionChanges).toEqual([
      {
        fromVersion: '1.0.3',
        toVersion: '1.1.0',
        isRollBack: false,
        at: '2026-11-20T12:00:00.000Z',
      },
    ]);
  });
});
