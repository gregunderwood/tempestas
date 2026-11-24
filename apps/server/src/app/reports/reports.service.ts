import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EQUIPMENT_RUNTIME_DEFAULT_DAYS,
  type EquipmentRuntimeQuery,
  type EquipmentRuntimeReport,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { MILLISECONDS_PER_DAY } from '../common/time-units';
import { DeviceEntity, PinTransitionEntity } from '../devices/models';
import {
  findRelayTransitionsSince,
  mapSightingsByNode,
} from '../devices/relay-history';
import { NodesService } from '../nodes/nodes.service';
import { parseZoneRulesConfig } from '../rules/rules-config';
import type { ZoneEntity } from '../zones/models';
import {
  summariseEquipmentRuntime,
  type RuntimeDevice,
} from './equipment-runtime';

const DEFAULT_TIMEZONE = 'America/Vancouver';
// A day of slack reaches back past the earliest local midnight in any zone; the summary trims to it.
const LOOKBACK_SLACK_DAYS = 1;

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(PinTransitionEntity)
    private readonly transitions: Repository<PinTransitionEntity>,
    private readonly nodes: NodesService,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async buildEquipmentRuntime(
    query: EquipmentRuntimeQuery,
  ): Promise<EquipmentRuntimeReport> {
    const days = query.days ?? EQUIPMENT_RUNTIME_DEFAULT_DAYS;
    const now = this.clock.now();
    const since = new Date(
      now.getTime() - (days + LOOKBACK_SLACK_DAYS) * MILLISECONDS_PER_DAY,
    );
    const [devices, transitions, sightingsByNode] = await Promise.all([
      this.findRuntimeDevices(),
      findRelayTransitionsSince(this.transitions, since),
      this.nodes.findAll().then(mapSightingsByNode),
    ]);
    return {
      days,
      generatedAt: now.toISOString(),
      devices: summariseEquipmentRuntime({
        devices,
        transitions,
        sightingsByNode,
        days,
        now,
      }),
    };
  }

  private async findRuntimeDevices(): Promise<RuntimeDevice[]> {
    const entities = await this.devices.find({
      relations: { node: true, zone: true },
      order: { name: 'ASC' },
    });
    return entities.map((device) => ({
      id: device.id,
      name: device.name,
      role: device.role,
      nodeId: device.node.slug,
      zoneId: device.zoneId,
      timezone: this.resolveTimezone(device.zone),
      addedAt: device.createdAt,
    }));
  }

  // History, not control: a zone whose rules do not parse still has a calendar.
  private resolveTimezone(zone: ZoneEntity): string {
    const parsed = parseZoneRulesConfig(zone.rulesConfig);
    if (parsed.ok) return parsed.config.timezone;
    return this.config.get<string>('TEMPESTAS_TZ', DEFAULT_TIMEZONE);
  }
}
