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
  type RulesEvaluation,
  type RulesCycle,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
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

/** 10 s, which is one evaluation per sensor sample - 8,640 a day. */
const EVALUATION_INTERVAL_MS = 10_000;

/**
 * The impure shell around the pure engine: load, resolve, evaluate, dispatch.
 *
 * The Python system's rules engine drove devices by POSTing to its own REST API
 * over loopback ~43,000 times a day, because that was the only way to reuse the
 * interlocks. Here the interlocks live in `DevicesService` and this calls it
 * in-process - so a cooldown refusal is the same refusal a human gets from the
 * API, enforced in exactly one place.
 */
@Injectable()
export class RulesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RulesService.name);
  private readonly lastEvaluations = new Map<string, RulesEvaluation>();
  /** `${zoneId}:${role}` -> `${desired}:${reason}`, so repeats stay silent. */
  private readonly lastDecisions = new Map<string, string>();
  private readonly lastOwnership = new Map<string, string>();
  private readonly failingZoneReasons = new Map<string, string>();
  private latestRulesCycle: RulesCycle | null = null;
  private running = false;

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

  /** Ownership is logged once at startup, and after that only when it changes. */
  async onApplicationBootstrap(): Promise<void> {
    for (const zone of await this.zones.find()) {
      // A zone that does not parse is skipped here rather than crashing the
      // bootstrap: its first evaluation reports it, loudly, ten seconds later.
      const parsed = parseZoneRulesConfig(zone.rulesConfig);
      if (parsed.ok) this.logOwnership(zone, parsed.config.enabledRoles);
    }
  }

  @Interval(EVALUATION_INTERVAL_MS)
  async tick(): Promise<void> {
    // A follower evaluates nothing. Not because its decisions would be wrong,
    // but because acting on them is the leader's job alone - and a rules engine
    // that runs and then fails to dispatch just fills the log with refusals.
    if (!this.hardware.isLeader) {
      this.forgetCycleAsFollower();
      return;
    }
    // A slow database must not queue evaluations behind each other; the next
    // tick is 10 s away and level-triggered dispatch means nothing is lost.
    if (this.running) {
      this.logger.warn('Previous evaluation still running; skipping this tick');
      return;
    }
    this.running = true;
    try {
      await this.evaluateAll();
    } finally {
      this.running = false;
    }
  }

  async evaluateAll(): Promise<RulesEvaluation[]> {
    const zones = await this.zones.find({ order: { slug: 'ASC' } });
    const evaluations: RulesEvaluation[] = [];

    for (const zone of zones) {
      try {
        evaluations.push(await this.evaluateZone(zone));
        this.failingZoneReasons.delete(zone.slug);
      } catch (err: unknown) {
        // One zone with a hand-edited `rules_config` must not stop the others.
        // Recorded as well as logged: a zone that is not being evaluated is
        // a heater nobody is controlling, and the log is not where anybody
        // looks first.
        const message = err instanceof Error ? err.message : String(err);
        this.failingZoneReasons.set(zone.slug, message);
        this.logger.error(
          `Evaluation failed for zone "${zone.slug}": ${message}`,
        );
      }
    }

    this.forgetFailuresOfRemovedZones(zones);
    if (this.hardware.isLeader) this.publishCycle(evaluations);
    await this.publishStatus(evaluations);
    return evaluations;
  }

  private forgetFailuresOfRemovedZones(zones: ZoneEntity[]): void {
    const existingSlugs = new Set(zones.map((zone) => zone.slug));
    for (const slug of [...this.failingZoneReasons.keys()]) {
      if (!existingSlugs.has(slug)) this.failingZoneReasons.delete(slug);
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
    if (!this.latestRulesCycle) return;
    this.latestRulesCycle = null;
    this.realtime.forgetRulesCycle();
  }

  /**
   * One status per cycle rather than per zone: the banner it drives is a
   * property of the installation, and `staleRoles` is the union across zones
   * because a quiet sensor anywhere is worth surfacing everywhere.
   */
  private async publishStatus(evaluations: RulesEvaluation[]): Promise<void> {
    const staleRoles = [...new Set(evaluations.flatMap((e) => e.staleRoles))];
    const counts = await this.nodes.counts();
    const latest = evaluations
      .map((e) => e.evaluatedAt)
      .sort()
      .at(-1);

    this.realtime.publishSystemStatus({
      at: this.clock.now().toISOString(),
      sensorStale: staleRoles.length > 0,
      staleRoles,
      nodesOnline: counts.online,
      nodesTotal: counts.total,
      lastEvaluationAt: latest ?? null,
    });
  }

  async evaluateZone(zone: ZoneEntity): Promise<RulesEvaluation> {
    const now = this.clock.now();
    const parsed = parseZoneRulesConfig(zone.rulesConfig);
    if (parsed.ok === false) {
      // Nothing is dispatched for a zone whose config does not parse - not even
      // the roles that look fine. Half-evaluating a zone hides that the other
      // half is uncontrolled.
      throw new Error(`invalid rules_config: ${parsed.errors.join('; ')}`);
    }
    const config = parsed.config;

    const samples = await this.latestSamplesForZone(zone.id);
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

    for (const role of staleRoles) {
      if (config.enabledRoles.includes(role)) {
        // ERROR, and the dashboard raises a persistent banner. "Hold last
        // state" is only a sound policy if the alarm is impossible to miss.
        this.logger.error(
          `Sensors for "${role}" in zone "${zone.slug}" are STALE - holding last state`,
        );
      }
    }

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

  /** Zones whose latest evaluation threw, by slug, with the reason. */
  failingZones(): ReadonlyMap<string, string> {
    return this.failingZoneReasons;
  }

  latestCycle(): RulesCycle | null {
    return this.latestRulesCycle;
  }

  /** One per zone, newest first. Empty until the first tick has run. */
  lastEvaluation(): RulesEvaluation[] {
    return [...this.lastEvaluations.values()].sort((a, b) =>
      b.evaluatedAt.localeCompare(a.evaluatedAt),
    );
  }

  /**
   * The latest reading per sensor on every admitted node in the zone.
   *
   * Per SENSOR, not per node: the pumphouse node carries a probe per pipe, and
   * `DISTINCT ON (node_id)` alone handed the engine whichever probe spoke last,
   * so a frozen pipe could be hidden behind a warm one on the same node.
   *
   * `DISTINCT ON` rather than a query per sensor: this runs every 10 s forever
   * on an SD card, so it stays one query however many sensors exist. A `pending` node is excluded here as well as at ingest - belt and
   * braces on the path that can start a burner.
   */
  private async latestSamplesForZone(zoneId: string): Promise<NodeSample[]> {
    const rows = await this.readings
      .createQueryBuilder('r')
      .innerJoin('r.node', 'n')
      .select('n.slug', 'slug')
      .addSelect('r.sensorId', 'sensorId')
      .addSelect('r.temperature', 'temperature')
      .addSelect('r.co2', 'co2')
      .addSelect('r.createdAt', 'observedAt')
      .distinctOn(['r.nodeId', 'r.sensorId'])
      .where('n.zoneId = :zoneId', { zoneId })
      .andWhere('n.status = :status', { status: NodeStatus.Admitted })
      .orderBy('r.nodeId')
      .addOrderBy('r.sensorId')
      .addOrderBy('r.createdAt', 'DESC')
      .getRawMany<{
        slug: string;
        sensorId: string;
        temperature: number;
        co2: number | null;
        observedAt: Date | string;
      }>();

    return rows.map((row) => ({
      nodeId: row.slug,
      sensorId: row.sensorId,
      temperatureC: Number(row.temperature),
      co2Ppm: row.co2 === null ? null : Number(row.co2),
      observedAt: new Date(row.observedAt),
    }));
  }

  /**
   * A decision is not an action. Several devices can share a `(zone, role)`,
   * each with its own `rulesEnabled` and its own cooldown, so the outcomes for
   * one decision may legitimately differ device by device.
   */
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
        // A manual override. The REST API still drives it; automation does not.
        dispatched.push(this.record(device, 'rules-disabled'));
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
      return this.record(device, 'applied');
    } catch (err: unknown) {
      const body = err instanceof HttpException ? err.getResponse() : null;
      const code =
        body && typeof body === 'object' && 'code' in body
          ? (body as { code: ApiErrorCode }).code
          : null;

      switch (code) {
        // Expected and uninteresting: the device is already where the rule
        // wants it. At 8,640 evaluations a day this is the common case.
        case ApiErrorCode.DeviceAlreadyOn:
        case ApiErrorCode.DeviceAlreadyOff:
          return this.record(device, 'already-in-state');

        // Also expected: the anti-short-cycle interlock doing its job. Swallowed
        // at debug so it cannot bury a real failure, and the next tick retries.
        case ApiErrorCode.DeviceCooldown: {
          const detail = detailOf(body, 'canTurnOnAt');
          this.logger.debug(
            `${device.name} in cooldown until ${detail ?? 'unknown'}`,
          );
          return this.record(device, 'cooldown', detail);
        }

        default: {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `${device.name} failed to go ${desired}: ${code ?? message}`,
          );
          return this.record(device, 'failed', code ?? message);
        }
      }
    }
  }

  private record(
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

  /**
   * Log only on CHANGE. At 8,640 evaluations a day times N devices, a line per
   * evaluation buries everything that matters and fills the SD card - which is
   * how the old system produced a 5.4 GB log.
   */
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

    const at = temperatureC === undefined ? '' : ` at ${temperatureC} °C`;
    const line = `${zone.slug}/${decision.role}: ${decision.desired} (${decision.reason})${at}`;

    // Both no-op flavours are first-class outcomes, not problems, and they are
    // the ones that repeat forever - so they stay at debug even on change.
    if (
      decision.reason === 'role-not-owned' ||
      decision.reason === 'no-sensor'
    ) {
      this.logger.debug(line);
      return;
    }
    this.logger.log(line);
  }

  private logOwnership(zone: ZoneEntity, roles: readonly DeviceRole[]): void {
    const signature = [...roles].sort().join(',');
    if (this.lastOwnership.get(zone.id) === signature) {
      return;
    }
    const previous = this.lastOwnership.get(zone.id);
    this.lastOwnership.set(zone.id, signature);
    this.logger.warn(
      `Zone "${zone.slug}" now controls [${signature || 'nothing'}]` +
        (previous === undefined ? '' : ` (was [${previous || 'nothing'}])`),
    );
  }
}

function detailOf(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object' || !('details' in body)) {
    return undefined;
  }
  const details = (body as { details?: Record<string, unknown> }).details;
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}
