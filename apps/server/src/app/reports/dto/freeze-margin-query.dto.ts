import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  FREEZE_MARGIN_MAX_NIGHTS,
  type FreezeMarginQuery,
} from '@tempestas/domain';

export class FreezeMarginQueryDto implements FreezeMarginQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FREEZE_MARGIN_MAX_NIGHTS)
  nights?: number;
}
