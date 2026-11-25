import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { DeviceRole, type Node, type Reading } from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import type { NodesService } from '../nodes/nodes.service';
import type {
  HeldTemperatureBucketRow,
  HeldTemperatureBucketsQuery,
  ReadingsService,
} from '../readings/readings.service';
import type { ReadingWindow } from '../readings/reading-window';
import type { ZoneEntity } from '../zones/models';
import { TimeInRangeService } from './time-in-range.service';

const NOW = new Date('2026-11-24T19:00:00Z');
const GREENHOUSE_ID = 'greenhouse-zone';
const PUMPHOUSE_ID = 'pumphouse-zone';
const EMPTY_ID = 'empty-zone';

const GREENHOUSE_RULES = {
  enabledRoles: [],
  sensorPolicy: { default: { source: 'mean' } },
  rules: {
    exhaust_fan: {
      kind: 'thermostat',
      mode: 'cool',
      onAtC: 30,
      offAtC: 29.5,
      onStale: 'hold',
    },
  },
  daylight: { start: '06:30', end: '18:30' },
  timezone: 'America/Vancouver',
};

const ZONES: Partial<ZoneEntity>[] = [
  { id: EMPTY_ID, slug: 'attic', displayName: 'Attic', rulesConfig: null },
  {
    id: GREENHOUSE_ID,
    slug: 'greenhouse',
    displayName: 'Greenhouse',
    rulesConfig: GREENHOUSE_RULES as unknown as ZoneEntity['rulesConfig'],
  },
  {
    id: PUMPHOUSE_ID,
    slug: 'pumphouse',
    displayName: 'Pumphouse',
    rulesConfig: null,
  },
] as Partial<ZoneEntity>[];

const NODES: Partial<Node>[] = [
  { slug: 'elantris', zoneId: GREENHOUSE_ID },
  { slug: 'patji', zoneId: PUMPHOUSE_ID },
];

interface ExtremeQuery {
  direction: 'coldest' | 'warmest';
  window: ReadingWindow;
  nodeSlugs: readonly string[];
}

function readingOf(temperature: number): Reading {
  return {
    id: `reading-${temperature}`,
    nodeId: 'elantris',
    sensorId: 'scd41',
    temperature,
    humidity: null,
    co2: null,
    createdAt: '2026-11-24T12:00:00.000Z',
  };
}

interface FakeTables {
  buckets?: HeldTemperatureBucketRow[];
  nodes?: Partial<Node>[];
}

function makeService({
  buckets = [],
  nodes: nodeRows = NODES,
}: FakeTables = {}): {
  service: TimeInRangeService;
  bucketQueries: HeldTemperatureBucketsQuery[];
  extremeQueries: ExtremeQuery[];
} {
  const bucketQueries: HeldTemperatureBucketsQuery[] = [];
  const extremeQueries: ExtremeQuery[] = [];
  const zones = {
    find: async () => ZONES,
  } as unknown as Repository<ZoneEntity>;
  const nodes = { findAll: async () => nodeRows } as unknown as NodesService;
  const readings = {
    bucketHeldTemperatures: async (query: HeldTemperatureBucketsQuery) => {
      bucketQueries.push(query);
      return buckets;
    },
    findColdestReading: async (
      window: ReadingWindow,
      nodeSlugs: readonly string[],
    ) => {
      extremeQueries.push({ direction: 'coldest', window, nodeSlugs });
      return readingOf(2);
    },
    findWarmestReading: async (
      window: ReadingWindow,
      nodeSlugs: readonly string[],
    ) => {
      extremeQueries.push({ direction: 'warmest', window, nodeSlugs });
      return readingOf(31);
    },
  } as unknown as ReadingsService;
  const config = {
    get: () => 'America/Edmonton',
  } as unknown as ConfigService;
  const service = new TimeInRangeService(
    zones,
    nodes,
    readings,
    new FixedClock(NOW),
    config,
  );
  return { service, bucketQueries, extremeQueries };
}

describe('TimeInRangeService.buildTimeInRange', () => {
  it('reports every zone with a node, over 30 days of day and night periods unless asked', async () => {
    const { service } = makeService();
    const report = await service.buildTimeInRange({});
    expect(report.days).toBe(30);
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.zones.map((zone) => zone.zoneSlug)).toEqual([
      'greenhouse',
      'pumphouse',
    ]);
    expect(report.zones[0].periods).toHaveLength(60);
    expect(report.zones[1].timezone).toBe('America/Edmonton');
  });

  it('bounds each zone by its own rules, and leaves a zone with none unbounded', async () => {
    const { service } = makeService();
    const [greenhouse, pumphouse] = (await service.buildTimeInRange({})).zones;
    expect(greenhouse.lowerBounds).toEqual([]);
    expect(greenhouse.upperBounds).toEqual([
      { role: DeviceRole.ExhaustFan, setpointC: 30, sensorSource: 'mean' },
    ]);
    expect(pumphouse.lowerBounds).toEqual([]);
    expect(pumphouse.upperBounds).toEqual([]);
  });

  it('buckets every zone’s probes once, from the start of the oldest period', async () => {
    const { service, bucketQueries } = makeService();
    const report = await service.buildTimeInRange({ days: 1 });
    const oldestStart = report.zones
      .flatMap((zone) => zone.periods)
      .map((period) => period.from)
      .sort()[0];
    expect(bucketQueries).toEqual([
      {
        window: { from: new Date(oldestStart), to: NOW },
        bucketMinutes: 5,
        longestHeldMinutes: 1,
        nodeSlugs: ['elantris', 'patji'],
      },
    ]);
  });

  it('takes the coldest reading of a night and the warmest of a day', async () => {
    const { service, extremeQueries } = makeService();
    const [greenhouse] = (await service.buildTimeInRange({ days: 1 })).zones;
    const [today, lastNight] = greenhouse.periods;
    expect([today.kind, today.extreme?.temperatureC]).toEqual(['day', 31]);
    expect([lastNight.kind, lastNight.extreme?.temperatureC]).toEqual([
      'night',
      2,
    ]);
    expect(
      extremeQueries
        .filter((query) => query.nodeSlugs.includes('elantris'))
        .map((query) => query.direction),
    ).toEqual(['warmest', 'coldest']);
  });

  it("leaves another zone's probes out of a zone's hours", async () => {
    const { service } = makeService({
      buckets: [
        {
          nodeId: 'patji',
          sensorId: 'pipes',
          at: new Date('2026-11-24T18:00:00Z'),
          averageC: 40,
          heldMs: 300_000,
        },
      ],
    });
    const [greenhouse, pumphouse] = (
      await service.buildTimeInRange({ days: 1 })
    ).zones;
    expect(greenhouse.periods[0].hoursAbove).toBe(0);
    expect(pumphouse.periods[0].hoursInRange).toBe(0.08);
  });

  it('asks for no history when no zone has a node', async () => {
    const { service, bucketQueries } = makeService({ nodes: [] });
    expect((await service.buildTimeInRange({})).zones).toEqual([]);
    expect(bucketQueries).toEqual([]);
  });
});
