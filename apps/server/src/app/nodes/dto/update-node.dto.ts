import { IsOptional, IsString, IsUUID } from 'class-validator';
import type { UpdateNodePayload } from '@tempestas/domain';

/**
 * The human-owned fields only. `slug` is absent by design: it is the MQTT topic
 * segment and the broker ACL subject, so renaming it would orphan the node's
 * whole topic subtree. `status` is absent too - it moves through admit/disable,
 * which log, rather than through a generic PUT that does not.
 */
export class UpdateNodeDto implements UpdateNodePayload {
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
