import type { UpdateNodePayload } from '@tempestas/domain';
import { NodeOperatorFieldsDto } from './node-operator-fields.dto';

export class UpdateNodeDto
  extends NodeOperatorFieldsDto
  implements UpdateNodePayload {}
