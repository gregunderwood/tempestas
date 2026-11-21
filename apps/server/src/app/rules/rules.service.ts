import {
  HttpException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ApiErrorCode,
  NodeStatus,
  type DecisionOutcome,
  type DeviceDispatch,
  type DeviceRole,
  type RuleDecision,
  type RuleReason,
  type RulesEvaluation,
  type RulesCycle,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { describeError } from '../common/describe-error';
import { HardwareService } from '../hardware/hardware.service';
import { DevicesService } from '../devices/devices.service';
import { NodesService } from '../nodes/nodes.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { DeviceEntity } from '../devices/models';
import { SensorReadingEntity } from '../readings/models';
import { ZoneEntity } from '../zones/models';
import { resolveClimate, type NodeSample } from './climate-resolver';
import { evaluateRules } from './rules.engine';
import { parseZoneRulesConfig } from './rules-config';
import { localTimeLabel, minutesSinceMidnight } from './local-time';
import { collectStaleRoles } from './stale-roles';

// One evaluation per sensor sample: 8,640 a day.
const EVALUATION_INTERVAL_MS = 10_000;

// Both no-op flavours repeat forever, so they log at debug even when they change.
const QUIET_REASONS: ReadonlySet<RuleReason> = new Set([
  'role-not-owned',
  'no-sensor',
]);

const ALREADY_IN_STATE_CODES: ReadonlySet<ApiErrorCode> = new Set([
  ApiErrorCode.DeviceAlreadyOn,
  ApiErrorCode.DeviceAlreadyOff,
]);

type ClimateByRole = RulesEvaluation['climateByRole'];

interface LatestSampleRow {
  slug: string;
  sensorId: string;
  temperature: number;
  co2: number | null;
  observedAt: Date | string;
}

@Injectable()
export class RulesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RulesService.name);
  private readonly lastEvaluations = new Map<string, RulesEvaluation>();
  // `${zoneId}:${role}` -> `${desired}:${reason}`, so repeats stay silent.
  private readonly lastDecisions = new Map<string, string>();
  private readonly lastOwnership = new Map<string, string>();
  private readonly failingZoneReasons = new Map<string, string>();
  private latestRulesCycle: RulesCycle | null = null;
  private isEvaluating = false;

  constructor(
    @InjectRepository(ZoneEntity)
    private readonly zones: Repository<ZoneEntity>,
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    private readonly devices: DevicesService,
    private readonly nodes: NodesService,
    private readonly realtime: RealtimeGateway,
    private readonly clock: Clock,
    private readonly hardware: HardwareService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const zone of await this.zones.find()) {
      // Skipped rather than crashing bootstrap: its first evaluation reports it, loudly.
      const parsed = parseZoneRulesConfig(zone.rulesConfig);
      if (parsed.ok) {
        this.logOwnership(zone, parsed.config.enabledRoles);
      }
    }
  }

  @Interval(EVALUATION_INTERVAL_MS)
  async tick(): Promise<void> {
    try {
      await this.runTick();
    } catch (error: unknown) {
      // The interval timer catches nothing, so a rejection here would take the server down.
      this.logger.error(`Rules tick failed: ${describeError(error)}`);
    }
  }

  private async runTick(): Promise<void> {
    // Acting on decisions is the leader's job alone, so a follower does not evaluate at all.
    if (!this.hardware.isLeader) {
      this.forgetCycleAsFollower();
      await this.publishStatus([]);
      return;
    }
    // A slow database must not queue evaluations; dispatch is level-triggered, so nothing is lost.
    if (this.isEvaluating) {
      this.logger.warn('Previous evaluation still running; skipping this tick');
      return;
    }
    this.isEvaluating = true;
    try {
      await this.evaluateAll();
    } finally {
      this.isEvaluating = false;
    }
  }

  async evaluateAll(): Promise<RulesEvaluation[]> {
    const zones = await this.zones.find({ order: { slug: 'ASC' } });
    const evaluations: RulesEvaluation[] = [];

    for (const zone of zones) {
      try {
        evaluations.push(await this.evaluateZone(zone));
        this.failingZoneReasons.delete(zone.slug);
      } catch (error: unknown) {
        this.recordFailingZone(zone, error);
      }
    }

    this.forgetFailuresOfRemovedZones(zones);
    if (!this.hardware.isLeader) {
      await this.publishStatus([]);
      return evaluations;
    }
    this.publishCycle(evaluations);
    await this.publishStatus(evaluations);
    return evaluations;
  }

  // Recorded as well as logged: an unevaluated zone is a heater nobody is controlling.
  private recordFailingZone(zone: ZoneEntity, error: unknown): void {
    const message = describeError(error);
    this.failingZoneReasons.set(zone.slug, message);
    this.logger.error(`Evaluation failed for zone "${zone.slug}": ${message}`);
  }

  private forgetFailuresOfRemovedZones(zones: ZoneEntity[]): void {
    const existingSlugs = new Set(zones.map((zone) => zone.slug));
    for (const slug of [...this.failingZoneReasons.keys()]) {
      if (!existingSlugs.has(slug)) {
        this.failingZoneReasons.delete(slug);
      }
    }
  }

  private publishCycle(evaluations: RulesEvaluation[]): void {
    this.latestRulesCycle = {
      at: this.clock.now().toISOString(),
      evaluations,
      failingZones: [...this.failingZoneReasons].map(([zoneSlug, reason]) => ({
        zoneSlug,
        reason,
      })),
    };
    this.realtime.publishRulesCycle(this.latestRulesCycle);
  }

  private forgetCycleAsFollower(): void {
    if (!this.latestRulesCycle) {
      return;
    }
    this.latestRulesCycle = null;
    this.realtime.forgetRulesCycle();
  }

  // One status per cycle, not per zone: the banner it drives belongs to the installation.
  private async publishStatus(evaluations: RulesEvaluation[]): Promise<void> {
    const staleRoles = collectStaleRoles(evaluations);
    const counts = await this.nodes.counts();
    const lastEvaluationAt = evaluations
      .map((evaluation) => evaluation.evaluatedAt)
      .sort()
      .at(-1);

    this.realtime.publishSystemStatus({
      at: this.clock.now().toISOString(),
      sensorStale: staleRoles.length > 0,
      staleRoles,
      nodesOnline: counts.online,
      nodesTotal: counts.total,
      nodesPending: counts.pending,
      isLeading: this.hardware.isLeader,
      lastEvaluationAt: lastEvaluationAt ?? null,
    });
  }

  async evaluateZone(zone: ZoneEntity): Promise<RulesEvaluation> {
    const now = this.clock.now();
    const parsed = parseZoneRulesConfig(zone.rulesConfig);
    if (parsed.ok === false) {
      // Not even the roles that look fine: half-evaluating a zone hides that the other half is uncontrolled.
      throw new Error(`invalid rules_config: ${parsed.errors.join('; ')}`);
    }
    const config = parsed.config;

    const samples = await this.findLatestSamplesForZone(zone.id);
    const { climateByRole, staleRoles } = resolveClimate(samples, config, now);
    const minutesSinceMidnightLocal = minutesSinceMidnight(
      now,
      config.timezone,
    );

    this.logOwnership(zone, config.enabledRoles);

    const decisions = evaluateRules({
      minutesSinceMidnightLocal,
      config,
      enabledRoles: config.enabledRoles,
      climateByRole,
      staleRoles,
    });

    this.logStaleOwnedRoles(zone, config.enabledRoles, staleRoles);
    const outcomes = await this.dispatchDecisions(
      zone,
      decisions,
      climateByRole,
    );

    const evaluation: RulesEvaluation = {
      zoneId: zone.id,
      zoneSlug: zone.slug,
      evaluatedAt: now.toISOString(),
      minutesSinceMidnightLocal,
      localTime: localTimeLabel(now, config.timezone),
      timezone: config.timezone,
      enabledRoles: [...config.enabledRoles],
      climateByRole,
      staleRoles,
      decisions: outcomes,
    };
    this.lastEvaluations.set(zone.id, evaluation);
    return evaluation;
  }

  findFailingZones(): ReadonlyMap<string, string> {
    return this.failingZoneReasons;
  }

  findLatestRulesCycle(): RulesCycle | null {
    return this.latestRulesCycle;
  }

  findLastEvaluations(): RulesEvaluation[] {
    return [...this.lastEvaluations.values()].sort((newer, older) =>
      older.evaluatedAt.localeCompare(newer.evaluatedAt),
    );
  }

  // ERROR, beside the dashboard banner: "hold last state" is only sound if the alarm cannot be missed.
  private logStaleOwnedRoles(
    zone: ZoneEntity,
    enabledRoles: readonly DeviceRole[],
    staleRoles: readonly DeviceRole[],
  ): void {
    for (const role of staleRoles) {
      if (enabledRoles.includes(role)) {
        this.logger.error(
          `Sensors for "${role}" in zone "${zone.slug}" are STALE - holding last state`,
        );
      }
    }
  }

  private async dispatchDecisions(
    zone: ZoneEntity,
    decisions: RuleDecision[],
    climateByRole: ClimateByRole,
  ): Promise<DecisionOutcome[]> {
    const outcomes: DecisionOutcome[] = [];
    for (const decision of decisions) {
      this.logDecision(
        zone,
        decision,
        climateByRole[decision.role]?.temperatureC,
      );
      outcomes.push({
        ...decision,
        dispatched: await this.dispatch(zone, decision),
      });
    }
    return outcomes;
  }

  // Per sensor, not per node, so a frozen pipe cannot hide behind a warm probe on the same node.
  private async findLatestSamplesForZone(
    zoneId: string,
  ): Promise<NodeSample[]> {
    const rows = await this.readings
      .createQueryBuilder('reading')
      .innerJoin('reading.node', 'node')
      .select('node.slug', 'slug')
      .addSelect('reading.sensorId', 'sensorId')
      .addSelect('reading.temperature', 'temperature')
      .addSelect('reading.co2', 'co2')
      .addSelect('reading.createdAt', 'observedAt')
      .distinctOn(['reading.nodeId', 'reading.sensorId'])
      .where('node.zoneId = :zoneId', { zoneId })
      // Ingest already drops pending nodes; checked again on the path that can start a burner.
      .andWhere('node.status = :status', { status: NodeStatus.Admitted })
      .orderBy('reading.nodeId')
      .addOrderBy('reading.sensorId')
      .addOrderBy('reading.createdAt', 'DESC')
      .getRawMany<LatestSampleRow>();

    return rows.map(toNodeSample);
  }

  // Several devices can share a (zone, role), each with its own rulesEnabled and cooldown.
  private async dispatch(
    zone: ZoneEntity,
    decision: RuleDecision,
  ): Promise<DeviceDispatch[]> {
    if (decision.desired === 'noop') {
      return [];
    }

    const devices = await this.devices.findByRole(zone.id, decision.role);
    const dispatched: DeviceDispatch[] = [];

    for (const device of devices) {
      if (!device.rulesEnabled) {
        // A manual override: the REST API still drives it; automation does not.
        dispatched.push(recordOutcome(device, 'rules-disabled'));
        continue;
      }
      dispatched.push(await this.drive(device, decision.desired));
    }
    return dispatched;
  }

  private async drive(
    device: DeviceEntity,
    desired: 'on' | 'off',
  ): Promise<DeviceDispatch> {
    try {
      await (desired === 'on'
        ? this.devices.turnOn(device.id)
        : this.devices.turnOff(device.id));
      this.logger.log(`${device.name} -> ${desired} by rule`);
      return recordOutcome(device, 'applied');
    } catch (error: unknown) {
      return this.recordRefusal(device, desired, error);
    }
  }

  private recordRefusal(
    device: DeviceEntity,
    desired: 'on' | 'off',
    error: unknown,
  ): DeviceDispatch {
    const responseBody =
      error instanceof HttpException ? error.getResponse() : null;
    const code = readErrorCode(responseBody);

    // The common case at 8,640 evaluations a day: the device is already where the rule wants it.
    if (code !== null && ALREADY_IN_STATE_CODES.has(code)) {
      return recordOutcome(device, 'already-in-state');
    }

    // The anti-short-cycle interlock doing its job; debug, so it cannot bury a real failure.
    if (code === ApiErrorCode.DeviceCooldown) {
      const canTurnOnAt = readDetail(responseBody, 'canTurnOnAt');
      this.logger.debug(
        `${device.name} in cooldown until ${canTurnOnAt ?? 'unknown'}`,
      );
      return recordOutcome(device, 'cooldown', canTurnOnAt);
    }

    const failure = code ?? describeError(error);
    this.logger.warn(`${device.name} failed to go ${desired}: ${failure}`);
    return recordOutcome(device, 'failed', failure);
  }

  // Only on change: a line per evaluation is how the old system wrote a 5.4 GB log.
  private logDecision(
    zone: ZoneEntity,
    decision: RuleDecision,
    temperatureC?: number,
  ): void {
    const key = `${zone.id}:${decision.role}`;
    const signature = `${decision.desired}:${decision.reason}`;
    if (this.lastDecisions.get(key) === signature) {
      return;
    }
    this.lastDecisions.set(key, signature);

    const temperatureSuffix =
      temperatureC === undefined ? '' : ` at ${temperatureC} °C`;
    const line = `${zone.slug}/${decision.role}: ${decision.desired} (${decision.reason})${temperatureSuffix}`;

    if (QUIET_REASONS.has(decision.reason)) {
      this.logger.debug(line);
      return;
    }
    this.logger.log(line);
  }

  private logOwnership(zone: ZoneEntity, roles: readonly DeviceRole[]): void {
    const signature = [...roles].sort().join(',');
    const previous = this.lastOwnership.get(zone.id);
    if (previous === signature) {
      return;
    }
    this.lastOwnership.set(zone.id, signature);
    const previousSuffix =
      previous === undefined ? '' : ` (was [${previous || 'nothing'}])`;
    this.logger.warn(
      `Zone "${zone.slug}" now controls [${signature || 'nothing'}]${previousSuffix}`,
    );
  }
}

function toNodeSample(row: LatestSampleRow): NodeSample {
  return {
    nodeId: row.slug,
    sensorId: row.sensorId,
    temperatureC: Number(row.temperature),
    co2Ppm: row.co2 === null ? null : Number(row.co2),
    observedAt: new Date(row.observedAt),
  };
}

function recordOutcome(
  device: DeviceEntity,
  outcome: DeviceDispatch['outcome'],
  detail?: string,
): DeviceDispatch {
  return {
    deviceId: device.id,
    deviceName: device.name,
    outcome,
    ...(detail ? { detail } : {}),
  };
}

function readErrorCode(responseBody: unknown): ApiErrorCode | null {
  if (
    responseBody &&
    typeof responseBody === 'object' &&
    'code' in responseBody
  ) {
    return (responseBody as { code: ApiErrorCode }).code;
  }
  return null;
}

function readDetail(responseBody: unknown, key: string): string | undefined {
  if (
    !responseBody ||
    typeof responseBody !== 'object' ||
    !('details' in responseBody)
  ) {
    return undefined;
  }
  const details = (responseBody as { details?: Record<string, unknown> })
    .details;
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}
