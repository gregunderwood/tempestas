import type { Repository } from 'typeorm';
import type { SensorReadingEntity } from './models';
import type { ReadingWindow } from './reading-window';

// Must match SEEDED_BOOT_ID in tools/lib/reading-history-sql.mjs, which stamps every seeded row.
export const SEEDED_HISTORY_BOOT_ID = 'seeded-history';

/** Two of a node's readings in a row that are a gap apart, or that came from different boots. */
export interface ReadingBreak {
  nodeId: string;
  previousAt: Date;
  at: Date;
  isGap: boolean;
  isNewBoot: boolean;
}

export type SqlRunner = Pick<Repository<SensorReadingEntity>, 'query'>;

export interface NodeReadingSpan {
  nodeId: string;
  firstAt: Date;
  lastAt: Date;
}

// A null boot id predates the column, so no reboot is provable across it.
const FIND_READING_BREAKS = `
  WITH step AS (
    SELECT reading.node_id,
           reading.created_at,
           reading.boot_id,
           LAG(reading.created_at) OVER by_node AS previous_at,
           LAG(reading.boot_id) OVER by_node AS previous_boot_id
      FROM sensor_readings reading
     WHERE reading.created_at >= $1 AND reading.created_at <= $2
    WINDOW by_node AS (PARTITION BY reading.node_id ORDER BY reading.created_at)
  ), classified AS (
    SELECT step.*,
           COALESCE(step.created_at - step.previous_at > make_interval(mins => $3::int), false) AS is_gap,
           COALESCE(step.previous_boot_id <> step.boot_id
                    AND step.previous_boot_id <> $4 AND step.boot_id <> $4, false) AS is_new_boot
      FROM step
  )
  SELECT node.slug AS "nodeId",
         classified.previous_at AS "previousAt",
         classified.created_at AS "at",
         classified.is_gap AS "isGap",
         classified.is_new_boot AS "isNewBoot"
    FROM classified
    JOIN nodes node ON node.id = classified.node_id
   WHERE classified.is_gap OR classified.is_new_boot
   ORDER BY classified.created_at`;

const FIND_NODE_READING_SPANS = `
  SELECT node.slug AS "nodeId",
         MIN(reading.created_at) AS "firstAt",
         MAX(reading.created_at) AS "lastAt"
    FROM sensor_readings reading
    JOIN nodes node ON node.id = reading.node_id
   WHERE reading.created_at >= $1 AND reading.created_at <= $2
   GROUP BY node.slug`;

// Walked in Postgres, not here: a month of one node at a 10 s interval is over a quarter of a million rows.
export function findReadingBreaks(
  readings: SqlRunner,
  window: ReadingWindow,
  gapMinutes: number,
): Promise<ReadingBreak[]> {
  return readings.query(FIND_READING_BREAKS, [
    window.from,
    window.to,
    gapMinutes,
    SEEDED_HISTORY_BOOT_ID,
  ]);
}

export function findNodeReadingSpans(
  readings: SqlRunner,
  window: ReadingWindow,
): Promise<NodeReadingSpan[]> {
  return readings.query(FIND_NODE_READING_SPANS, [window.from, window.to]);
}
