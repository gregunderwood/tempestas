import { execFileSync } from 'node:child_process';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../common/clock';
import { describeError } from '../common/describe-error';
import { ZoneEntity } from '../zones/models';
import {
  describeTimezoneDisagreement,
  findTimezoneDisagreements,
  toColonOffset,
  type ReadSystemOffset,
  type TimezoneDisagreement,
} from './timezone-agreement';

export const SYSTEM_OFFSET_READER = Symbol('SYSTEM_OFFSET_READER');

export function readSystemOffsetFromDate(timezone: string): string | null {
  try {
    const compactOffset = execFileSync('date', ['+%z'], {
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8',
    });
    return toColonOffset(compactOffset);
  } catch {
    return null;
  }
}

@Injectable()
export class TimezoneCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TimezoneCheckService.name);
  private disagreements: TimezoneDisagreement[] = [];

  constructor(
    @InjectRepository(ZoneEntity)
    private readonly zones: Repository<ZoneEntity>,
    private readonly clock: Clock,
    @Inject(SYSTEM_OFFSET_READER)
    private readonly readSystemOffset: ReadSystemOffset,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.check();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async check(): Promise<void> {
    try {
      const timezones = await this.findZoneTimezones();
      this.disagreements = findTimezoneDisagreements(
        timezones,
        this.clock.now(),
        this.readSystemOffset,
      );
    } catch (error) {
      this.logger.warn(`Timezone check skipped: ${describeError(error)}`);
      return;
    }
    for (const disagreement of this.disagreements) {
      this.logger.error(
        `${describeTimezoneDisagreement(disagreement)}. Local-time rules follow Node, so update Node.`,
      );
    }
  }

  findDisagreements(): readonly TimezoneDisagreement[] {
    return this.disagreements;
  }

  private async findZoneTimezones(): Promise<string[]> {
    const zones = await this.zones.find();
    return zones.map((zone) => zone.rulesConfig.timezone);
  }
}
