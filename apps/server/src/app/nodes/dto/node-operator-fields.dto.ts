import { IsOptional, IsString, IsUUID } from 'class-validator';

// No slug (the MQTT topic segment) and no status (it moves only through admit and disable).
export abstract class NodeOperatorFieldsDto {
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  // `@IsOptional()` skips null as well as undefined, which is how `location: null` clears it.
  @IsOptional()
  @IsString()
  location?: string | null;
}
