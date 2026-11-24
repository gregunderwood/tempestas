import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
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
  MAX_INPUT_BTU_PER_HOUR,
} from '@tempestas/domain';
import { GPIO_LEVELS, MAX_GPIO_PIN, MIN_GPIO_PIN } from './gpio-constraints';

// Kept out of @tempestas/domain so class-validator stays out of the browser bundle.
export class CreateDeviceDto implements CreateDevicePayload {
  @IsString()
  nodeId!: NodeId;

  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsInt()
  @Min(MIN_GPIO_PIN)
  @Max(MAX_GPIO_PIN)
  gpio!: number;

  @IsInt()
  @Min(0)
  onDelayDuration!: number;

  @IsIn(GPIO_LEVELS)
  onLevel!: GpioLevel;

  @IsOptional()
  @IsBoolean()
  rulesEnabled?: boolean;

  @IsOptional()
  @IsEnum(DeviceRole)
  role?: DeviceRole | null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(MAX_INPUT_BTU_PER_HOUR)
  inputBtuPerHour?: number | null;
}
