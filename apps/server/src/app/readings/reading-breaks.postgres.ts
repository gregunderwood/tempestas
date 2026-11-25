import { inject } from 'vitest';
import { DataSource } from 'typeorm';
import { postgresConnectionOptions } from '../common/postgres-connection';
import * as migrations from '../../migrations';
import { runAsSuperuser } from '../../migrations/round-trip/throwaway-postgres';
import {
  SEEDED_HISTORY_BOOT_ID,
  findNodeReadingSpans,
  findReadingBreaks,
} from './reading-breaks';
import type { ReadingWindow } from './reading-window';

const READING_BREAKS_DATABASE = 'reading_breaks';
const GAP_MINUTES = 5;
const MILLISECONDS_PER_MINUTE = 60_000;
const WINDOW_START = new Date('2026-11-01T00:00:00Z');
const WHOLE_DAY: ReadingWindow = {
  from: WINDOW_START,
  to: new Date('2026-11-02T00:00:00Z'),
};

const throwawayPostgres = inject('throwawayPostgres');

function minutesIntoWindow(minutes: number): Date {
  return new Date(WINDOW_START.getTime() + minutes * MILLISECONDS_PER_MINUTE);
}

function connectToReadingBreaksDatabase(): DataSource {
  return new DataSource({
    ...postgresConnectionOptions(
      (name) =>
        ({
          DATABASE_HOST: '127.0.0.1',
          DATABASE_PORT: String(throwawayPostgres.port),
          DATABASE_USER: throwawayPostgres.username,
          DATABASE_PASSWORD: throwawayPostgres.password,
          DATABASE_NAME: READING_BREAKS_DATABASE,
        })[name],
    ),
    migrations: Object.values(migrations),
  });
}

interface ReadingRow {
  minutes: number;
  bootId: string | null;
}

describe('reading breaks against Postgres', () => {
  let source: DataSource;

  beforeAll(async () => {
    runAsSuperuser(
      throwawayPostgres.containerId,
      `CREATE DATABASE ${READING_BREAKS_DATABASE} OWNER ${throwawayPostgres.username}`,
    );
    source = await connectToReadingBreaksDatabase().initialize();
    await source.runMigrations({ transaction: 'all' });
  });

  afterAll(async () => {
    await source?.destroy();
  });

  beforeEach(async () => {
    await source.query('TRUNCATE sensor_readings, nodes CASCADE');
  });

  async function addNode(slug: string): Promise<string> {
    const [inserted] = await source.query(
      `INSERT INTO nodes (slug, display_name, capabilities)
       VALUES ($1, $1, '{}'::jsonb) RETURNING id`,
      [slug],
    );
    return inserted.id;
  }

  async function addReadings(
    nodeUuid: string,
    readings: ReadingRow[],
  ): Promise<void> {
    for (const reading of readings) {
      await source.query(
        `INSERT INTO sensor_readings (node_id, sensor_id, temperature, boot_id, created_at)
         VALUES ($1, 'probe', 20, $2, $3)`,
        [nodeUuid, reading.bootId, minutesIntoWindow(reading.minutes)],
      );
    }
  }

  async function addNodeWithReadings(
    slug: string,
    readings: ReadingRow[],
  ): Promise<void> {
    await addReadings(await addNode(slug), readings);
  }

  const readingsUnderOneBoot = (...minutes: number[]): ReadingRow[] =>
    minutes.map((minute) => ({ minutes: minute, bootId: 'boot-a' }));

  it('counts a silence just over the gap length as a gap, and one exactly that long as not', async () => {
    await addNodeWithReadings(
      'lamp',
      readingsUnderOneBoot(0, GAP_MINUTES, GAP_MINUTES * 2 + 0.01),
    );

    const breaks = await findReadingBreaks(source, WHOLE_DAY, GAP_MINUTES);

    expect(breaks).toEqual([
      {
        nodeId: 'lamp',
        previousAt: minutesIntoWindow(GAP_MINUTES),
        at: minutesIntoWindow(GAP_MINUTES * 2 + 0.01),
        isGap: true,
        isNewBoot: false,
      },
    ]);
  });

  it('counts a change of boot id with no silence as a reboot but not a gap', async () => {
    await addNodeWithReadings('lamp', [
      { minutes: 0, bootId: 'boot-a' },
      { minutes: 1, bootId: 'boot-b' },
    ]);

    const breaks = await findReadingBreaks(source, WHOLE_DAY, GAP_MINUTES);

    expect(breaks).toEqual([
      {
        nodeId: 'lamp',
        previousAt: minutesIntoWindow(0),
        at: minutesIntoWindow(1),
        isGap: false,
        isNewBoot: true,
      },
    ]);
  });

  it('does not count the seeded history meeting the first real reading as a reboot', async () => {
    await addNodeWithReadings('lamp', [
      { minutes: 0, bootId: SEEDED_HISTORY_BOOT_ID },
      { minutes: 1, bootId: 'boot-a' },
    ]);

    expect(await findReadingBreaks(source, WHOLE_DAY, GAP_MINUTES)).toEqual([]);
  });

  it('does not count a null boot id followed by a real one as a reboot', async () => {
    await addNodeWithReadings('lamp', [
      { minutes: 0, bootId: null },
      { minutes: 1, bootId: 'boot-a' },
    ]);

    expect(await findReadingBreaks(source, WHOLE_DAY, GAP_MINUTES)).toEqual([]);
  });

  it("keeps each node's readings to that node when they interleave", async () => {
    await addNodeWithReadings('lamp', [
      { minutes: 0, bootId: 'lamp-boot' },
      { minutes: 2, bootId: 'lamp-boot' },
      { minutes: 4, bootId: 'lamp-boot' },
    ]);
    await addNodeWithReadings('pump', [
      { minutes: 1, bootId: 'pump-boot' },
      { minutes: 3, bootId: 'pump-boot' },
      { minutes: 10, bootId: 'pump-boot' },
    ]);

    const breaks = await findReadingBreaks(source, WHOLE_DAY, GAP_MINUTES);

    expect(breaks).toEqual([
      {
        nodeId: 'pump',
        previousAt: minutesIntoWindow(3),
        at: minutesIntoWindow(10),
        isGap: true,
        isNewBoot: false,
      },
    ]);
  });

  it('only looks at readings inside the window, both ends included', async () => {
    const window: ReadingWindow = {
      from: minutesIntoWindow(10),
      to: minutesIntoWindow(20),
    };
    await addNodeWithReadings('lamp', [
      { minutes: 0, bootId: 'boot-before' },
      { minutes: 10, bootId: 'boot-a' },
      { minutes: 20, bootId: 'boot-a' },
      { minutes: 30, bootId: 'boot-after' },
    ]);

    const breaks = await findReadingBreaks(source, window, GAP_MINUTES);
    const spans = await findNodeReadingSpans(source, window);

    expect(breaks).toEqual([
      {
        nodeId: 'lamp',
        previousAt: minutesIntoWindow(10),
        at: minutesIntoWindow(20),
        isGap: true,
        isNewBoot: false,
      },
    ]);
    expect(spans).toEqual([
      {
        nodeId: 'lamp',
        firstAt: minutesIntoWindow(10),
        lastAt: minutesIntoWindow(20),
      },
    ]);
  });

  it("spans each node's first and last reading in the window", async () => {
    await addNodeWithReadings('lamp', readingsUnderOneBoot(3, 7));
    await addNodeWithReadings('pump', readingsUnderOneBoot(1, 2, 9));

    const spans = await findNodeReadingSpans(source, WHOLE_DAY);

    expect(
      [...spans].sort((first, second) =>
        first.nodeId.localeCompare(second.nodeId),
      ),
    ).toEqual([
      {
        nodeId: 'lamp',
        firstAt: minutesIntoWindow(3),
        lastAt: minutesIntoWindow(7),
      },
      {
        nodeId: 'pump',
        firstAt: minutesIntoWindow(1),
        lastAt: minutesIntoWindow(9),
      },
    ]);
  });
});
