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
  type GpioLevel,
  type PatchDeviceRulesPayload,
  type UpdateDevicePayload,
} from '@tempestas/domain';
import { GPIO_LEVELS, MAX_GPIO_PIN, MIN_GPIO_PIN } from './gpio-constraints';

// Written out rather than derived, to avoid pulling in @nestjs/mapped-types.
export class UpdateDeviceDto implements UpdateDevicePayload {
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional()
  @IsInt()
  @Min(MIN_GPIO_PIN)
  @Max(MAX_GPIO_PIN)
  gpio?: number;
  @IsOptional() @IsInt() @Min(0) onDelayDuration?: number;
  @IsOptional() @IsIn(GPIO_LEVELS) onLevel?: GpioLevel;
  @IsOptional() @IsBoolean() rulesEnabled?: boolean;
  @IsOptional() @IsEnum(DeviceRole) role?: DeviceRole | null;
}

export class PatchDeviceRulesDto implements PatchDeviceRulesPayload {
  @IsBoolean()
  rulesEnabled!: boolean;
}
