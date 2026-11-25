import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TIME_IN_RANGE_BUCKET_MINUTES,
  TIME_IN_RANGE_DEFAULT_DAYS,
  TIME_IN_RANGE_LONGEST_HELD_MINUTES,
  type Node,
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
  type PeriodWithExtreme,
} from './time-in-range';
import { findZoneBand, type ZoneBand } from './zone-band';

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
          this.attachExtreme(period, zone.nodeIds),
        ),
      ),
      temperatureBuckets: temperatureBuckets.filter((bucket) =>
        zone.nodeIds.includes(bucket.nodeId),
      ),
    });
  }

  private async attachExtreme(
    period: ReportPeriod,
    nodeSlugs: readonly string[],
  ): Promise<PeriodWithExtreme> {
    return { ...period, extreme: await this.findExtreme(period, nodeSlugs) };
  }

  // Night's risk is the cold and day's the heat.
  private findExtreme(
    period: ReportPeriod,
    nodeSlugs: readonly string[],
  ): Promise<Reading | null> {
    return period.kind === 'night'
      ? this.readings.findColdestReading(period, nodeSlugs)
      : this.readings.findWarmestReading(period, nodeSlugs);
  }
}
