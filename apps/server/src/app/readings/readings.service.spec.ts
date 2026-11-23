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
    andWhere: (condition: string) => {
      conditions.push(condition);
      return builder;
    },
    orderBy: (column: string, direction: string) => {
      orderings.push([column, direction]);
      return builder;
    },
    limit: () => builder,
    getMany: async () => [],
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
