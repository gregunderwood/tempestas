import { inject } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { DataSource, type Repository } from 'typeorm';
import { postgresConnectionOptions } from '../common/postgres-connection';
import { SystemClock } from '../common/clock';
import { MILLISECONDS_PER_SECOND } from '../common/time-units';
import * as migrations from '../../migrations';
import { runAsSuperuser } from '../../migrations/round-trip/throwaway-postgres';
import type { NodeEntity } from '../nodes/models';
import { ReadingsService } from './readings.service';
import type { SensorReadingEntity } from './models';

const throwawayPostgres = inject('throwawayPostgres');
const HELD_BUCKETS_DATABASE = 'held_buckets';
const NODE_ID = '00000000-0000-4000-8000-0000000000aa';
const NODE_SLUG = 'patji';
const SENSOR_ID = 'pipes';
const SAMPLE_SECONDS = 10;
const BUCKET_MINUTES = 5;
const LONGEST_HELD_MINUTES = 1;
const FULL_BUCKET_MS = BUCKET_MINUTES * 60 * MILLISECONDS_PER_SECOND;

let source: DataSource;
let service: ReadingsService;

beforeAll(async () => {
  runAsSuperuser(
    throwawayPostgres.containerId,
    `CREATE DATABASE ${HELD_BUCKETS_DATABASE} OWNER ${throwawayPostgres.username}`,
  );
  source = await new DataSource({
    ...postgresConnectionOptions(readSetting),
    migrations: Object.values(migrations),
  }).initialize();
  await source.runMigrations({ transaction: 'all' });
  await source.query(
    `INSERT INTO nodes (id, slug, display_name, capabilities) VALUES ($1, $2, $2, '{}')`,
    [NODE_ID, NODE_SLUG],
  );
  service = new ReadingsService(
    {
      query: (sql: string, parameters: unknown[]) =>
        source.query(sql, parameters),
    } as unknown as Repository<SensorReadingEntity>,
    {} as Repository<NodeEntity>,
    new SystemClock(),
    {} as ConfigService,
  );
});

afterAll(() => source?.destroy());

beforeEach(() => source.query('DELETE FROM sensor_readings'));

function readSetting(name: string): string | undefined {
  const settings: Record<string, string> = {
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(throwawayPostgres.port),
    DATABASE_USER: throwawayPostgres.username,
    DATABASE_PASSWORD: throwawayPostgres.password,
    DATABASE_NAME: HELD_BUCKETS_DATABASE,
  };
  return settings[name];
}

async function insertSamplesEvery10Seconds(firstAt: Date, count: number) {
  await source.query(
    `INSERT INTO sensor_readings (node_id, sensor_id, temperature, humidity, created_at)
     SELECT $1, $2, 5, 50, $3::timestamptz + make_interval(secs => sample * $4)
       FROM generate_series(0, $5 - 1) sample`,
    [NODE_ID, SENSOR_ID, firstAt, SAMPLE_SECONDS, count],
  );
}

function bucketHeldTemperatures(from: Date, to: Date) {
  return service.bucketHeldTemperatures({
    window: { from, to },
    bucketMinutes: BUCKET_MINUTES,
    longestHeldMinutes: LONGEST_HELD_MINUTES,
    nodeSlugs: [NODE_SLUG],
  });
}

describe('ReadingsService.bucketHeldTemperatures on Postgres', () => {
  it('holds every whole bucket in full when the samples start off a bucket boundary', async () => {
    const secondsBeforeTheFirstSample = 7;
    await insertSamplesEvery10Seconds(new Date('2026-11-23T03:00:07Z'), 360);
    const lastAt = new Date('2026-11-23T03:59:57Z');

    const buckets = await bucketHeldTemperatures(
      new Date('2026-11-23T03:00:00Z'),
      lastAt,
    );

    const wholeBuckets = buckets.slice(1, -1);
    expect(wholeBuckets).toHaveLength(10);
    for (const bucket of wholeBuckets) {
      expect(bucket.heldMs).toBe(FULL_BUCKET_MS);
    }
    expect(buckets[0].heldMs).toBe(
      FULL_BUCKET_MS - secondsBeforeTheFirstSample * MILLISECONDS_PER_SECOND,
    );
  });

  it('counts a gap as held only for the longest hold', async () => {
    const firstAt = new Date('2026-11-23T03:00:00Z');
    await insertSamplesEvery10Seconds(firstAt, 18);
    const afterTheGapAt = new Date('2026-11-23T03:04:20Z');
    await source.query(
      `INSERT INTO sensor_readings (node_id, sensor_id, temperature, humidity, created_at)
       VALUES ($1, $2, 9, 50, $3)`,
      [NODE_ID, SENSOR_ID, afterTheGapAt],
    );

    const buckets = await bucketHeldTemperatures(firstAt, afterTheGapAt);

    expect(buckets).toEqual([
      expect.objectContaining({ heldMs: 230 * MILLISECONDS_PER_SECOND }),
    ]);
  });

  it("carries a hold into a bucket with no reading of its own, at the carried reading's temperature", async () => {
    await source.query(
      `INSERT INTO sensor_readings (node_id, sensor_id, temperature, humidity, created_at)
       VALUES ($1, $2, 4, 50, '2026-11-23T03:04:50Z'), ($1, $2, 8, 50, '2026-11-23T03:12:00Z')`,
      [NODE_ID, SENSOR_ID],
    );

    const buckets = await bucketHeldTemperatures(
      new Date('2026-11-23T03:00:00Z'),
      new Date('2026-11-23T03:12:00Z'),
    );

    expect(buckets).toEqual([
      expect.objectContaining({
        averageC: 4,
        heldMs: 10 * MILLISECONDS_PER_SECOND,
      }),
      expect.objectContaining({
        averageC: 4,
        heldMs: 50 * MILLISECONDS_PER_SECOND,
      }),
      expect.objectContaining({ averageC: 8, heldMs: 0 }),
    ]);
  });
});
