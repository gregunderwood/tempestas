import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Subscription } from 'rxjs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ApiErrorCode,
  type Device,
  type DeviceRole,
  type GpioLevel,
} from '@tempestas/domain';
import { acceptsCommands } from '../nodes/node-registry';
import { NodeEntity } from '../nodes/models';
import { Clock } from '../common/clock';
import {
  HardwareService,
  type PinStateReport,
} from '../hardware/hardware.service';
import { translateHardwareError } from '../hardware/hardware-http-error';
import { toPinKey } from '../hardware/pin-key';
import { DivergenceLog } from '../common/divergence-log';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DeviceEntity } from './models';
import type { CreateDeviceDto } from './dto/create-device.dto';
import type { UpdateDeviceDto } from './dto/update-device.dto';
import { canTurnOn, canTurnOnAt, isOn } from './device-state';
import {
  correctionPatch,
  reconcileNewMapping,
  reconcilePinState,
  type Reconciliation,
} from './reconcile-pin-state';
import { findDeviceOnPin } from './find-device-on-pin';
import { NodeBoots } from './node-boots';
import { PerDeviceQueue } from './per-device-queue';

type Direction = 'on' | 'off';
type Correction = Extract<Reconciliation, { action: 'correct' }>;

interface ReportArrival {
  report: PinStateReport;
  isFirstReportSinceBoot: boolean;
  commandsSentBefore: number;
}

// The single owner of the on/off interlocks; every switch funnels through `drive()`.
@Injectable()
export class DevicesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DevicesService.name);
  private readonly subscriptions = new Subscription();
  private readonly nodeBoots = new NodeBoots();
  // Our own command's `gpio/state` must not be reconciled as a divergence; see docs/Safety.md 3c.
  private readonly pinsMidCommand = new Set<string>();
  private readonly commandCountsByPin = new Map<string, number>();
  // Edits, switches and corrections of one device run in turn, or a save writes back stale columns.
  private readonly deviceWrites = new PerDeviceQueue();

  constructor(
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(NodeEntity)
    private readonly nodes: Repository<NodeEntity>,
    private readonly hardware: HardwareService,
    private readonly clock: Clock,
    private readonly realtime: RealtimeGateway,
    private readonly divergences: DivergenceLog,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscriptions.add(
      this.hardware.hello$.subscribe((hello) =>
        this.nodeBoots.recordHello(hello.nodeId, hello.bootId),
      ),
    );
    this.subscriptions.add(
      this.hardware.pinStates$.subscribe((report) =>
        this.reconcileInBackground(report),
      ),
    );
    await this.rememberStoredBootIds();
  }

  onModuleDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  async findAll(): Promise<Device[]> {
    const rows = await this.devices.find({
      relations: { node: true },
      order: { name: 'ASC' },
    });
    return rows.map((row) => this.toDto(row));
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

  async findByRole(zoneId: string, role: DeviceRole): Promise<DeviceEntity[]> {
    return this.devices.find({
      where: { zoneId, role },
      relations: { node: true },
    });
  }

  async create(dto: CreateDeviceDto): Promise<Device> {
    const node = await this.findNodeBySlug(dto.nodeId);
    assertPinAvailable(node, dto.gpio);
    await this.assertPinUnclaimed(node, dto.gpio);

    const row = this.devices.create({
      ...dto,
      nodeId: node.id,
      zoneId: dto.zoneId ?? node.zoneId ?? undefined,
      description: dto.description ?? null,
      rulesEnabled: dto.rulesEnabled ?? true,
      role: dto.role ?? null,
      inputBtuPerHour: dto.inputBtuPerHour ?? null,
    } as Partial<DeviceEntity>);
    this.seedFromLastReport(row, node, dto.gpio);

    const saved = await this.devices.save(row);
    saved.node = node;
    return this.publishSaved(saved);
  }

  update(id: string, dto: UpdateDeviceDto): Promise<Device> {
    return this.deviceWrites.runInTurn(id, () => this.applyEdit(id, dto));
  }

  setRulesEnabled(id: string, rulesEnabled: boolean): Promise<Device> {
    return this.deviceWrites.runInTurn(id, () =>
      this.applyRulesEnabled(id, rulesEnabled),
    );
  }

  async remove(id: string): Promise<void> {
    const row = await this.findOneEntity(id);
    await this.devices.remove(row);
  }

  turnOn(id: string): Promise<Device> {
    return this.deviceWrites.runInTurn(id, async () => {
      const device = await this.findOneEntity(id);
      assertIsOff(device);
      assertCooldownOver(device, this.clock.now());
      return this.drive(device, device.onLevel, 'on');
    });
  }

  /** Bypasses the cooldown, but NOT the already-on check. */
  forceOn(id: string): Promise<Device> {
    return this.deviceWrites.runInTurn(id, async () => {
      const device = await this.findOneEntity(id);
      assertIsOff(device);
      return this.drive(device, device.onLevel, 'on');
    });
  }

  turnOff(id: string): Promise<Device> {
    return this.deviceWrites.runInTurn(id, async () => {
      const device = await this.findOneEntity(id);
      assertIsOn(device);
      return this.drive(device, offLevelOf(device), 'off');
    });
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
      inputBtuPerHour: row.inputBtuPerHour,
      isOn: isOn(row),
      canTurnOn: canTurnOn(row, now),
      canTurnOnAt: earliest?.toISOString() ?? null,
    };
  }

  private async rememberStoredBootIds(): Promise<void> {
    const nodes = await this.nodes.find();
    for (const node of nodes) {
      this.nodeBoots.rememberStoredBootId(node.slug, node.bootId);
    }
  }

  private reconcileInBackground(report: PinStateReport): void {
    const pinKey = toPinKey(report.nodeId, report.pin);
    // Decided as the report arrives, before any await can reorder it behind a later one.
    const arrival: ReportArrival = {
      report,
      isFirstReportSinceBoot: this.nodeBoots.isFirstReportSinceBoot(
        report.nodeId,
        report.pin,
      ),
      commandsSentBefore: this.commandsSentTo(pinKey),
    };
    // Caught here so one failure cannot end the subscription.
    void this.reconcile(arrival).catch((error: unknown) => {
      this.logger.error(
        `Reconciling ${report.nodeId} pin ${report.pin} failed: ${String(error)}`,
      );
    });
  }

  private async reconcile(arrival: ReportArrival): Promise<void> {
    const { report } = arrival;
    if (this.pinsMidCommand.has(toPinKey(report.nodeId, report.pin))) return;

    const deviceOnPin = await findDeviceOnPin(
      this.devices,
      report.nodeId,
      report.pin,
    );
    if (!deviceOnPin) return;

    // Loaded and saved in the device's turn, or an edit or switch in between is quietly undone.
    await this.deviceWrites.runInTurn(deviceOnPin.id, () =>
      this.correctFromReport(deviceOnPin.id, arrival),
    );
  }

  private async correctFromReport(
    deviceId: string,
    arrival: ReportArrival,
  ): Promise<void> {
    if (this.wasOvertakenByCommand(arrival)) return;

    const { report } = arrival;
    const device = await findDeviceOnPin(
      this.devices,
      report.nodeId,
      report.pin,
    );
    const isStillOnPin = device?.id === deviceId;
    if (!isStillOnPin) return;

    const now = this.clock.now();
    const verdict = reconcilePinState(device, report, now);
    if (verdict.action !== 'correct') return;

    Object.assign(device, correctionPatch(verdict));
    await this.devices.save(device);

    this.reportDivergence(device, arrival, verdict, now);
    this.realtime.publishDeviceState(this.toDto(device));
  }

  // A report taken before our own later command describes the pin as it was, however live it is.
  private wasOvertakenByCommand(arrival: ReportArrival): boolean {
    const { report, commandsSentBefore } = arrival;
    const pinKey = toPinKey(report.nodeId, report.pin);
    return this.commandsSentTo(pinKey) !== commandsSentBefore;
  }

  private commandsSentTo(pinKey: string): number {
    return this.commandCountsByPin.get(pinKey) ?? 0;
  }

  private reportDivergence(
    device: DeviceEntity,
    arrival: ReportArrival,
    verdict: Correction,
    now: Date,
  ): void {
    const { report, isFirstReportSinceBoot } = arrival;
    this.divergences.record({
      deviceName: device.name,
      nodeId: report.nodeId,
      pin: report.pin,
      hardwareOn: verdict.hardwareOn,
      reason: verdict.reason,
      isExplainedByReboot: isFirstReportSinceBoot,
      at: now,
    });
    const correction =
      `${verdict.reason}; corrected the row to ` +
      `${describeOnOff(verdict.hardwareOn)} as of ${verdict.at.toISOString()}`;
    if (isFirstReportSinceBoot) {
      this.logger.warn(
        `${device.name} (${report.nodeId} pin ${report.pin}) changed when ` +
          `${report.nodeId} restarted and claimed its fail-safe level: ${correction}`,
      );
      return;
    }
    this.logger.error(
      `DIVERGENCE on ${device.name} (${report.nodeId} pin ${report.pin}): ${correction}`,
    );
  }

  // Saving switches nothing; a remapped pin is read under its new mapping straight away.
  private async applyEdit(id: string, dto: UpdateDeviceDto): Promise<Device> {
    const row = await this.findOneEntity(id);
    const isRemapping = changesRelayMapping(row, dto);
    if (isRemapping) assertIsOffForRemapping(row);
    if (dto.gpio !== undefined && dto.gpio !== row.gpio) {
      assertPinAvailable(row.node, dto.gpio);
      await this.assertPinUnclaimed(row.node, dto.gpio);
    }

    Object.assign(row, dto);
    if (isRemapping) this.seedFromLastReport(row, row.node, row.gpio);
    return this.publishSaved(await this.devices.save(row));
  }

  private async applyRulesEnabled(
    id: string,
    rulesEnabled: boolean,
  ): Promise<Device> {
    const row = await this.findOneEntity(id);
    row.rulesEnabled = rulesEnabled;
    return this.publishSaved(await this.devices.save(row));
  }

  private publishSaved(row: DeviceEntity): Device {
    const device = this.toDto(row);
    this.realtime.publishDeviceState(device);
    return device;
  }

  // Checked here so a clash is a 409 naming the device, not a 500 from the unique constraint.
  private async assertPinUnclaimed(
    node: NodeEntity,
    pin: number,
  ): Promise<void> {
    const occupant = await this.devices.findOneBy({
      nodeId: node.id,
      gpio: pin,
    });
    if (!occupant) return;
    throw new ConflictException({
      code: ApiErrorCode.PinNotAvailable,
      message: `Pin ${pin} on "${node.slug}" is already used by ${occupant.name}`,
      details: { usedBy: occupant.id },
    });
  }

  // `nodeId` on the wire is the node slug; the foreign key is the node's uuid.
  private async findNodeBySlug(slug: string): Promise<NodeEntity> {
    const node = await this.nodes.findOne({ where: { slug } });
    if (!node) {
      throw new NotFoundException({
        code: ApiErrorCode.NotFound,
        message: `Node "${slug}" not found`,
      });
    }
    return node;
  }

  // The node may have reported this pin before the device existed; see docs/Pumphouse.md.
  private seedFromLastReport(
    row: DeviceEntity,
    node: NodeEntity,
    pin: number,
  ): void {
    const report = this.hardware.lastPinReport(node.slug, pin);
    if (!report) return;

    const verdict = reconcileNewMapping(row, report, this.clock.now());
    if (verdict.action !== 'correct') return;

    Object.assign(row, correctionPatch(verdict));
    this.logger.log(
      `${row.name} starts ${describeOnOff(verdict.hardwareOn)}: ` +
        `${node.slug} pin ${pin} reported level ${String(report.level)}`,
    );
  }

  // Publish first and persist only on success: docs/Safety.md rule 3.
  private async drive(
    device: DeviceEntity,
    level: GpioLevel,
    direction: Direction,
  ): Promise<Device> {
    assertNodeAcceptsCommands(device.node);

    const pinKey = toPinKey(device.node.slug, device.gpio);
    this.pinsMidCommand.add(pinKey);
    try {
      await this.hardware.setPin(device.node.slug, {
        pin: device.gpio,
        level,
        label: device.name,
      });
    } catch (error: unknown) {
      this.pinsMidCommand.delete(pinKey);
      throw translateHardwareError(error);
    }
    this.commandCountsByPin.set(pinKey, this.commandsSentTo(pinKey) + 1);

    stampTransition(device, direction, this.clock.now());
    try {
      await this.devices.save(device);
    } finally {
      this.pinsMidCommand.delete(pinKey);
    }
    this.logger.log(
      `${device.name} -> ${direction} (node ${device.node.slug} pin ${device.gpio})`,
    );

    const dto = this.toDto(device);
    this.realtime.publishDeviceState(dto);
    return dto;
  }
}

function assertPinAvailable(node: NodeEntity, pin: number): void {
  const pins = node.capabilities?.gpio?.pins ?? [];
  if (pins.includes(pin)) return;
  throw new ConflictException({
    code: ApiErrorCode.PinNotAvailable,
    message: `Node "${node.slug}" does not expose GPIO pin ${pin}`,
    details: { availablePins: pins },
  });
}

function changesRelayMapping(
  device: DeviceEntity,
  dto: UpdateDeviceDto,
): boolean {
  const changesPin = dto.gpio !== undefined && dto.gpio !== device.gpio;
  const changesOnLevel =
    dto.onLevel !== undefined && dto.onLevel !== device.onLevel;
  return changesPin || changesOnLevel;
}

// Moving an energised device would leave its old relay on with nothing tracking it.
function assertIsOffForRemapping(device: DeviceEntity): void {
  if (!isOn(device)) return;
  throw new ConflictException({
    code: ApiErrorCode.DeviceAlreadyOn,
    message: `${device.name} is on; turn it off before changing its pin or on level`,
  });
}

function assertIsOff(device: DeviceEntity): void {
  if (!isOn(device)) return;
  throw new ConflictException({
    code: ApiErrorCode.DeviceAlreadyOn,
    message: `${device.name} is already on`,
  });
}

function assertIsOn(device: DeviceEntity): void {
  if (isOn(device)) return;
  throw new ConflictException({
    code: ApiErrorCode.DeviceAlreadyOff,
    message: `${device.name} is already off`,
  });
}

function assertCooldownOver(device: DeviceEntity, now: Date): void {
  if (canTurnOn(device, now)) return;
  throw new ConflictException({
    code: ApiErrorCode.DeviceCooldown,
    message: `${device.name} is within its minimum-off time`,
    details: { canTurnOnAt: canTurnOnAt(device)?.toISOString() ?? null },
  });
}

// Reachability is the transport's problem; this is whether we are willing to drive the node at all.
function assertNodeAcceptsCommands(node: NodeEntity): void {
  if (acceptsCommands(node.status)) return;
  throw new ConflictException({
    code: ApiErrorCode.NodeNotAdmitted,
    message: `Node "${node.slug}" is ${node.status}; it receives no commands`,
    details: { nodeStatus: node.status },
  });
}

function offLevelOf(device: DeviceEntity): GpioLevel {
  return (1 - device.onLevel) as GpioLevel;
}

function stampTransition(
  device: DeviceEntity,
  direction: Direction,
  now: Date,
): void {
  if (direction === 'on') {
    device.onAt = now;
    return;
  }
  device.offAt = now;
}

function describeOnOff(isOnNow: boolean): string {
  return isOnNow ? 'ON' : 'OFF';
}
