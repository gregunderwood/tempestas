import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import {
  ApiErrorCode,
  type DayNightStats,
  type Reading,
  type ReadingAverages,
  ReadingOrder,
  type ReadingStats,
  type ReadingsQuery,
  type SegmentStats,
  ZONE_HISTORY_BUCKET_MINUTES,
  ZONE_HISTORY_HOURS,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { roundTo } from '../common/rounding';
import { MINUTES_PER_HOUR } from '../common/time-units';
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
import { parseZoneRulesConfig } from '../rules/rules-config';

const DEFAULT_LIMIT = 500;
const DEFAULT_TIMEZONE = 'America/Vancouver';
const DEFAULT_DAYLIGHT_START = '06:30';
const DEFAULT_DAYLIGHT_END = '18:30';

const CREATED_AT_DIRECTION: Record<ReadingOrder, SortDirection> = {
  [ReadingOrder.NewestFirst]: 'DESC',
  [ReadingOrder.OldestFirst]: 'ASC',
};

type SortDirection = 'ASC' | 'DESC';
type Metric = 'temperature' | 'humidity' | 'co2';
type Daylight = DayNightStats['daylight'];

interface RawAverages {
  temperature: string | null;
  humidity: string | null;
  co2: string | null;
}

interface MetricExtremes {
  lowest: Reading | null;
  highest: Reading | null;
}

const EXTREME_METRICS: readonly Metric[] = ['temperature', 'humidity', 'co2'];

const MOST_PROBES_IN_A_HISTORY = 70;
const BUCKETS_PER_HISTORY =
  (ZONE_HISTORY_HOURS * MINUTES_PER_HOUR) / ZONE_HISTORY_BUCKET_MINUTES;
const MAX_TEMPERATURE_BUCKET_ROWS =
  BUCKETS_PER_HISTORY * MOST_PROBES_IN_A_HISTORY;
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
  ): Promise<TemperatureBucketRow[]> {
    const rows = await this.readings
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
      .andWhere('reading.createdAt <= :to', { to: window.to })
      .setParameter('bucketMinutes', bucketMinutes)
      .groupBy('node.slug')
      .addGroupBy('reading.sensorId')
      .addGroupBy('"at"')
      .orderBy('"at"', 'DESC')
      .limit(MAX_TEMPERATURE_BUCKET_ROWS)
      .getRawMany<RawTemperatureBucket>();
    return rows.reverse().map(toTemperatureBucketRow);
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
    const fallback: Daylight = {
      startTime: DEFAULT_DAYLIGHT_START,
      endTime: DEFAULT_DAYLIGHT_END,
      timezone: this.defaultTimezone(),
    };
    if (!nodeSlug) return fallback;

    const node = await this.nodes.findOne({
      where: { slug: nodeSlug },
      relations: { zone: true },
    });
    const rulesConfig = (node?.zone as ZoneEntity | null | undefined)
      ?.rulesConfig;
    if (!rulesConfig) return fallback;
    const parsed = parseZoneRulesConfig(rulesConfig);
    if (parsed.ok === false) return fallback;
    const { daylight, timezone } = parsed.config;
    if (!daylight) return { ...fallback, timezone };
    return { startTime: daylight.start, endTime: daylight.end, timezone };
  }

  private async findExtremes(
    query: ReadingsQuery,
    window: ReadingWindow,
    metric: Metric,
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
    metric: Metric,
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
    const builder = this.readings
      .createQueryBuilder('reading')
      .innerJoinAndSelect('reading.node', 'node')
      .where('reading.createdAt >= :from', { from: window.from })
      .andWhere('reading.createdAt <= :to', { to: window.to });

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

  // Never the host locale: that was the old DST bug.
  private defaultTimezone(): string {
    return this.config.get<string>('TEMPESTAS_TZ', DEFAULT_TIMEZONE);
  }

  private resolveWindow(query: ReadingsQuery): ReadingWindow {
    try {
      return resolveReadingWindow(
        query,
        this.clock.now(),
        this.defaultTimezone(),
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
