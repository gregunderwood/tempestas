import { Controller, Get, Query } from '@nestjs/common';
import type { DayNightStats, Reading, ReadingStats } from '@tempestas/domain';
import { ReadingsService } from './readings.service';
import { ReadingsQueryDto, StatsQueryDto } from './dto/readings-query.dto';

@Controller('readings')
export class ReadingsController {
  constructor(private readonly readings: ReadingsService) {}

  /**
   * Newest first, inside a resolved window and a row limit. Both windows and
   * limits are always applied - see `reading-window.ts` for what the defaults
   * resolve to and why they are not the old system's.
   */
  @Get()
  findAll(@Query() query: ReadingsQueryDto): Promise<Reading[]> {
    return this.readings.findAll(query);
  }

  /** One reading per sensor. Cheap, unwindowed, and what a dashboard opens with. */
  @Get('latest')
  findLatest(): Promise<Reading[]> {
    return this.readings.findLatestPerSensor();
  }

  @Get('stats')
  stats(@Query() query: StatsQueryDto): Promise<ReadingStats> {
    return this.readings.stats(query);
  }

  /**
   * The same window split at the zone's daylight boundary.
   *
   * Separate from `stats` rather than a flag on it, so the response shape does
   * not change with a query parameter and a caller cannot be handed a body it
   * did not expect.
   */
  @Get('stats/day-night')
  dayNightStats(@Query() query: StatsQueryDto): Promise<DayNightStats> {
    return this.readings.dayNightStats(query);
  }
}
