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
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { ZoneEntity } from '../zones/models';
import { NodeEntity } from '../nodes/models';
import { SensorReadingEntity } from './models';
import {
  nextBoundary,
  resolveSegments,
  type Segment,
} from './daylight-segments';
import { resolveReadingWindow, type ReadingWindow } from './reading-window';
import { parseZoneRulesConfig } from '../rules/rules-config';

const DEFAULT_LIMIT = 500;

const CREATED_AT_DIRECTION: Record<ReadingOrder, 'ASC' | 'DESC'> = {
  [ReadingOrder.NewestFirst]: 'DESC',
  [ReadingOrder.OldestFirst]: 'ASC',
};

/**
 * The read side of `sensor_readings`.
 *
 * Every query is bounded by an explicit window and an explicit row limit. That
 * is not politeness: the old API's list endpoint had neither, over 2.87M rows
 * with no index on `created_at`, on the same SD card the controller writes to.
 */
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
    const window = this.window(query);
    const rows = await this.scoped(query, window)
      .orderBy(
        'r.createdAt',
        CREATED_AT_DIRECTION[query.order ?? ReadingOrder.NewestFirst],
      )
      .limit(query.limit ?? DEFAULT_LIMIT)
      .getMany();
    return rows.map(toDto);
  }

  /**
   * One row per sensor on every node, newest first. What the dashboard opens
   * with. Per sensor, not per node, or a node with a probe per pipe shows
   * whichever probe spoke last and hides the others.
   */
  async findLatestPerSensor(): Promise<Reading[]> {
    const rows = await this.readings
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.node', 'n')
      .distinctOn(['r.nodeId', 'r.sensorId'])
      .orderBy('r.nodeId')
      .addOrderBy('r.sensorId')
      .addOrderBy('r.createdAt', 'DESC')
      .getMany();
    return rows
      .map(toDto)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * The last few alternating daylight and night periods, oldest first.
   *
   * No combined figure: a window spanning both averages two different jobs
   * together and describes neither. Split at the ZONE's own
   * daylight window, because that is what the rules engine branches
   * on - a screen drawing the line elsewhere would explain a decision the
   * controller never made.
   */
  async dayNightStats(query: ReadingsQuery): Promise<DayNightStats> {
    const daylight = await this.daylightFor(query.nodeId);
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
      segments.map((segment, i) =>
        this.segmentStats(query, segment, i === segments.length - 1),
      ),
    );
    const boundary = nextBoundary(
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

  private async segmentStats(
    query: ReadingsQuery,
    segment: Segment,
    inProgress: boolean,
  ): Promise<SegmentStats> {
    // The segment's own bounds, not the caller's: `days`, `from` and `to` would
    // otherwise widen a period that is defined by where the boundaries fell.
    const stats = await this.stats({
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

  /**
   * The daylight boundary a node's readings should be split at.
   *
   * A node with no zone gets the deployment default rather than an error: this
   * is a presentation of history, and refusing to show any statistics because a
   * node has not been assigned yet helps nobody.
   */
  private async daylightFor(
    nodeId: string | undefined,
  ): Promise<DayNightStats['daylight']> {
    const fallback = {
      startTime: '06:30',
      endTime: '18:30',
      timezone: this.defaultTimezone(),
    };
    if (!nodeId) return fallback;

    const node = await this.nodes.findOne({
      where: { slug: nodeId },
      relations: { zone: true },
    });
    const raw = (node?.zone as ZoneEntity | null | undefined)?.rulesConfig;
    if (!raw) return fallback;
    const parsed = parseZoneRulesConfig(raw);
    if (parsed.ok === false) return fallback;
    const { daylight, timezone } = parsed.config;
    // A zone with no daylight window - a pumphouse has no day job - still gets
    // a day/night split in its own timezone, at the deployment default.
    if (!daylight) return { ...fallback, timezone };
    return { startTime: daylight.start, endTime: daylight.end, timezone };
  }

  async stats(query: ReadingsQuery): Promise<ReadingStats> {
    const window = this.window(query);

    const averages = await this.scoped(query, window)
      .select('AVG(r.temperature)', 'temperature')
      .addSelect('AVG(r.humidity)', 'humidity')
      // AVG ignores NULLs, which is what we want: an invalid CO2 must not be
      // averaged in as a zero. It returns NULL only when every row was invalid.
      .addSelect('AVG(r.co2)', 'co2')
      .getRawOne<{
        temperature: string | null;
        humidity: string | null;
        co2: string | null;
      }>();

    const [minTemp, maxTemp, minHum, maxHum, minCo2, maxCo2] =
      await Promise.all([
        this.extreme(query, window, 'temperature', 'ASC'),
        this.extreme(query, window, 'temperature', 'DESC'),
        this.extreme(query, window, 'humidity', 'ASC'),
        this.extreme(query, window, 'humidity', 'DESC'),
        this.extreme(query, window, 'co2', 'ASC'),
        this.extreme(query, window, 'co2', 'DESC'),
      ]);

    return {
      min: { temperature: minTemp, humidity: minHum, co2: minCo2 },
      max: { temperature: maxTemp, humidity: maxHum, co2: maxCo2 },
      average: toAverages(averages),
      // Echoed back so the dashboard can label the window it is showing, and so
      // a caller can see what its parameters actually resolved to.
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    };
  }

  /**
   * The whole reading that produced an extreme, not just the value, so the UI
   * can link to the record and say which node and when.
   */
  private async extreme(
    query: ReadingsQuery,
    window: ReadingWindow,
    metric: 'temperature' | 'humidity' | 'co2',
    direction: 'ASC' | 'DESC',
  ): Promise<Reading | null> {
    const row = await this.scoped(query, window)
      // NULLs sort as larger than any value in Postgres by default, so an
      // invalid CO2 would win a DESC ordering and be reported as the maximum.
      .andWhere(`r.${metric} IS NOT NULL`)
      .orderBy(`r.${metric}`, direction)
      .addOrderBy('r.createdAt', 'DESC')
      .limit(1)
      .getOne();
    return row ? toDto(row) : null;
  }

  private scoped(
    query: ReadingsQuery,
    window: ReadingWindow,
  ): SelectQueryBuilder<SensorReadingEntity> {
    const builder = this.readings
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.node', 'n')
      .where('r.createdAt >= :from', { from: window.from })
      .andWhere('r.createdAt <= :to', { to: window.to });

    if (query.nodeId) {
      // The slug, as everywhere on the wire.
      builder.andWhere('n.slug = :slug', { slug: query.nodeId });
    }
    if (query.sensorId) {
      builder.andWhere('r.sensorId = :sensorId', { sensorId: query.sensorId });
    }
    return builder;
  }

  /** Never the host locale - that was the old DST bug. */
  private defaultTimezone(): string {
    return this.config.get<string>('TEMPESTAS_TZ', 'America/Vancouver');
  }

  private window(query: ReadingsQuery): ReadingWindow {
    try {
      return resolveReadingWindow(
        query,
        this.clock.now(),
        this.config.get<string>('TEMPESTAS_TZ', 'America/Vancouver'),
      );
    } catch (err: unknown) {
      // A RangeError here is a bad request, not a server fault.
      throw new BadRequestException({
        code: ApiErrorCode.ValidationFailed,
        message: err instanceof Error ? err.message : 'Invalid window',
      });
    }
  }
}

export function toDto(row: SensorReadingEntity): Reading {
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

/** Postgres returns AVG as a string, and as null for an empty window. */
function toAverages(
  raw:
    | {
        temperature: string | null;
        humidity: string | null;
        co2: string | null;
      }
    | undefined,
): ReadingAverages {
  return {
    temperature: round2(raw?.temperature),
    humidity: round2(raw?.humidity),
    co2: raw?.co2 == null ? null : Math.round(Number(raw.co2)),
  };
}

function round2(value: string | null | undefined): number | null {
  if (value == null) return null;
  return Math.round(Number(value) * 100) / 100;
}
