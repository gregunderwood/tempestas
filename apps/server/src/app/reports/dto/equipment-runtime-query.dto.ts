import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  EQUIPMENT_RUNTIME_MAX_DAYS,
  type EquipmentRuntimeQuery,
} from '@tempestas/domain';

export class EquipmentRuntimeQueryDto implements EquipmentRuntimeQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EQUIPMENT_RUNTIME_MAX_DAYS)
  days?: number;
}
