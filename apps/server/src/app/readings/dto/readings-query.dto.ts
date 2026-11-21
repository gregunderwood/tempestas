import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ReadingOrder,
  type ReadingsQuery,
  type StatsQuery,
} from '@tempestas/domain';

const MAX_WINDOW_DAYS = 365;
const MAX_ROWS_PER_PAGE = 5000;

// Query strings arrive as strings; `@Type` is what makes `days=7` a number.
export class ReadingsQueryDto implements ReadingsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WINDOW_DAYS)
  days?: number;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  // The node slug, as everywhere on the wire.
  @ValidateIf(isNodeOrSensorNamed)
  @IsDefined({
    message:
      'nodeId is required with sensorId: a sensor id is unique only on its node',
  })
  @IsString()
  nodeId?: string;

  @IsOptional()
  @IsString()
  sensorId?: string;

  @IsOptional()
  @IsEnum(ReadingOrder)
  order?: ReadingOrder;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ROWS_PER_PAGE)
  limit?: number;
}

function isNodeOrSensorNamed(query: ReadingsQueryDto): boolean {
  return query.nodeId !== undefined || query.sensorId !== undefined;
}

export class StatsQueryDto extends ReadingsQueryDto implements StatsQuery {}
