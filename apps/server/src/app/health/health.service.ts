import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  NodeStatus,
  sensorKey,
  type HealthReport,
  type RulesEvaluation,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { DivergenceLog } from '../common/divergence-log';
import { MILLISECONDS_PER_SECOND, SECONDS_PER_DAY } from '../common/time-units';
import { NodesService } from '../nodes/nodes.service';
import { SensorReadingEntity } from '../readings/models';
import { RulesService } from '../rules/rules.service';
import { collectStaleRoles } from '../rules/stale-roles';

// "Up" is not the question: no fresh readings, or no fresh evaluation, is a greenhouse running open-loop.
export const READINGS_STALE_AFTER_SECONDS = 120;
export const EVALUATION_STALE_AFTER_SECONDS = 60;

// A day, so an overnight failsafe is still reported in the morning and then clears on its own.
const DIVERGENCE_WINDOW_SECONDS = SECONDS_PER_DAY;

// A day, so a probe removed on purpose stops being named while one that died overnight still is.
const SENSOR_MEMORY_SECONDS = SECONDS_PER_DAY;

// A pending node is the admission gate working, so it is told but does not degrade the verdict.
const AWAITING_ADMISSION = 'awaiting admission';

interface QuietSensor {
  key: string;
  ageSeconds: number;
}

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    private readonly nodes: NodesService,
    private readonly rules: RulesService,
    private readonly clock: Clock,
    private readonly divergences: DivergenceLog,
  ) {}

  async check(): Promise<HealthReport> {
    const now = this.clock.now();

    // Without the database, report what is knowable rather than a 500.
    if (!(await this.isDatabaseReachable())) {
      return unreachableDatabaseReport();
    }

    const problems: string[] = [];
    const counts = await this.nodes.counts();

    const latestReadingAt = await this.findLatestReadingAt();
    const readingAge = latestReadingAt
      ? ageSeconds(latestReadingAt, now)
      : null;
    problems.push(...describeReadingAge(readingAge));

    for (const sensor of await this.findQuietSensors(now)) {
      problems.push(
        `sensor ${sensor.key} has not reported for ${sensor.ageSeconds}s`,
      );
    }

    const evaluations = this.rules.findLastEvaluations();
    const evaluatedAt = newestEvaluatedAt(evaluations);
    const evaluationAge = evaluatedAt ? ageSeconds(evaluatedAt, now) : null;
    problems.push(...describeEvaluationAge(evaluationAge));

    for (const [slug, reason] of this.rules.findFailingZones()) {
      problems.push(`zone "${slug}" is not being evaluated: ${reason}`);
    }

    const staleRoles = collectStaleRoles(evaluations);
    if (staleRoles.length > 0) {
      problems.push(`stale sensors for: ${staleRoles.join(', ')}`);
    }
    if (counts.pending > 0) {
      problems.push(`${counts.pending} node(s) ${AWAITING_ADMISSION}`);
    }

    problems.push(...this.describeRecentDivergences(now));

    return {
      status: problems.some(isDegrading) ? 'degraded' : 'ok',
      db: true,
      uptimeSeconds: Math.round(process.uptime()),
      nodes: counts,
      readings: {
        latestAt: latestReadingAt?.toISOString() ?? null,
        ageSeconds: readingAge,
      },
      rules: {
        lastEvaluationAt: evaluatedAt?.toISOString() ?? null,
        ageSeconds: evaluationAge,
        staleRoles,
      },
      problems,
    };
  }

  private async isDatabaseReachable(): Promise<boolean> {
    try {
      await this.dataSource.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  private async findLatestReadingAt(): Promise<Date | null> {
    const latestReading = await this.readings
      .createQueryBuilder('reading')
      .select('MAX(reading.createdAt)', 'latest')
      .getRawOne<{ latest: Date | string | null }>();
    return latestReading?.latest ? new Date(latestReading.latest) : null;
  }

  // A probe dying beside a working one is invisible elsewhere: `min` simply carries on without it.
  private async findQuietSensors(now: Date): Promise<QuietSensor[]> {
    const rows = await this.readings
      .createQueryBuilder('reading')
      .innerJoin('reading.node', 'node')
      .select('node.slug', 'slug')
      .addSelect('reading.sensorId', 'sensorId')
      .addSelect('MAX(reading.createdAt)', 'latest')
      .where('reading.createdAt > :since', {
        since: secondsBefore(now, SENSOR_MEMORY_SECONDS),
      })
      .andWhere('node.status = :status', { status: NodeStatus.Admitted })
      .groupBy('node.slug')
      .addGroupBy('reading.sensorId')
      .getRawMany<{ slug: string; sensorId: string; latest: Date | string }>();

    return rows
      .map((row) => ({
        key: sensorKey({ nodeId: row.slug, sensorId: row.sensorId }),
        ageSeconds: ageSeconds(new Date(row.latest), now),
      }))
      .filter((sensor) => sensor.ageSeconds > READINGS_STALE_AFTER_SECONDS)
      .sort((first, second) => first.key.localeCompare(second.key));
  }

  // Bounded because this log does not survive a restart; the journal's ERROR lines are the durable record.
  private describeRecentDivergences(now: Date): string[] {
    const recent = this.divergences.since(
      secondsBefore(now, DIVERGENCE_WINDOW_SECONDS),
    );
    if (recent.length === 0) {
      return [];
    }
    const deviceNames = [
      ...new Set(recent.map((divergence) => divergence.deviceName)),
    ];
    return [
      `hardware/database divergence corrected for: ${deviceNames.join(', ')}`,
    ];
  }
}

function unreachableDatabaseReport(): HealthReport {
  return {
    status: 'degraded',
    db: false,
    uptimeSeconds: Math.round(process.uptime()),
    nodes: { total: 0, online: 0, pending: 0 },
    readings: { latestAt: null, ageSeconds: null },
    rules: { lastEvaluationAt: null, ageSeconds: null, staleRoles: [] },
    problems: ['database unreachable'],
  };
}

function describeReadingAge(readingAge: number | null): string[] {
  if (readingAge === null) {
    return ['no readings have ever been persisted'];
  }
  if (readingAge > READINGS_STALE_AFTER_SECONDS) {
    return [`newest reading is ${readingAge}s old`];
  }
  return [];
}

function describeEvaluationAge(evaluationAge: number | null): string[] {
  if (evaluationAge === null) {
    return ['the rules engine has not evaluated yet'];
  }
  if (evaluationAge > EVALUATION_STALE_AFTER_SECONDS) {
    return [`last rules evaluation was ${evaluationAge}s ago`];
  }
  return [];
}

function newestEvaluatedAt(evaluations: RulesEvaluation[]): Date | null {
  return evaluations[0] ? new Date(evaluations[0].evaluatedAt) : null;
}

function isDegrading(problem: string): boolean {
  return !problem.includes(AWAITING_ADMISSION);
}

function secondsBefore(now: Date, seconds: number): Date {
  return new Date(now.getTime() - seconds * MILLISECONDS_PER_SECOND);
}

function ageSeconds(instant: Date, now: Date): number {
  return Math.max(
    0,
    Math.round((now.getTime() - instant.getTime()) / MILLISECONDS_PER_SECOND),
  );
}
