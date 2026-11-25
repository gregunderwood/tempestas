import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import {
  DeviceRole,
  type MetricKey,
  type Node,
  type Reading,
} from '@tempestas/domain';
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
  direction: 'lowest' | 'highest';
  metric: MetricKey;
  window: ReadingWindow;
  nodeSlugs: readonly string[];
}

function readingOf(
  temperature: number,
  humidity: number,
  co2: number,
): Reading {
  return {
    id: `reading-${temperature}`,
    nodeId: 'elantris',
    sensorId: 'scd41',
    temperature,
    humidity,
    co2,
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
    findLowestReading: async (
      window: ReadingWindow,
      nodeSlugs: readonly string[],
      metric: MetricKey,
    ) => {
      extremeQueries.push({ direction: 'lowest', metric, window, nodeSlugs });
      return readingOf(2, 40, 420);
    },
    findHighestReading: async (
      window: ReadingWindow,
      nodeSlugs: readonly string[],
      metric: MetricKey,
    ) => {
      extremeQueries.push({ direction: 'highest', metric, window, nodeSlugs });
      return readingOf(31, 85, 1450);
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

  it('takes the lowest temperature and humidity of a night, and the highest temperature, humidity and CO2 of a day', async () => {
    const { service, extremeQueries } = makeService();
    const [greenhouse] = (await service.buildTimeInRange({ days: 1 })).zones;
    const [today, lastNight] = greenhouse.periods;
    expect(today.kind).toBe('day');
    expect(today.extremes.temperature?.value).toBe(31);
    expect(today.extremes.humidity?.value).toBe(85);
    expect(today.extremes.co2?.value).toBe(1450);
    expect(lastNight.kind).toBe('night');
    expect(lastNight.extremes.temperature?.value).toBe(2);
    expect(lastNight.extremes.humidity?.value).toBe(40);
    expect(lastNight.extremes.co2).toBeNull();
    expect(
      extremeQueries
        .filter((query) => query.nodeSlugs.includes('elantris'))
        .map((query) => `${query.direction} ${query.metric}`),
    ).toEqual([
      'highest temperature',
      'highest humidity',
      'highest co2',
      'lowest temperature',
      'lowest humidity',
    ]);
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
