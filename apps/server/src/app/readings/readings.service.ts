import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import {
  ApiErrorCode,
  type DayNightStats,
  type MetricKey,
  type Reading,
  type ReadingAverages,
  ReadingOrder,
  type ReadingStats,
  type ReadingsQuery,
  type SegmentStats,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { roundTo } from '../common/rounding';
import { MILLISECONDS_PER_MINUTE } from '../common/time-units';
import { ZoneEntity } from '../zones/models';
import { NodeEntity } from '../nodes/models';
import { SensorReadingEntity } from './models';
import {
  findNextBoundary,
  resolveSegments,
  type Segment,
} from './daylight-segments';
import { resolveReadingWindow, type ReadingWindow } from './reading-window';
import { rememberSensorsSince } from './sensor-memory';
import {
  resolveDefaultTimezone,
  resolveZoneDaylight,
  type Daylight,
} from './zone-daylight';

const DEFAULT_LIMIT = 500;

const CREATED_AT_DIRECTION: Record<ReadingOrder, SortDirection> = {
  [ReadingOrder.NewestFirst]: 'DESC',
  [ReadingOrder.OldestFirst]: 'ASC',
};

type SortDirection = 'ASC' | 'DESC';

interface RawAverages {
  temperature: string | null;
  humidity: string | null;
  co2: string | null;
}

interface MetricExtremes {
  lowest: Reading | null;
  highest: Reading | null;
}

const EXTREME_METRICS: readonly MetricKey[] = [
  'temperature',
  'humidity',
  'co2',
];

const MOST_PROBES_IN_A_HISTORY = 70;
const AVERAGE_DECIMALS = 2;

export interface TemperatureBucketRow {
  nodeId: string;
  sensorId: string;
  at: Date;
  averageC: number;
  lowestC: number;
  highestC: number;
  sampleCount: number;
}

export interface HeldTemperatureBucketRow {
  nodeId: string;
  sensorId: string;
  at: Date;
  averageC: number;
  /** How long this probe's readings held in the bucket, counting a hold carried over from the bucket before. */
  heldMs: number;
}

interface RawHeldTemperatureBucket {
  nodeId: string;
  sensorId: string;
  at: Date;
  averageC: string;
  heldMs: string;
}

export interface HeldTemperatureBucketsQuery {
  window: ReadingWindow;
  bucketMinutes: number;
  longestHeldMinutes: number;
  nodeSlugs: readonly string[];
}

// Each reading holds until its probe's next, for at most the longest hold, and a hold past its bucket's end goes on in the next.
const HELD_TEMPERATURE_BUCKETS_SQL = `
  WITH holds AS (
    SELECT node.slug AS node_slug,
           reading.sensor_id,
           reading.created_at,
           reading.temperature,
           date_bin(make_interval(mins => $1), reading.created_at, TIMESTAMPTZ 'epoch') AS bucket_at,
           date_bin(make_interval(mins => $1), reading.created_at, TIMESTAMPTZ 'epoch')
             + make_interval(mins => $1) AS bucket_end_at,
           LEAST(
             COALESCE(
               LEAD(reading.created_at) OVER (
                 PARTITION BY reading.node_id, reading.sensor_id ORDER BY reading.created_at
               ),
               $3
             ),
             reading.created_at + make_interval(mins => $5)
           ) AS held_until
      FROM sensor_readings reading
      JOIN nodes node ON node.id = reading.node_id
     WHERE reading.created_at >= $2
       AND reading.created_at <= $3
       AND node.slug = ANY($4::text[])
  ),
  held_pieces AS (
    SELECT node_slug, sensor_id, bucket_at, temperature,
           TRUE AS is_bucket_reading,
           LEAST(held_until, bucket_end_at) - created_at AS held
      FROM holds
    UNION ALL
    SELECT node_slug, sensor_id, bucket_end_at, temperature,
           FALSE,
           held_until - bucket_end_at
      FROM holds
     WHERE held_until > bucket_end_at
  )
  SELECT node_slug AS "nodeId",
         sensor_id AS "sensorId",
         bucket_at AS "at",
         COALESCE(
           AVG(temperature) FILTER (WHERE is_bucket_reading),
           AVG(temperature)
         ) AS "averageC",
         SUM(EXTRACT(EPOCH FROM held)) * 1000 AS "heldMs"
    FROM held_pieces
   GROUP BY node_slug, sensor_id, bucket_at
   ORDER BY bucket_at DESC
   LIMIT $6
`;

interface RawTemperatureBucket {
  nodeId: string;
  sensorId: string;
  at: Date;
  averageC: string;
  lowestC: string;
  highestC: string;
  sampleCount: string;
}

@Injectable()
export class ReadingsService {
  constructor(
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    @InjectRepository(NodeEntity)
    private readonly nodes: Repository<NodeEntity>,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async findAll(query: ReadingsQuery): Promise<Reading[]> {
    const window = this.resolveWindow(query);
    const rows = await this.queryReadingsInWindow(query, window)
      .orderBy(
        'reading.createdAt',
        CREATED_AT_DIRECTION[query.order ?? ReadingOrder.NewestFirst],
      )
      .limit(query.limit ?? DEFAULT_LIMIT)
      .getMany();
    return rows.map(toReading);
  }

  async findLatestPerSensor(): Promise<Reading[]> {
    const rows = await this.readings
      .createQueryBuilder('reading')
      .innerJoinAndSelect('reading.node', 'node')
      .where('reading.createdAt > :since', {
        since: rememberSensorsSince(this.clock.now()),
      })
      .distinctOn(['reading.nodeId', 'reading.sensorId'])
      .orderBy('reading.nodeId')
      .addOrderBy('reading.sensorId')
      .addOrderBy('reading.createdAt', 'DESC')
      .getMany();
    return rows.map(toReading).sort(compareNewestFirst);
  }

  async computeDayNightStats(query: ReadingsQuery): Promise<DayNightStats> {
    const daylight = await this.resolveDaylightFor(query.nodeId);
    const now = this.clock.now();
    const segments = resolveSegments(
      now,
      daylight.startTime,
      daylight.endTime,
      daylight.timezone,
    );
    if (!segments) {
      return { periods: [], nextBoundary: null, daylight };
    }

    const periods = await Promise.all(
      segments.map((segment, index) => {
        const isRunning = index === segments.length - 1;
        return this.computeSegmentStats(query, segment, isRunning);
      }),
    );
    const boundary = findNextBoundary(
      now,
      daylight.startTime,
      daylight.endTime,
      daylight.timezone,
    );
    return {
      periods,
      nextBoundary: boundary?.toISOString() ?? null,
      daylight,
    };
  }

  async computeStats(query: ReadingsQuery): Promise<ReadingStats> {
    const window = this.resolveWindow(query);

    const averages = await this.queryReadingsInWindow(query, window)
      .select('AVG(reading.temperature)', 'temperature')
      .addSelect('AVG(reading.humidity)', 'humidity')
      // AVG skips NULLs, so an invalid CO2 is never averaged in as a zero.
      .addSelect('AVG(reading.co2)', 'co2')
      .getRawOne<RawAverages>();

    const [temperature, humidity, co2] = await Promise.all(
      EXTREME_METRICS.map((metric) => this.findExtremes(query, window, metric)),
    );

    return {
      min: {
        temperature: temperature.lowest,
        humidity: humidity.lowest,
        co2: co2.lowest,
      },
      max: {
        temperature: temperature.highest,
        humidity: humidity.highest,
        co2: co2.highest,
      },
      average: toAverages(averages),
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    };
  }

  // Newest first under the limit, so a truncated answer loses the oldest end rather than now.
  async bucketTemperatures(
    window: ReadingWindow,
    bucketMinutes: number,
    nodeSlugs?: readonly string[],
  ): Promise<TemperatureBucketRow[]> {
    if (nodeSlugs?.length === 0) return [];
    const query = this.readings
      .createQueryBuilder('reading')
      .innerJoin('reading.node', 'node')
      .select('node.slug', 'nodeId')
      .addSelect('reading.sensorId', 'sensorId')
      .addSelect(
        `date_bin(make_interval(mins => :bucketMinutes), reading.createdAt, TIMESTAMPTZ 'epoch')`,
        'at',
      )
      .addSelect('AVG(reading.temperature)', 'averageC')
      .addSelect('MIN(reading.temperature)', 'lowestC')
      .addSelect('MAX(reading.temperature)', 'highestC')
      .addSelect('COUNT(*)', 'sampleCount')
      .where('reading.createdAt >= :from', { from: window.from })
      .andWhere('reading.createdAt <= :to', { to: window.to });
    if (nodeSlugs)
      query.andWhere('node.slug IN (:...nodeSlugs)', { nodeSlugs });
    const rows = await query
      .setParameter('bucketMinutes', bucketMinutes)
      .groupBy('node.slug')
      .addGroupBy('reading.sensorId')
      .addGroupBy('"at"')
      .orderBy('"at"', 'DESC')
      .limit(countBucketRowsAllowed(window, bucketMinutes))
      .getRawMany<RawTemperatureBucket>();
    return rows.reverse().map(toTemperatureBucketRow);
  }

  // Newest first under the limit, like bucketTemperatures, and handed back oldest first.
  async bucketHeldTemperatures(
    query: HeldTemperatureBucketsQuery,
  ): Promise<HeldTemperatureBucketRow[]> {
    if (query.nodeSlugs.length === 0) return [];
    const rows: RawHeldTemperatureBucket[] = await this.readings.query(
      HELD_TEMPERATURE_BUCKETS_SQL,
      [
        query.bucketMinutes,
        query.window.from,
        query.window.to,
        query.nodeSlugs,
        query.longestHeldMinutes,
        countBucketRowsAllowed(query.window, query.bucketMinutes),
      ],
    );
    return rows.reverse().map(toHeldTemperatureBucketRow);
  }

  findColdestReading(
    window: ReadingWindow,
    nodeSlugs: readonly string[],
  ): Promise<Reading | null> {
    return this.findLowestReading(window, nodeSlugs, 'temperature');
  }

  findLowestReading(
    window: ReadingWindow,
    nodeSlugs: readonly string[],
    metric: MetricKey,
  ): Promise<Reading | null> {
    return this.findNodesExtreme(window, nodeSlugs, metric, 'ASC');
  }

  findHighestReading(
    window: ReadingWindow,
    nodeSlugs: readonly string[],
    metric: MetricKey,
  ): Promise<Reading | null> {
    return this.findNodesExtreme(window, nodeSlugs, metric, 'DESC');
  }

  // Ties go to the latest, as every other extreme here does.
  private async findNodesExtreme(
    window: ReadingWindow,
    nodeSlugs: readonly string[],
    metric: MetricKey,
    direction: SortDirection,
  ): Promise<Reading | null> {
    if (nodeSlugs.length === 0) return null;
    const row = await this.queryWindow(window)
      .andWhere('node.slug IN (:...nodeSlugs)', { nodeSlugs })
      // Postgres sorts NULL above every value, so a missing humidity or CO2 would win a DESC ordering.
      .andWhere(`reading.${metric} IS NOT NULL`)
      .orderBy(`reading.${metric}`, direction)
      .addOrderBy('reading.createdAt', 'DESC')
      .limit(1)
      .getOne();
    return row ? toReading(row) : null;
  }

  private async computeSegmentStats(
    query: ReadingsQuery,
    segment: Segment,
    inProgress: boolean,
  ): Promise<SegmentStats> {
    // The segment's own bounds: the caller's `days`, `from` and `to` would widen it.
    const stats = await this.computeStats({
      nodeId: query.nodeId,
      from: segment.from.toISOString(),
      to: segment.to.toISOString(),
    });
    return {
      kind: segment.kind,
      from: segment.from.toISOString(),
      to: segment.to.toISOString(),
      inProgress,
      stats,
    };
  }

  // A node with no zone still gets the deployment default: this is history, not control.
  private async resolveDaylightFor(
    nodeSlug: string | undefined,
  ): Promise<Daylight> {
    if (!nodeSlug)
      return resolveZoneDaylight(null, resolveDefaultTimezone(this.config));
    const node = await this.nodes.findOne({
      where: { slug: nodeSlug },
      relations: { zone: true },
    });
    const rulesConfig = (node?.zone as ZoneEntity | null | undefined)
      ?.rulesConfig;
    return resolveZoneDaylight(
      rulesConfig,
      resolveDefaultTimezone(this.config),
    );
  }

  private async findExtremes(
    query: ReadingsQuery,
    window: ReadingWindow,
    metric: MetricKey,
  ): Promise<MetricExtremes> {
    const [lowest, highest] = await Promise.all([
      this.findExtreme(query, window, metric, 'ASC'),
      this.findExtreme(query, window, metric, 'DESC'),
    ]);
    return { lowest, highest };
  }

  private async findExtreme(
    query: ReadingsQuery,
    window: ReadingWindow,
    metric: MetricKey,
    direction: SortDirection,
  ): Promise<Reading | null> {
    const row = await this.queryReadingsInWindow(query, window)
      // Postgres sorts NULL above every value, so an invalid CO2 would win a DESC ordering.
      .andWhere(`reading.${metric} IS NOT NULL`)
      .orderBy(`reading.${metric}`, direction)
      .addOrderBy('reading.createdAt', 'DESC')
      .limit(1)
      .getOne();
    return row ? toReading(row) : null;
  }

  private queryReadingsInWindow(
    query: ReadingsQuery,
    window: ReadingWindow,
  ): SelectQueryBuilder<SensorReadingEntity> {
    const builder = this.queryWindow(window);

    if (query.nodeId) {
      builder.andWhere('node.slug = :slug', { slug: query.nodeId });
    }
    if (query.sensorId) {
      builder.andWhere('reading.sensorId = :sensorId', {
        sensorId: query.sensorId,
      });
    }
    return builder;
  }

  private queryWindow(
    window: ReadingWindow,
  ): SelectQueryBuilder<SensorReadingEntity> {
    return this.readings
      .createQueryBuilder('reading')
      .innerJoinAndSelect('reading.node', 'node')
      .where('reading.createdAt >= :from', { from: window.from })
      .andWhere('reading.createdAt <= :to', { to: window.to });
  }

  private resolveWindow(query: ReadingsQuery): ReadingWindow {
    try {
      return resolveReadingWindow(
        query,
        this.clock.now(),
        resolveDefaultTimezone(this.config),
      );
    } catch (error: unknown) {
      throw new BadRequestException({
        code: ApiErrorCode.ValidationFailed,
        message: error instanceof Error ? error.message : 'Invalid window',
      });
    }
  }
}

function toReading(row: SensorReadingEntity): Reading {
  return {
    id: row.id,
    nodeId: row.node.slug,
    sensorId: row.sensorId,
    temperature: Number(row.temperature),
    humidity: row.humidity === null ? null : Number(row.humidity),
    co2: row.co2 === null ? null : Number(row.co2),
    createdAt: row.createdAt.toISOString(),
  };
}

// Postgres returns AVG and COUNT as strings.
function toTemperatureBucketRow(
  raw: RawTemperatureBucket,
): TemperatureBucketRow {
  return {
    nodeId: raw.nodeId,
    sensorId: raw.sensorId,
    at: new Date(raw.at),
    averageC: roundTo(Number(raw.averageC), AVERAGE_DECIMALS),
    lowestC: Number(raw.lowestC),
    highestC: Number(raw.highestC),
    sampleCount: Number(raw.sampleCount),
  };
}

// Postgres returns AVG and SUM as strings.
function toHeldTemperatureBucketRow(
  raw: RawHeldTemperatureBucket,
): HeldTemperatureBucketRow {
  return {
    nodeId: raw.nodeId,
    sensorId: raw.sensorId,
    at: new Date(raw.at),
    averageC: roundTo(Number(raw.averageC), AVERAGE_DECIMALS),
    heldMs: Math.round(Number(raw.heldMs)),
  };
}

function countBucketRowsAllowed(
  window: ReadingWindow,
  bucketMinutes: number,
): number {
  const windowMinutes =
    (window.to.getTime() - window.from.getTime()) / MILLISECONDS_PER_MINUTE;
  const bucketCount = Math.ceil(windowMinutes / bucketMinutes);
  return Math.max(bucketCount, 1) * MOST_PROBES_IN_A_HISTORY;
}

function compareNewestFirst(first: Reading, second: Reading): number {
  return second.createdAt.localeCompare(first.createdAt);
}

// Postgres returns AVG as a string, and as null for an empty window.
function toAverages(raw: RawAverages | undefined): ReadingAverages {
  return {
    temperature: roundToHundredths(raw?.temperature),
    humidity: roundToHundredths(raw?.humidity),
    co2: raw?.co2 == null ? null : Math.round(Number(raw.co2)),
  };
}

function roundToHundredths(value: string | null | undefined): number | null {
  if (value == null) return null;
  return roundTo(Number(value), AVERAGE_DECIMALS);
}
