import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { FixedClock } from '../common/clock';
import type { SensorReadingEntity } from './models';
import { RETENTION_BATCH_SIZE, RetentionService } from './retention.service';

const NOW = new Date('2026-01-10T11:00:00Z');

function makeService(deletedPerCall: number[], retentionDays: unknown = 90) {
  let callIndex = 0;
  const query = vi.fn(async () => {
    const deleted = deletedPerCall[callIndex] ?? 0;
    callIndex += 1;
    return [[], deleted];
  });
  const readings = { query } as unknown as Repository<SensorReadingEntity>;
  const config = {
    get: vi.fn(() => retentionDays),
  } as unknown as ConfigService;

  return {
    service: new RetentionService(readings, new FixedClock(NOW), config),
    query,
  };
}

describe('RetentionService', () => {
  it('deletes in batches until a short batch says it is done', async () => {
    const { service, query } = makeService([
      RETENTION_BATCH_SIZE,
      RETENTION_BATCH_SIZE,
      120,
    ]);
    const deleted = await service.prune();

    expect(deleted).toBe(RETENTION_BATCH_SIZE * 2 + 120);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('stops after one statement when there is nothing to do', async () => {
    const { service, query } = makeService([0]);
    expect(await service.prune()).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('bounds each statement, rather than deleting by predicate alone', async () => {
    const { service, query } = makeService([0]);
    await service.prune();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/LIMIT \$2/);
    expect(params[1]).toBe(RETENTION_BATCH_SIZE);
  });

  it('computes the horizon from the retention window', async () => {
    const { service, query } = makeService([0]);
    await service.prune();
    const [, params] = query.mock.calls[0];
    expect((params[0] as Date).toISOString()).toBe('2025-10-12T11:00:00.000Z');
  });

  it.each([0, -1, 'ninety', ''])(
    'refuses to prune when RETENTION_DAYS is %s',
    async (value) => {
      const { service, query } = makeService([RETENTION_BATCH_SIZE], value);
      expect(await service.prune()).toBe(0);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('has a per-run ceiling so one night cannot run forever', async () => {
    const { service, query } = makeService(
      new Array(500).fill(RETENTION_BATCH_SIZE),
    );
    const deleted = await service.prune();
    expect(query).toHaveBeenCalledTimes(200);
    expect(deleted).toBe(200 * RETENTION_BATCH_SIZE);
  });
});
