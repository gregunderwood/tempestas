import { Controller, Get, Query } from '@nestjs/common';
import type { Reading, ReadingStats } from '@tempestas/domain';
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

  /** One reading per node. Cheap, unwindowed, and what a dashboard opens with. */
  @Get('latest')
  findLatest(): Promise<Reading[]> {
    return this.readings.findLatestPerNode();
  }

  @Get('stats')
  stats(@Query() query: StatsQueryDto): Promise<ReadingStats> {
    return this.readings.stats(query);
  }
}
