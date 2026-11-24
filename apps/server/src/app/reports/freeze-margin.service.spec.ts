import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { DeviceRole, type Node, type Reading } from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import type { DeviceEntity, PinTransitionEntity } from '../devices/models';
import type { NodesService } from '../nodes/nodes.service';
import type {
  ReadingsService,
  TemperatureBucketRow,
} from '../readings/readings.service';
import type { ReadingWindow } from '../readings/reading-window';
import type { ZoneEntity } from '../zones/models';
import { FreezeMarginService } from './freeze-margin.service';

const NOW = new Date('2026-11-24T19:00:00Z');
const PUMPHOUSE_ID = 'pumphouse-zone';
const GREENHOUSE_ID = 'greenhouse-zone';
const HEATER_ID = 'heater-device';
const CONFIGURED_TIMEZONE = 'America/Toronto';

const PUMPHOUSE_RULES = {
  enabledRoles: ['heater'],
  sensorPolicy: { default: { source: 'min', maxAgeMs: 120_000 } },
  rules: {
    heater: {
      kind: 'thermostat',
      mode: 'heat',
      onAtC: 4,
      offAtC: 6,
      onStale: 'on',
    },
  },
  timezone: 'America/Edmonton',
};

interface FakeTables {
  devices?: Partial<DeviceEntity>[];
  inWindow?: Partial<PinTransitionEntity>[];
  coldest?: Reading | null;
  buckets?: TemperatureBucketRow[];
}

interface RecordedCalls {
  coldestQueries: { window: ReadingWindow; nodeSlugs: readonly string[] }[];
  bucketWindows: ReadingWindow[];
  bucketNodeSlugs: (readonly string[] | undefined)[];
}

const ZONES: Partial<ZoneEntity>[] = [
  {
    id: GREENHOUSE_ID,
    slug: 'greenhouse',
    displayName: 'Greenhouse',
    rulesConfig: PUMPHOUSE_RULES as unknown as ZoneEntity['rulesConfig'],
  },
  {
    id: PUMPHOUSE_ID,
    slug: 'pumphouse',
    displayName: 'Pumphouse',
    rulesConfig: PUMPHOUSE_RULES as unknown as ZoneEntity['rulesConfig'],
  },
];

const NODES: Partial<Node>[] = [
  {
    slug: 'patji',
    zoneId: PUMPHOUSE_ID,
    online: true,
    lastSeenAt: null,
    latestReadingAt: null,
  },
  {
    slug: 'elantris',
    zoneId: GREENHOUSE_ID,
    online: true,
    lastSeenAt: null,
    latestReadingAt: null,
  },
];

const PUMPHOUSE_HEATER: Partial<DeviceEntity> = {
  id: HEATER_ID,
  name: 'Pumphouse heater',
  role: DeviceRole.Heater,
  zoneId: PUMPHOUSE_ID,
};

const GREENHOUSE_BURNER: Partial<DeviceEntity> = {
  id: 'burner-device',
  name: 'CO2 burner',
  role: DeviceRole.Co2Generator,
  zoneId: GREENHOUSE_ID,
};

function coldestAt(createdAt: string, temperature: number): Reading {
  return {
    id: 'reading-1',
    nodeId: 'patji',
    sensorId: 'pipe',
    temperature,
    humidity: null,
    co2: null,
    createdAt,
  };
}

function makeService(tables: FakeTables): {
  service: FreezeMarginService;
  calls: RecordedCalls;
} {
  const calls: RecordedCalls = {
    coldestQueries: [],
    bucketWindows: [],
    bucketNodeSlugs: [],
  };
  const zones = {
    find: async () => ZONES,
  } as unknown as Repository<ZoneEntity>;
  const devices = {
    find: async () => tables.devices ?? [GREENHOUSE_BURNER, PUMPHOUSE_HEATER],
  } as unknown as Repository<DeviceEntity>;
  const inForceQuery = {
    distinctOn: () => inForceQuery,
    where: () => inForceQuery,
    orderBy: () => inForceQuery,
    addOrderBy: () => inForceQuery,
    getMany: async () => [],
  };
  const transitions = {
    createQueryBuilder: () => inForceQuery,
    find: async () => tables.inWindow ?? [],
  } as unknown as Repository<PinTransitionEntity>;
  const nodes = { findAll: async () => NODES } as unknown as NodesService;
  const readings = {
    findColdestReading: async (
      window: ReadingWindow,
      nodeSlugs: readonly string[],
    ) => {
      calls.coldestQueries.push({ window, nodeSlugs });
      return tables.coldest ?? null;
    },
    bucketTemperatures: async (
      window: ReadingWindow,
      _bucketMinutes: number,
      nodeSlugs?: readonly string[],
    ) => {
      calls.bucketWindows.push(window);
      calls.bucketNodeSlugs.push(nodeSlugs);
      return tables.buckets ?? [];
    },
  } as unknown as ReadingsService;
  const config = {
    get: () => CONFIGURED_TIMEZONE,
  } as unknown as ConfigService;
  const service = new FreezeMarginService(
    zones,
    devices,
    transitions,
    nodes,
    readings,
    new FixedClock(NOW),
    config,
  );
  return { service, calls };
}

describe('FreezeMarginService.buildFreezeMargin', () => {
  it('reports only zones with a heater or heat tape, over 30 nights unless asked', async () => {
    const { service } = makeService({});
    const report = await service.buildFreezeMargin({});
    expect(report.nights).toBe(30);
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.zones.map((zone) => zone.zoneSlug)).toEqual(['pumphouse']);
    expect(report.zones[0]).toMatchObject({
      timezone: 'America/Edmonton',
      warningBelowC: 4,
      isWarningFromRules: true,
    });
    expect(report.zones[0].nights).toHaveLength(30);
  });

  it("looks for each night's coldest reading among the zone's own probes", async () => {
    const { service, calls } = makeService({});
    await service.buildFreezeMargin({ nights: 2 });
    expect(calls.coldestQueries.map((query) => query.nodeSlugs)).toEqual([
      ['patji'],
      ['patji'],
    ]);
  });

  it("buckets the heated zones' readings from the start of the oldest night", async () => {
    const { service, calls } = makeService({});
    const report = await service.buildFreezeMargin({ nights: 2 });
    const oldestNight = report.zones[0].nights[1];
    expect(calls.bucketWindows).toEqual([
      { from: new Date(oldestNight.from), to: NOW },
    ]);
    expect(calls.bucketNodeSlugs).toEqual([['patji']]);
    expect(report.zones[0].nodeIds).toEqual(['patji']);
  });

  it("places the heater's recorded state at the coldest moment", async () => {
    const { service } = makeService({
      inWindow: [
        {
          nodeId: 'patji',
          pin: 17,
          energised: false,
          deviceId: HEATER_ID,
          observedAt: new Date('2026-11-24T00:00:00Z'),
        },
      ],
      coldest: coldestAt('2026-11-24T10:00:00Z', 1),
    });
    const report = await service.buildFreezeMargin({ nights: 1 });
    const [lastNight] = report.zones[0].nights;
    expect(lastNight.heating[0].state).toBe('off');
    expect(lastNight.concern).toBe('heat-off-while-cold');
  });

  it("leaves another zone's probes out of the hours below", async () => {
    const { service } = makeService({
      buckets: [
        {
          nodeId: 'elantris',
          sensorId: 'scd41',
          at: new Date('2026-11-24T10:00:00Z'),
          averageC: -10,
          lowestC: -10,
          highestC: -10,
          sampleCount: 1,
        },
      ],
    });
    const report = await service.buildFreezeMargin({ nights: 1 });
    expect(report.zones[0].nights[0].hoursWithReadings).toBe(0);
  });

  it('asks for no history when no zone has heating', async () => {
    const { service, calls } = makeService({ devices: [GREENHOUSE_BURNER] });
    const report = await service.buildFreezeMargin({});
    expect(report.zones).toEqual([]);
    expect(calls.bucketWindows).toEqual([]);
  });
});
