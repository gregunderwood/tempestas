import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TIME_IN_RANGE_BUCKET_MINUTES,
  TIME_IN_RANGE_DEFAULT_DAYS,
  TIME_IN_RANGE_LONGEST_HELD_MINUTES,
  type MetricKey,
  type Node,
  type PeriodKind,
  type Reading,
  type TimeInRangeQuery,
  type TimeInRangeReport,
  type ZoneTimeInRange,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { NodesService } from '../nodes/nodes.service';
import {
  ReadingsService,
  type HeldTemperatureBucketRow,
} from '../readings/readings.service';
import {
  resolveDefaultTimezone,
  resolveZoneDaylight,
} from '../readings/zone-daylight';
import { ZoneEntity } from '../zones/models';
import {
  findEarliestStart,
  listRecentDayAndNightPeriods,
  type ReportPeriod,
} from './report-periods';
import type { ReportZone } from './report-zone';
import {
  summariseZoneTimeInRange,
  type PeriodExtremeReadings,
  type PeriodWithExtremes,
} from './time-in-range';
import { findZoneBand, type ZoneBand } from './zone-band';

type ExtremeDirection = 'lowest' | 'highest';

interface ExtremesSought {
  direction: ExtremeDirection;
  metrics: readonly MetricKey[];
}

// Night's risk is the cold and day's the heat; CO2 only matters while plants take it up.
const EXTREMES_SOUGHT: Record<PeriodKind, ExtremesSought> = {
  night: { direction: 'lowest', metrics: ['temperature', 'humidity'] },
  day: { direction: 'highest', metrics: ['temperature', 'humidity', 'co2'] },
};

interface ZoneWithPeriods {
  zone: ReportZone;
  band: ZoneBand;
  periods: ReportPeriod[];
}

@Injectable()
export class TimeInRangeService {
  constructor(
    @InjectRepository(ZoneEntity)
    private readonly zones: Repository<ZoneEntity>,
    private readonly nodes: NodesService,
    private readonly readings: ReadingsService,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async buildTimeInRange(query: TimeInRangeQuery): Promise<TimeInRangeReport> {
    const days = query.days ?? TIME_IN_RANGE_DEFAULT_DAYS;
    const now = this.clock.now();
    const zonesWithPeriods = await this.findZonesWithNodes(now, days);
    const report = { days, generatedAt: now.toISOString() };
    if (zonesWithPeriods.length === 0) return { ...report, zones: [] };

    const temperatureBuckets = await this.readings.bucketHeldTemperatures({
      window: {
        from: findEarliestStart(
          zonesWithPeriods.flatMap(
            (zoneWithPeriods) => zoneWithPeriods.periods,
          ),
          now,
        ),
        to: now,
      },
      bucketMinutes: TIME_IN_RANGE_BUCKET_MINUTES,
      longestHeldMinutes: TIME_IN_RANGE_LONGEST_HELD_MINUTES,
      nodeSlugs: zonesWithPeriods.flatMap(
        (zoneWithPeriods) => zoneWithPeriods.zone.nodeIds,
      ),
    });
    return {
      ...report,
      zones: await Promise.all(
        zonesWithPeriods.map((zoneWithPeriods) =>
          this.summariseZone(zoneWithPeriods, temperatureBuckets),
        ),
      ),
    };
  }

  private async findZonesWithNodes(
    now: Date,
    days: number,
  ): Promise<ZoneWithPeriods[]> {
    const [zones, nodes] = await Promise.all([
      this.zones.find({ order: { slug: 'ASC' } }),
      this.nodes.findAll(),
    ]);
    return zones
      .map((zone) => this.describeZone(zone, nodes, now, days))
      .filter((zoneWithPeriods) => zoneWithPeriods.zone.nodeIds.length > 0);
  }

  private describeZone(
    zone: ZoneEntity,
    nodes: readonly Node[],
    now: Date,
    days: number,
  ): ZoneWithPeriods {
    const daylight = resolveZoneDaylight(
      zone.rulesConfig,
      resolveDefaultTimezone(this.config),
    );
    return {
      zone: {
        id: zone.id,
        slug: zone.slug,
        displayName: zone.displayName,
        timezone: daylight.timezone,
        nodeIds: nodes
          .filter((node) => node.zoneId === zone.id)
          .map((node) => node.slug),
      },
      band: findZoneBand(zone.rulesConfig),
      periods: listRecentDayAndNightPeriods(now, daylight, days),
    };
  }

  private async summariseZone(
    zoneWithPeriods: ZoneWithPeriods,
    temperatureBuckets: readonly HeldTemperatureBucketRow[],
  ): Promise<ZoneTimeInRange> {
    const { zone } = zoneWithPeriods;
    return summariseZoneTimeInRange({
      zone,
      band: zoneWithPeriods.band,
      periods: await Promise.all(
        zoneWithPeriods.periods.map((period) =>
          this.attachExtremes(period, zone.nodeIds),
        ),
      ),
      temperatureBuckets: temperatureBuckets.filter((bucket) =>
        zone.nodeIds.includes(bucket.nodeId),
      ),
    });
  }

  private async attachExtremes(
    period: ReportPeriod,
    nodeSlugs: readonly string[],
  ): Promise<PeriodWithExtremes> {
    const sought = EXTREMES_SOUGHT[period.kind];
    const extremeReadings: PeriodExtremeReadings = {
      temperature: null,
      humidity: null,
      co2: null,
    };
    await Promise.all(
      sought.metrics.map(async (metric) => {
        extremeReadings[metric] = await this.findExtreme(
          period,
          nodeSlugs,
          metric,
          sought.direction,
        );
      }),
    );
    return { ...period, extremeReadings };
  }

  private findExtreme(
    period: ReportPeriod,
    nodeSlugs: readonly string[],
    metric: MetricKey,
    direction: ExtremeDirection,
  ): Promise<Reading | null> {
    return direction === 'lowest'
      ? this.readings.findLowestReading(period, nodeSlugs, metric)
      : this.readings.findHighestReading(period, nodeSlugs, metric);
  }
}
