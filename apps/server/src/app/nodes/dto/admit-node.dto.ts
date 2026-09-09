import { IsOptional, IsString, IsUUID } from 'class-validator';
import type { AdmitNodePayload } from '@tempestas/domain';

/**
 * Admitting a node is also the moment it gets a zone, because a node with no
 * zone has nowhere to put its devices and no rules_config to be evaluated
 * against. `@IsOptional()` skips null as well as undefined, which is how
 * `location: null` clears a value.
 */
export class AdmitNodeDto implements AdmitNodePayload {
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  location?: string | null;
}
