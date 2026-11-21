import type { AdmitNodePayload } from '@tempestas/domain';
import { NodeOperatorFieldsDto } from './node-operator-fields.dto';

export class AdmitNodeDto
  extends NodeOperatorFieldsDto
  implements AdmitNodePayload {}
