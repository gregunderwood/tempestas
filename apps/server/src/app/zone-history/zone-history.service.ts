import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ZONE_HISTORY_BUCKET_MINUTES,
  ZONE_HISTORY_HOURS,
  type ZoneHistoryReport,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { MILLISECONDS_PER_HOUR } from '../common/time-units';
import { DeviceEntity, PinTransitionEntity } from '../devices/models';
import {
  findRelayTransitionsSince,
  mapSightingsByNode,
} from '../devices/relay-history';
import { NodesService } from '../nodes/nodes.service';
import { ReadingsService } from '../readings/readings.service';
import { ZoneEntity } from '../zones/models';
import { buildZoneHistoryReport, type HistoryDevice } from './zone-history';

@Injectable()
export class ZoneHistoryService {
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
  ) {}

  async buildZoneHistory(): Promise<ZoneHistoryReport> {
    const now = this.clock.now();
    const from = new Date(
      now.getTime() - ZONE_HISTORY_HOURS * MILLISECONDS_PER_HOUR,
    );
    const [zones, nodes, devices, transitions, temperatureBuckets] =
      await Promise.all([
        this.zones.find({ order: { slug: 'ASC' } }),
        this.nodes.findAll(),
        this.findHistoryDevices(),
        findRelayTransitionsSince(this.transitions, from),
        this.readings.bucketTemperatures(
          { from, to: now },
          ZONE_HISTORY_BUCKET_MINUTES,
        ),
      ]);
    return buildZoneHistoryReport({
      zoneIds: zones.map((zone) => zone.id),
      nodes,
      devices,
      transitions,
      sightingsByNode: mapSightingsByNode(nodes),
      temperatureBuckets,
      from,
      now,
    });
  }

  private async findHistoryDevices(): Promise<HistoryDevice[]> {
    const entities = await this.devices.find({
      relations: { node: true },
      order: { name: 'ASC' },
    });
    return entities.map((device) => ({
      id: device.id,
      name: device.name,
      role: device.role,
      nodeId: device.node.slug,
      zoneId: device.zoneId,
      addedAt: device.createdAt,
    }));
  }
}
