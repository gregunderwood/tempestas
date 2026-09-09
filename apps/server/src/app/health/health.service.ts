import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { HealthReport } from '@tempestas/domain';
import { Clock } from '../common/clock';
import { NodesService } from '../nodes/nodes.service';
import { SensorReadingEntity } from '../readings/models';
import { RulesService } from '../rules/rules.service';

/**
 * "Up" is not the question. A process that answers HTTP while no reading has
 * arrived in an hour, or while the rules engine has stopped evaluating, is a
 * greenhouse running open-loop - so those two are part of the verdict, not
 * extra detail underneath it.
 */
export const READINGS_STALE_AFTER_SECONDS = 120;
export const EVALUATION_STALE_AFTER_SECONDS = 60;

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    private readonly nodes: NodesService,
    private readonly rules: RulesService,
    private readonly clock: Clock,
  ) {}

  async check(): Promise<HealthReport> {
    const now = this.clock.now();
    const problems: string[] = [];

    let db = false;
    try {
      await this.dataSource.query('select 1');
      db = true;
    } catch {
      problems.push('database unreachable');
    }

    // Everything below needs the database, so on a failed probe report what is
    // knowable rather than a 500 - the caller is trying to find out what broke.
    if (!db) {
      return {
        status: 'degraded',
        db,
        uptimeSeconds: Math.round(process.uptime()),
        nodes: { total: 0, online: 0, pending: 0 },
        readings: { latestAt: null, ageSeconds: null },
        rules: { lastEvaluationAt: null, ageSeconds: null, staleRoles: [] },
        problems,
      };
    }

    const counts = await this.nodes.counts();
    const latestReading = await this.readings
      .createQueryBuilder('r')
      .select('MAX(r.createdAt)', 'latest')
      .getRawOne<{ latest: Date | string | null }>();

    const latestAt = latestReading?.latest
      ? new Date(latestReading.latest)
      : null;
    const readingAge = latestAt ? ageSeconds(latestAt, now) : null;
    if (readingAge === null) {
      problems.push('no readings have ever been persisted');
    } else if (readingAge > READINGS_STALE_AFTER_SECONDS) {
      problems.push(`newest reading is ${readingAge}s old`);
    }

    const evaluations = this.rules.lastEvaluation();
    const evaluatedAt = evaluations[0]
      ? new Date(evaluations[0].evaluatedAt)
      : null;
    const evaluationAge = evaluatedAt ? ageSeconds(evaluatedAt, now) : null;
    if (evaluationAge === null) {
      problems.push('the rules engine has not evaluated yet');
    } else if (evaluationAge > EVALUATION_STALE_AFTER_SECONDS) {
      problems.push(`last rules evaluation was ${evaluationAge}s ago`);
    }

    const staleRoles = [...new Set(evaluations.flatMap((e) => e.staleRoles))];
    if (staleRoles.length > 0) {
      problems.push(`stale sensors for: ${staleRoles.join(', ')}`);
    }
    if (counts.pending > 0) {
      // Not degraded: a pending node is the admission gate working. But it is
      // the thing somebody curling this endpoint most often needs told.
      problems.push(`${counts.pending} node(s) awaiting admission`);
    }

    // A pending node alone is not degradation, so it is excluded from the verdict.
    const degrading = problems.filter((p) => !p.includes('awaiting admission'));

    return {
      status: degrading.length === 0 ? 'ok' : 'degraded',
      db,
      uptimeSeconds: Math.round(process.uptime()),
      nodes: counts,
      readings: {
        latestAt: latestAt?.toISOString() ?? null,
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
}

function ageSeconds(instant: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - instant.getTime()) / 1000));
}
