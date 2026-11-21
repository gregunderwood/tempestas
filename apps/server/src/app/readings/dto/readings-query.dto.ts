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

/** Query strings arrive as strings; `@Type` is what makes `days=7` a number. */
export class ReadingsQueryDto implements ReadingsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  /** The node SLUG, as everywhere on the wire. */
  @ValidateIf(isNodeIdNeeded)
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

  /**
   * Bounded, and low by default. An unbounded list over 90 days of retention is
   * three quarters of a million rows through a Pi on WiFi; the dashboard wants
   * `/stats` for a window, not the window itself.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}

function isNodeIdNeeded(query: ReadingsQueryDto): boolean {
  return query.nodeId !== undefined || query.sensorId !== undefined;
}

export class StatsQueryDto extends ReadingsQueryDto implements StatsQuery {}
