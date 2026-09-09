import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../common/clock';
import { SensorReadingEntity } from './models';

/** Rows per statement. Small on purpose - see the note on locking below. */
export const RETENTION_BATCH_SIZE = 5_000;

/** A safety valve, not a limit: 200 batches is a million rows in one night. */
const MAX_BATCHES_PER_RUN = 200;

/**
 * Deletes readings past the retention horizon, in batches.
 *
 * Two failures from the old system are being fixed here at once. The retention
 * command existed but was never scheduled, so nothing ever ran; and it deleted
 * in a single unbounded statement, which on millions of rows holds a write lock
 * and saturates an SD card's write bandwidth for minutes - on the same card the
 * burner controller depends on.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectRepository(SensorReadingEntity)
    private readonly readings: Repository<SensorReadingEntity>,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  /** 03:00 local: after the coldest part of the night, well before sunrise. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async scheduled(): Promise<void> {
    const deleted = await this.prune();
    if (deleted > 0) {
      this.logger.log(`Retention removed ${deleted} readings`);
    }
  }

  /** Returns the number of rows deleted. Exposed so it can be driven in a test. */
  async prune(): Promise<number> {
    const days = Number(this.config.get<string | number>('RETENTION_DAYS', 90));
    if (!Number.isFinite(days) || days < 1) {
      // Refuse rather than guess: a bad value here deletes history.
      this.logger.error(`Refusing to prune: RETENTION_DAYS is "${days}"`);
      return 0;
    }

    const horizon = new Date(
      this.clock.now().getTime() - days * 24 * 60 * 60 * 1000,
    );
    let total = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      // DELETE ... WHERE id IN (SELECT ... LIMIT n) rather than a plain
      // `DELETE WHERE created_at < x`: the subquery bounds how many rows one
      // statement can touch, so each lock is short and the card gets to
      // breathe between batches.
      const result = await this.readings.query(
        `DELETE FROM sensor_readings
          WHERE id IN (
            SELECT id FROM sensor_readings WHERE created_at < $1 LIMIT $2
          )`,
        [horizon, RETENTION_BATCH_SIZE],
      );
      const deleted = rowCount(result);
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
}

/** `query()` returns [rows, affected] for a DELETE through the pg driver. */
function rowCount(result: unknown): number {
  if (Array.isArray(result) && typeof result[1] === 'number') {
    return result[1];
  }
  return 0;
}
