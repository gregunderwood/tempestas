import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  TIME_IN_RANGE_MAX_DAYS,
  type TimeInRangeQuery,
} from '@tempestas/domain';

export class TimeInRangeQueryDto implements TimeInRangeQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TIME_IN_RANGE_MAX_DAYS)
  days?: number;
}
