import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FREEZE_MARGIN_ALARM_C,
  FREEZE_MARGIN_BUCKET_MINUTES,
  FREEZE_MARGIN_DEFAULT_NIGHTS,
  type DeviceRole,
  type FreezeMarginQuery,
  type FreezeMarginReport,
  type Node,
  type ZoneFreezeMargin,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { DeviceEntity, PinTransitionEntity } from '../devices/models';
import {
  findRelayTransitionsSince,
  mapSightingsByNode,
} from '../devices/relay-history';
import { buildSpansByLine, type Span } from '../devices/relay-spans';
import { NodesService } from '../nodes/nodes.service';
import {
  ReadingsService,
  type TemperatureBucketRow,
} from '../readings/readings.service';
import {
  DEFAULT_TIMEZONE,
  resolveZoneDaylight,
} from '../readings/zone-daylight';
import { ZoneEntity } from '../zones/models';
import {
  summariseZoneFreezeMargin,
  type FreezeMarginZone,
  type HeatingDevice,
  type NightWithColdest,
} from './freeze-margin';
import {
  findHeatOnBelowByRole,
  HEATING_ROLES,
  type HeatOnBelowByRole,
} from './heating-setpoints';
import { listRecentNights, type NightWindow } from './night-windows';

interface HeatedZone {
  zone: FreezeMarginZone;
  heatOnBelowByRole: HeatOnBelowByRole;
  devices: HeatingDevice[];
  nodeSlugs: string[];
  nights: NightWindow[];
}

interface ZoneHistory {
  spans: Span[];
  temperatureBuckets: TemperatureBucketRow[];
}

@Injectable()
export class FreezeMarginService {
  constructor(
    @InjectRepository(ZoneEntity)
    private readonly zones: Repository<ZoneEntity>,
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(PinTransitionEntity)
    private readonly transitions: Repository<PinTransitionEntity>,
    private readonly nodes: NodesService,
    private readonly readings: ReadingsService,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async buildFreezeMargin(
    query: FreezeMarginQuery,
  ): Promise<FreezeMarginReport> {
    const nightCount = query.nights ?? FREEZE_MARGIN_DEFAULT_NIGHTS;
    const now = this.clock.now();
    const nodes = await this.nodes.findAll();
    const heatedZones = await this.findHeatedZones(nodes, now, nightCount);
    const report = {
      nights: nightCount,
      generatedAt: now.toISOString(),
      marginAlarmC: FREEZE_MARGIN_ALARM_C,
    };
    if (heatedZones.length === 0) return { ...report, zones: [] };

    const history = await this.findHistorySince(
      findEarliestNightStart(heatedZones, now),
      nodes,
      now,
    );
    return {
      ...report,
      zones: await Promise.all(
        heatedZones.map((heatedZone) =>
          this.summariseZone(heatedZone, history),
        ),
      ),
    };
  }

  private async findHeatedZones(
    nodes: readonly Node[],
    now: Date,
    nightCount: number,
  ): Promise<HeatedZone[]> {
    const [zones, devices] = await Promise.all([
      this.zones.find({ order: { slug: 'ASC' } }),
      this.findHeatingDevices(),
    ]);
    return zones
      .map((zone) => ({
        zone,
        devices: devices.filter((device) => device.zoneId === zone.id),
      }))
      .filter(({ devices: zoneDevices }) => zoneDevices.length > 0)
      .map(({ zone, devices: zoneDevices }) =>
        this.describeHeatedZone(zone, zoneDevices, nodes, now, nightCount),
      );
  }

  private describeHeatedZone(
    zone: ZoneEntity,
    devices: HeatingDevice[],
    nodes: readonly Node[],
    now: Date,
    nightCount: number,
  ): HeatedZone {
    const daylight = resolveZoneDaylight(
      zone.rulesConfig,
      this.defaultTimezone(),
    );
    return {
      zone: {
        id: zone.id,
        slug: zone.slug,
        displayName: zone.displayName,
        timezone: daylight.timezone,
      },
      heatOnBelowByRole: findHeatOnBelowByRole(zone.rulesConfig),
      devices,
      nodeSlugs: nodes
        .filter((node) => node.zoneId === zone.id)
        .map((node) => node.slug),
      nights: listRecentNights(now, daylight, nightCount),
    };
  }

  private async findHeatingDevices(): Promise<HeatingDevice[]> {
    const entities = await this.devices.find({ order: { name: 'ASC' } });
    return entities.filter(hasHeatingRole).map((device) => ({
      id: device.id,
      name: device.name,
      role: device.role,
      zoneId: device.zoneId,
    }));
  }

  private async findHistorySince(
    since: Date,
    nodes: readonly Node[],
    now: Date,
  ): Promise<ZoneHistory> {
    const [transitions, temperatureBuckets] = await Promise.all([
      findRelayTransitionsSince(this.transitions, since),
      this.readings.bucketTemperatures(
        { from: since, to: now },
        FREEZE_MARGIN_BUCKET_MINUTES,
      ),
    ]);
    return {
      spans: buildSpansByLine(
        transitions,
        mapSightingsByNode(nodes),
        now,
      ).flat(),
      temperatureBuckets,
    };
  }

  private async summariseZone(
    heatedZone: HeatedZone,
    history: ZoneHistory,
  ): Promise<ZoneFreezeMargin> {
    return summariseZoneFreezeMargin({
      zone: heatedZone.zone,
      heatOnBelowByRole: heatedZone.heatOnBelowByRole,
      devices: heatedZone.devices,
      nights: await this.findColdestEachNight(heatedZone),
      temperatureBuckets: history.temperatureBuckets.filter((bucket) =>
        heatedZone.nodeSlugs.includes(bucket.nodeId),
      ),
      bucketMinutes: FREEZE_MARGIN_BUCKET_MINUTES,
      spans: history.spans,
    });
  }

  private findColdestEachNight(
    heatedZone: HeatedZone,
  ): Promise<NightWithColdest[]> {
    return Promise.all(
      heatedZone.nights.map(async (night) => ({
        ...night,
        coldest: await this.readings.findColdestReading(
          night,
          heatedZone.nodeSlugs,
        ),
      })),
    );
  }

  // Never the host locale: that was the old DST bug.
  private defaultTimezone(): string {
    return this.config.get<string>('TEMPESTAS_TZ', DEFAULT_TIMEZONE);
  }
}

function hasHeatingRole(
  device: DeviceEntity,
): device is DeviceEntity & { role: DeviceRole } {
  return device.role !== null && HEATING_ROLES.includes(device.role);
}

function findEarliestNightStart(
  heatedZones: readonly HeatedZone[],
  now: Date,
): Date {
  const starts = heatedZones
    .flatMap((heatedZone) => heatedZone.nights)
    .map((night) => night.from.getTime());
  return new Date(Math.min(now.getTime(), ...starts));
}
