import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import {
  EQUIPMENT_RUNTIME_DEFAULT_DAYS,
  type EquipmentRuntimeQuery,
  type EquipmentRuntimeReport,
  type Node,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { MILLISECONDS_PER_DAY } from '../common/time-units';
import { DeviceEntity, PinTransitionEntity } from '../devices/models';
import { NodesService } from '../nodes/nodes.service';
import { parseZoneRulesConfig } from '../rules/rules-config';
import type { ZoneEntity } from '../zones/models';
import {
  summariseEquipmentRuntime,
  type NodeSighting,
  type RuntimeDevice,
  type RuntimeTransition,
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
      this.findTransitionsSince(since),
      this.findSightingsByNode(),
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
    }));
  }

  // The row in force when the window opened too, or its first hours would read as unknown.
  private async findTransitionsSince(
    since: Date,
  ): Promise<RuntimeTransition[]> {
    const [inForceAtStart, inWindow] = await Promise.all([
      this.transitions
        .createQueryBuilder('pinTransition')
        .distinctOn(['pinTransition.nodeId', 'pinTransition.pin'])
        .where('pinTransition.observedAt < :since', { since })
        .orderBy('pinTransition.nodeId')
        .addOrderBy('pinTransition.pin')
        .addOrderBy('pinTransition.observedAt', 'DESC')
        .getMany(),
      this.transitions.find({ where: { observedAt: MoreThanOrEqual(since) } }),
    ]);
    return [...inForceAtStart, ...inWindow].map(toRuntimeTransition);
  }

  private async findSightingsByNode(): Promise<Map<string, NodeSighting>> {
    const nodes = await this.nodes.findAll();
    return new Map(nodes.map((node) => [node.slug, toSighting(node)]));
  }

  // History, not control: a zone whose rules do not parse still has a calendar.
  private resolveTimezone(zone: ZoneEntity): string {
    const parsed = parseZoneRulesConfig(zone.rulesConfig);
    if (parsed.ok) return parsed.config.timezone;
    return this.config.get<string>('TEMPESTAS_TZ', DEFAULT_TIMEZONE);
  }
}

function toRuntimeTransition(row: PinTransitionEntity): RuntimeTransition {
  return {
    nodeId: row.nodeId,
    pin: row.pin,
    energised: row.energised,
    deviceId: row.deviceId,
    observedAt: row.observedAt,
  };
}

function toSighting(node: Node): NodeSighting {
  return {
    isOnline: node.online,
    lastHeardAt: findLaterInstant(node.lastSeenAt, node.latestReadingAt),
  };
}

function findLaterInstant(...instants: (string | null)[]): Date | null {
  const known = instants
    .filter((instant): instant is string => instant !== null)
    .map((instant) => new Date(instant).getTime());
  return known.length === 0 ? null : new Date(Math.max(...known));
}
