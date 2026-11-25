import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { NODE_HEALTH_MAX_DAYS, type NodeHealthQuery } from '@tempestas/domain';

export class NodeHealthQueryDto implements NodeHealthQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NODE_HEALTH_MAX_DAYS)
  days?: number;
}
