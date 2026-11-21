import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../common/clock';
import { MILLISECONDS_PER_DAY } from '../common/time-units';
import { SensorReadingEntity } from './models';

// Small on purpose: each statement's write lock stays short on the SD card.
export const RETENTION_BATCH_SIZE = 5_000;

// A safety valve, not a limit: 200 batches is a million rows in one night.
const MAX_BATCHES_PER_RUN = 200;

const DEFAULT_RETENTION_DAYS = 90;

// The subquery bounds how many rows one statement can touch, which a plain DELETE WHERE cannot.
const DELETE_BATCH_OLDER_THAN = `DELETE FROM sensor_readings
          WHERE id IN (
            SELECT id FROM sensor_readings WHERE created_at < $1 LIMIT $2
          )`;

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  // 03:00 local: after the coldest part of the night, well before sunrise.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneNightly(): Promise<void> {
    const deleted = await this.prune();
    if (deleted > 0) {
      this.logger.log(`Retention removed ${deleted} readings`);
    }
  }

  async prune(): Promise<number> {
    const days = this.readRetentionDays();
    if (!isUsableRetention(days)) {
      this.logger.error(`Refusing to prune: RETENTION_DAYS is "${days}"`);
      return 0;
    }

    const horizon = new Date(
      this.clock.now().getTime() - days * MILLISECONDS_PER_DAY,
    );
    let total = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const deleted = await this.deleteBatchOlderThan(horizon);
      total += deleted;
      if (deleted < RETENTION_BATCH_SIZE) {
        return total;
      }
    }

    this.logger.warn(
      `Retention hit its ${MAX_BATCHES_PER_RUN}-batch ceiling after ${total} rows; ` +
        `more remain and will go in the next run`,
    );
    return total;
  }

  private readRetentionDays(): number {
    return Number(
      this.config.get<string | number>(
        'RETENTION_DAYS',
        DEFAULT_RETENTION_DAYS,
      ),
    );
  }

  private async deleteBatchOlderThan(horizon: Date): Promise<number> {
    const result = await this.readings.query(DELETE_BATCH_OLDER_THAN, [
      horizon,
      RETENTION_BATCH_SIZE,
    ]);
    return countAffectedRows(result);
  }
}

// A bad value here deletes history, so anything doubtful is refused rather than guessed.
function isUsableRetention(days: number): boolean {
  return Number.isFinite(days) && days >= 1;
}

// `query()` returns [rows, affected] for a DELETE through the pg driver.
function countAffectedRows(result: unknown): number {
  if (Array.isArray(result) && typeof result[1] === 'number') {
    return result[1];
  }
  return 0;
}
