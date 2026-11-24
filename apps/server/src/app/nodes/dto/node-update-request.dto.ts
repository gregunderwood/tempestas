import { IsNotEmpty, IsString } from 'class-validator';
import type { NodeUpdateRequest } from '@tempestas/domain';

export class NodeUpdateRequestDto implements NodeUpdateRequest {
  @IsString()
  @IsNotEmpty()
  version!: string;
}
