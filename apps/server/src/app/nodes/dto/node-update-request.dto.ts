import { IsString, Matches } from 'class-validator';
import {
  RELEASED_AGENT_VERSION,
  type NodeUpdateRequest,
} from '@tempestas/domain';

export class NodeUpdateRequestDto implements NodeUpdateRequest {
  @IsString()
  @Matches(RELEASED_AGENT_VERSION, {
    message: 'version must be a released agent version, such as 1.1.1',
  })
  version!: string;
}
