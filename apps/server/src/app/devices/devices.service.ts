import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiErrorCode, type Device, type GpioLevel } from '@tempestas/domain';
import { acceptsCommands } from '../nodes/node-registry';
import { NodeEntity } from '../nodes/models';
import { Clock } from '../common/clock';
import { HardwareService } from '../hardware/hardware.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DeviceEntity } from './models';
import type { CreateDeviceDto } from './dto/create-device.dto';
import type { UpdateDeviceDto } from './dto/update-device.dto';
import { canTurnOn, canTurnOnAt, isOn } from './device-state';

/**
 * The single owner of the on/off interlocks.
 *
 * The Python system enforced these by having its rules engine POST to its own
 * REST API over loopback ~43,000 times a day. Here the rules engine calls this
 * service in-process instead - but the guarantee has to stay in exactly one
 * place, which is this file.
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(NodeEntity)
    private readonly nodes: Repository<NodeEntity>,
    private readonly hardware: HardwareService,
    private readonly clock: Clock,
    private readonly realtime: RealtimeGateway,
  ) {}

  async findAll(): Promise<Device[]> {
    const rows = await this.devices.find({
      relations: { node: true },
      order: { name: 'ASC' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async findOneEntity(id: string): Promise<DeviceEntity> {
    const row = await this.devices.findOne({
      where: { id },
      relations: { node: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: ApiErrorCode.NotFound,
        message: `Device ${id} not found`,
      });
    }
    return row;
  }

  async findOne(id: string): Promise<Device> {
    return this.toDto(await this.findOneEntity(id));
  }

  async findByRole(zoneId: string, role: string): Promise<DeviceEntity[]> {
    return this.devices.find({
      where: { zoneId, role: role as never },
      relations: { node: true },
    });
  }

  async create(dto: CreateDeviceDto): Promise<Device> {
    // `nodeId` on the wire is the node SLUG - it is the MQTT topic segment and
    // the stable human-chosen identifier. The FK is the node's uuid.
    const node = await this.nodes.findOne({ where: { slug: dto.nodeId } });
    if (!node) {
      throw new NotFoundException({
        code: ApiErrorCode.NotFound,
        message: `Node "${dto.nodeId}" not found`,
      });
    }
    this.assertPinAvailable(node, dto.gpio);

    const row = this.devices.create({
      ...dto,
      nodeId: node.id,
      zoneId: dto.zoneId ?? node.zoneId ?? undefined,
      description: dto.description ?? null,
      rulesEnabled: dto.rulesEnabled ?? true,
      role: dto.role ?? null,
    } as Partial<DeviceEntity>);
    const saved = await this.devices.save(row);
    saved.node = node;
    return this.toDto(saved);
  }

  /** A constraint the database cannot express: the node must expose the pin. */
  private assertPinAvailable(node: NodeEntity, pin: number): void {
    const pins = node.capabilities?.gpio?.pins ?? [];
    if (!pins.includes(pin)) {
      throw new ConflictException({
        code: ApiErrorCode.PinNotAvailable,
        message: `Node "${node.slug}" does not expose GPIO pin ${pin}`,
        details: { availablePins: pins },
      });
    }
  }

  async update(id: string, dto: UpdateDeviceDto): Promise<Device> {
    const row = await this.findOneEntity(id);
    Object.assign(row, dto);
    return this.toDto(await this.devices.save(row));
  }

  async setRulesEnabled(id: string, rulesEnabled: boolean): Promise<Device> {
    const row = await this.findOneEntity(id);
    row.rulesEnabled = rulesEnabled;
    const dto = this.toDto(await this.devices.save(row));
    // Handing a device to or from the rules engine changes what the UI has to
    // show about it, so it is a state change like any other.
    this.realtime.publishDeviceState(dto);
    return dto;
  }

  async remove(id: string): Promise<void> {
    const row = await this.findOneEntity(id);
    await this.devices.remove(row);
  }

  async turnOn(id: string): Promise<Device> {
    const device = await this.findOneEntity(id);
    if (isOn(device)) {
      throw new ConflictException({
        code: ApiErrorCode.DeviceAlreadyOn,
        message: `${device.name} is already on`,
      });
    }
    const now = this.clock.now();
    if (!canTurnOn(device, now)) {
      throw new ConflictException({
        code: ApiErrorCode.DeviceCooldown,
        message: `${device.name} is within its minimum-off time`,
        details: { canTurnOnAt: canTurnOnAt(device)?.toISOString() ?? null },
      });
    }
    return this.drive(device, device.onLevel, 'on');
  }

  /** Bypasses the cooldown, but NOT the already-on check. */
  async forceOn(id: string): Promise<Device> {
    const device = await this.findOneEntity(id);
    if (isOn(device)) {
      throw new ConflictException({
        code: ApiErrorCode.DeviceAlreadyOn,
        message: `${device.name} is already on`,
      });
    }
    return this.drive(device, device.onLevel, 'on');
  }

  async turnOff(id: string): Promise<Device> {
    const device = await this.findOneEntity(id);
    if (!isOn(device)) {
      throw new ConflictException({
        code: ApiErrorCode.DeviceAlreadyOff,
        message: `${device.name} is already off`,
      });
    }
    return this.drive(device, (1 - device.onLevel) as GpioLevel, 'off');
  }

  /**
   * Publish FIRST and await the acknowledgement, persist only on success.
   *
   * The old system did the reverse: a failed GPIO write was logged and the row
   * updated anyway, so the database silently drifted from the hardware and the
   * UI confidently showed a heater as running when it was not.
   */
  private async drive(
    device: DeviceEntity,
    level: GpioLevel,
    direction: 'on' | 'off',
  ): Promise<Device> {
    // The admission gate, on the way out. A node nobody admitted receives no
    // commands - the mirror of its readings being discarded on the way in.
    // Reachability is the transport's problem and surfaces as a rejected
    // setPin; this is about whether we are WILLING to drive it at all.
    if (!acceptsCommands(device.node.status)) {
      throw new ConflictException({
        code: ApiErrorCode.NodeNotAdmitted,
        message: `Node "${device.node.slug}" is ${device.node.status}; it receives no commands`,
        details: { nodeStatus: device.node.status },
      });
    }

    await this.hardware.setPin(device.node.slug, {
      pin: device.gpio,
      level,
      label: device.name,
    });

    const now = this.clock.now();
    if (direction === 'on') {
      device.onAt = now;
    } else {
      device.offAt = now;
    }
    await this.devices.save(device);
    this.logger.log(
      `${device.name} -> ${direction} (node ${device.node.slug} pin ${device.gpio})`,
    );

    // Published only after the hardware acknowledged AND the row was saved, so
    // the dashboard can never show a state the relay never reached.
    const dto = this.toDto(device);
    this.realtime.publishDeviceState(dto);
    return dto;
  }

  toDto(row: DeviceEntity): Device {
    const now = this.clock.now();
    const earliest = canTurnOnAt(row);
    return {
      id: row.id,
      nodeId: row.node.slug,
      zoneId: row.zoneId,
      name: row.name,
      description: row.description,
      gpio: row.gpio,
      onDelayDuration: row.onDelayDuration,
      onAt: row.onAt?.toISOString() ?? null,
      offAt: row.offAt?.toISOString() ?? null,
      onLevel: row.onLevel,
      rulesEnabled: row.rulesEnabled,
      role: row.role,
      isOn: isOn(row),
      canTurnOn: canTurnOn(row, now),
      canTurnOnAt: earliest?.toISOString() ?? null,
    };
  }
}
