import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { ReadingOrder } from '@tempestas/domain';
import { FixedClock, SystemClock, type Clock } from '../common/clock';
import type { NodeEntity } from '../nodes/models';
import type { SensorReadingEntity } from './models';
import { ReadingsService } from './readings.service';
import { SENSOR_MEMORY_SECONDS } from './sensor-memory';

function makeServiceRecordingQueries(clock: Clock = new SystemClock()) {
  const orderings: [string, string][] = [];
  const conditions: string[] = [];
  const parameters: Record<string, unknown> = {};
  const builder = {
    innerJoinAndSelect: () => builder,
    where: (condition: string, conditionParameters = {}) => {
      conditions.push(condition);
      Object.assign(parameters, conditionParameters);
      return builder;
    },
    distinctOn: () => builder,
    addOrderBy: () => builder,
    andWhere: (condition: string, conditionParameters = {}) => {
      conditions.push(condition);
      Object.assign(parameters, conditionParameters);
      return builder;
    },
    orderBy: (column: string, direction: string) => {
      orderings.push([column, direction]);
      return builder;
    },
    limit: () => builder,
    getMany: async () => [],
    getOne: async () => null,
  };
  const readings = {
    createQueryBuilder: () => builder,
  } as unknown as Repository<SensorReadingEntity>;
  const config = {
    get: (_key: string, fallback: string) => fallback,
  } as unknown as ConfigService;
  const service = new ReadingsService(
    readings,
    {} as Repository<NodeEntity>,
    clock,
    config,
  );
  return { service, orderings, conditions, parameters };
}

describe('ReadingsService.findAll', () => {
  it('lists newest first by default', async () => {
    const { service, orderings } = makeServiceRecordingQueries();
    await service.findAll({ days: 1 });
    expect(orderings).toEqual([['reading.createdAt', 'DESC']]);
  });

  it('lists oldest first when asked, so a client can find where a window began', async () => {
    const { service, orderings } = makeServiceRecordingQueries();
    await service.findAll({ days: 1, order: ReadingOrder.OldestFirst });
    expect(orderings).toEqual([['reading.createdAt', 'ASC']]);
  });

  it('narrows to one sensor of a node when asked', async () => {
    const { service, conditions } = makeServiceRecordingQueries();
    await service.findAll({ days: 1, nodeId: 'patji', sensorId: 'pipes' });
    expect(conditions).toContain('reading.sensorId = :sensorId');
  });

  it('keeps every sensor when no sensor is named', async () => {
    const { service, conditions } = makeServiceRecordingQueries();
    await service.findAll({ days: 1, nodeId: 'patji' });
    expect(conditions).not.toContain('reading.sensorId = :sensorId');
  });
});

describe('ReadingsService.findLatestPerSensor', () => {
  it('forgets a sensor that has been silent for longer than the sensor memory', async () => {
    const now = new Date('2026-11-22T18:00:00Z');
    const { service, conditions, parameters } = makeServiceRecordingQueries(
      new FixedClock(now),
    );
    await service.findLatestPerSensor();
    expect(conditions).toContain('reading.createdAt > :since');
    expect(parameters['since']).toEqual(
      new Date(now.getTime() - SENSOR_MEMORY_SECONDS * 1000),
    );
  });
});

describe('ReadingsService.bucketTemperatures', () => {
  function makeServiceAnsweringBuckets(rawRows: unknown[]) {
    const conditions: string[] = [];
    const parameters: Record<string, unknown> = {};
    const groupings: string[] = [];
    const orderings: [string, string][] = [];
    const limits: number[] = [];
    const recordCondition = (
      condition: string,
      conditionParameters: Record<string, unknown> = {},
    ) => {
      conditions.push(condition);
      Object.assign(parameters, conditionParameters);
      return builder;
    };
    const builder = {
      innerJoin: () => builder,
      select: () => builder,
      addSelect: () => builder,
      where: recordCondition,
      andWhere: recordCondition,
      setParameter: (name: string, value: unknown) => {
        parameters[name] = value;
        return builder;
      },
      groupBy: (grouping: string) => {
        groupings.push(grouping);
        return builder;
      },
      addGroupBy: (grouping: string) => {
        groupings.push(grouping);
        return builder;
      },
      orderBy: (ordering: string, direction: string) => {
        orderings.push([ordering, direction]);
        return builder;
      },
      limit: (rowCount: number) => {
        limits.push(rowCount);
        return builder;
      },
      getRawMany: async () => rawRows,
    };
    const readings = {
      createQueryBuilder: () => builder,
    } as unknown as Repository<SensorReadingEntity>;
    const service = new ReadingsService(
      readings,
      {} as Repository<NodeEntity>,
      new SystemClock(),
      {} as ConfigService,
    );
    return { service, conditions, parameters, groupings, orderings, limits };
  }

  const WINDOW = {
    from: new Date('2026-11-22T12:00:00Z'),
    to: new Date('2026-11-23T12:00:00Z'),
  };

  it('buckets each sensor inside the window', async () => {
    const { service, conditions, parameters, groupings } =
      makeServiceAnsweringBuckets([]);
    await service.bucketTemperatures(WINDOW, 5);
    expect(conditions).toEqual([
      'reading.createdAt >= :from',
      'reading.createdAt <= :to',
    ]);
    expect(parameters).toMatchObject({ ...WINDOW, bucketMinutes: 5 });
    expect(groupings).toEqual(['node.slug', 'reading.sensorId', '"at"']);
  });

  it('reads only the given nodes when asked, and nothing for none', async () => {
    const { service, conditions, parameters } = makeServiceAnsweringBuckets([]);
    await service.bucketTemperatures(WINDOW, 10, ['patji']);
    expect(conditions).toContain('node.slug IN (:...nodeSlugs)');
    expect(parameters).toMatchObject({ nodeSlugs: ['patji'] });
    expect(await service.bucketTemperatures(WINDOW, 10, [])).toEqual([]);
  });

  it('allows enough rows for every probe in every bucket of the window', async () => {
    const { service, limits } = makeServiceAnsweringBuckets([]);
    await service.bucketTemperatures(WINDOW, 5);
    await service.bucketTemperatures(
      { from: new Date('2026-10-24T12:00:00Z'), to: WINDOW.to },
      10,
    );
    expect(limits).toEqual([288 * 70, 30 * 144 * 70]);
  });

  it('takes the newest buckets under the limit and hands them back oldest first', async () => {
    const rawBucket = (at: string) => ({
      nodeId: 'patji',
      sensorId: 'pipes',
      at: new Date(at),
      averageC: '3',
      lowestC: '3',
      highestC: '3',
      sampleCount: '1',
    });
    const { service, orderings } = makeServiceAnsweringBuckets([
      rawBucket('2026-11-23T03:05:00Z'),
      rawBucket('2026-11-23T03:00:00Z'),
    ]);
    const buckets = await service.bucketTemperatures(WINDOW, 5);
    expect(orderings).toEqual([['"at"', 'DESC']]);
    expect(buckets.map((bucket) => bucket.at.toISOString())).toEqual([
      '2026-11-23T03:00:00.000Z',
      '2026-11-23T03:05:00.000Z',
    ]);
  });

  it('turns the strings Postgres returns for AVG and COUNT into numbers', async () => {
    const { service } = makeServiceAnsweringBuckets([
      {
        nodeId: 'patji',
        sensorId: 'pipes',
        at: new Date('2026-11-23T03:00:00Z'),
        averageC: '3.14159',
        lowestC: '2.5',
        highestC: '3.75',
        sampleCount: '30',
      },
    ]);
    expect(await service.bucketTemperatures(WINDOW, 5)).toEqual([
      {
        nodeId: 'patji',
        sensorId: 'pipes',
        at: new Date('2026-11-23T03:00:00Z'),
        averageC: 3.14,
        lowestC: 2.5,
        highestC: 3.75,
        sampleCount: 30,
      },
    ]);
  });
});

describe('ReadingsService.findColdestReading', () => {
  const WINDOW = {
    from: new Date('2026-11-23T00:00:00Z'),
    to: new Date('2026-11-23T14:00:00Z'),
  };

  it("takes the lowest temperature among the zone's nodes, the latest on a tie", async () => {
    const { service, conditions, parameters, orderings } =
      makeServiceRecordingQueries();
    expect(
      await service.findColdestReading(WINDOW, ['patji', 'braize']),
    ).toBeNull();
    expect(conditions).toEqual([
      'reading.createdAt >= :from',
      'reading.createdAt <= :to',
      'node.slug IN (:...nodeSlugs)',
      'reading.temperature IS NOT NULL',
    ]);
    expect(parameters).toMatchObject({
      ...WINDOW,
      nodeSlugs: ['patji', 'braize'],
    });
    expect(orderings).toEqual([['reading.temperature', 'ASC']]);
  });

  it('asks nothing for a zone with no nodes', async () => {
    const { service, conditions } = makeServiceRecordingQueries();
    expect(await service.findColdestReading(WINDOW, [])).toBeNull();
    expect(conditions).toEqual([]);
  });
});

describe('ReadingsService.findHighestReading', () => {
  const WINDOW = {
    from: new Date('2026-11-23T14:00:00Z'),
    to: new Date('2026-11-24T02:00:00Z'),
  };

  it("takes the highest CO2 among the zone's nodes, skipping probes with none", async () => {
    const { service, conditions, orderings } = makeServiceRecordingQueries();
    expect(
      await service.findHighestReading(WINDOW, ['elantris'], 'co2'),
    ).toBeNull();
    expect(conditions).toContain('node.slug IN (:...nodeSlugs)');
    expect(conditions).toContain('reading.co2 IS NOT NULL');
    expect(orderings).toEqual([['reading.co2', 'DESC']]);
  });

  it('asks nothing for a zone with no nodes', async () => {
    const { service, conditions } = makeServiceRecordingQueries();
    expect(
      await service.findHighestReading(WINDOW, [], 'temperature'),
    ).toBeNull();
    expect(conditions).toEqual([]);
  });
});

describe('ReadingsService.findLowestReading', () => {
  it('takes the lowest humidity, skipping probes with none', async () => {
    const { service, conditions, orderings } = makeServiceRecordingQueries();
    await service.findLowestReading(
      {
        from: new Date('2026-11-23T02:00:00Z'),
        to: new Date('2026-11-23T14:00:00Z'),
      },
      ['patji'],
      'humidity',
    );
    expect(conditions).toContain('reading.humidity IS NOT NULL');
    expect(orderings).toEqual([['reading.humidity', 'ASC']]);
  });
});

describe('ReadingsService.bucketHeldTemperatures', () => {
  function makeServiceAnsweringRawQuery(rawRows: unknown[]) {
    const queries: { sql: string; parameters: unknown[] }[] = [];
    const readings = {
      query: async (sql: string, parameters: unknown[]) => {
        queries.push({ sql, parameters });
        return rawRows;
      },
    } as unknown as Repository<SensorReadingEntity>;
    const service = new ReadingsService(
      readings,
      {} as Repository<NodeEntity>,
      new SystemClock(),
      {} as ConfigService,
    );
    return { service, queries };
  }

  const WINDOW = {
    from: new Date('2026-11-22T12:00:00Z'),
    to: new Date('2026-11-23T12:00:00Z'),
  };
  const QUERY = {
    window: WINDOW,
    bucketMinutes: 5,
    longestHeldMinutes: 1,
    nodeSlugs: ['patji', 'braize'],
  };

  it('passes the bucket, the window, the nodes, the longest hold and the row limit', async () => {
    const { service, queries } = makeServiceAnsweringRawQuery([]);
    await service.bucketHeldTemperatures(QUERY);
    expect(queries[0].parameters).toEqual([
      5,
      WINDOW.from,
      WINDOW.to,
      ['patji', 'braize'],
      1,
      288 * 70,
    ]);
    expect(queries[0].sql).toContain('LEAD(reading.created_at)');
  });

  it('asks nothing for no nodes', async () => {
    const { service, queries } = makeServiceAnsweringRawQuery([]);
    expect(
      await service.bucketHeldTemperatures({ ...QUERY, nodeSlugs: [] }),
    ).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('hands the newest-first rows back oldest first, as numbers', async () => {
    const { service } = makeServiceAnsweringRawQuery([
      {
        nodeId: 'patji',
        sensorId: 'pipes',
        at: new Date('2026-11-23T03:05:00Z'),
        averageC: '3.14159',
        heldMs: '230000.000000',
      },
      {
        nodeId: 'patji',
        sensorId: 'pipes',
        at: new Date('2026-11-23T03:00:00Z'),
        averageC: '4',
        heldMs: '300000.000000',
      },
    ]);
    expect(await service.bucketHeldTemperatures(QUERY)).toEqual([
      {
        nodeId: 'patji',
        sensorId: 'pipes',
        at: new Date('2026-11-23T03:00:00Z'),
        averageC: 4,
        heldMs: 300_000,
      },
      {
        nodeId: 'patji',
        sensorId: 'pipes',
        at: new Date('2026-11-23T03:05:00Z'),
        averageC: 3.14,
        heldMs: 230_000,
      },
    ]);
  });
});
