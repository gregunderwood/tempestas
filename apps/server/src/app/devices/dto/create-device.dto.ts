import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  DeviceRole,
  type CreateDevicePayload,
  type GpioLevel,
  type NodeId,
} from '@tempestas/domain';

/**
 * The DTO class lives here, not in @tempestas/domain, and `implements` the
 * shared interface. That keeps class-validator and reflect-metadata out of the
 * browser bundle while still failing compilation if the two sides disagree.
 */
export class CreateDeviceDto implements CreateDevicePayload {
  @IsString()
  nodeId!: NodeId;

  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsInt()
  @Min(0)
  @Max(63)
  gpio!: number;

  @IsInt()
  @Min(0)
  onDelayDuration!: number;

  @IsIn([0, 1])
  onLevel!: GpioLevel;

  @IsOptional()
  @IsBoolean()
  rulesEnabled?: boolean;

  @IsOptional()
  @IsEnum(DeviceRole)
  role?: DeviceRole | null;
}
