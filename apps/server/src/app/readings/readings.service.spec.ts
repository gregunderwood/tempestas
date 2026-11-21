import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { ReadingOrder } from '@tempestas/domain';
import { SystemClock } from '../common/clock';
import type { NodeEntity } from '../nodes/models';
import type { SensorReadingEntity } from './models';
import { ReadingsService } from './readings.service';

function makeServiceRecordingQueries() {
  const orderings: [string, string][] = [];
  const conditions: string[] = [];
  const builder = {
    innerJoinAndSelect: () => builder,
    where: () => builder,
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
    new SystemClock(),
    config,
  );
  return { service, orderings, conditions };
}

describe('ReadingsService.findAll', () => {
  it('lists newest first by default', async () => {
    const { service, orderings } = makeServiceRecordingQueries();
    await service.findAll({ days: 1 });
    expect(orderings).toEqual([['r.createdAt', 'DESC']]);
  });

  it('lists oldest first when asked, so a client can find where a window began', async () => {
    const { service, orderings } = makeServiceRecordingQueries();
    await service.findAll({ days: 1, order: ReadingOrder.OldestFirst });
    expect(orderings).toEqual([['r.createdAt', 'ASC']]);
  });

  it('narrows to one sensor of a node when asked', async () => {
    const { service, conditions } = makeServiceRecordingQueries();
    await service.findAll({ days: 1, nodeId: 'patji', sensorId: 'pipes' });
    expect(conditions).toContain('r.sensorId = :sensorId');
  });

  it('keeps every sensor when no sensor is named', async () => {
    const { service, conditions } = makeServiceRecordingQueries();
    await service.findAll({ days: 1, nodeId: 'patji' });
    expect(conditions).not.toContain('r.sensorId = :sensorId');
  });
});
