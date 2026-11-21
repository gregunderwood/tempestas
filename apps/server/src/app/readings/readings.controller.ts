import { Controller, Get, Query } from '@nestjs/common';
import type { DayNightStats, Reading, ReadingStats } from '@tempestas/domain';
import { ReadingsService } from './readings.service';
import { ReadingsQueryDto, StatsQueryDto } from './dto/readings-query.dto';

@Controller('readings')
export class ReadingsController {
  constructor(private readonly readings: ReadingsService) {}

  @Get()
  findAll(@Query() query: ReadingsQueryDto): Promise<Reading[]> {
    return this.readings.findAll(query);
  }

  @Get('latest')
  findLatest(): Promise<Reading[]> {
    return this.readings.findLatestPerSensor();
  }

  @Get('stats')
  findStats(@Query() query: StatsQueryDto): Promise<ReadingStats> {
    return this.readings.computeStats(query);
  }

  // A route of its own, not a flag on `stats`, so no query parameter changes the response shape.
  @Get('stats/day-night')
  findDayNightStats(@Query() query: StatsQueryDto): Promise<DayNightStats> {
    return this.readings.computeDayNightStats(query);
  }
}
