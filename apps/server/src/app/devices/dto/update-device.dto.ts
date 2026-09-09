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

/** Written out rather than derived, to avoid pulling in @nestjs/mapped-types. */
export class UpdateDeviceDto implements UpdateDevicePayload {
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(63) gpio?: number;
  @IsOptional() @IsInt() @Min(0) onDelayDuration?: number;
  @IsOptional() @IsIn([0, 1]) onLevel?: GpioLevel;
  @IsOptional() @IsBoolean() rulesEnabled?: boolean;
  @IsOptional() @IsEnum(DeviceRole) role?: DeviceRole | null;
}

export class PatchDeviceRulesDto implements PatchDeviceRulesPayload {
  @IsBoolean()
  rulesEnabled!: boolean;
}
