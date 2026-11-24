import { DeviceEntity, PinTransitionEntity } from './devices/models';
import { NodeEntity, NodeUpdateEntity } from './nodes/models';
import { SensorReadingEntity } from './readings/models';
import { ZoneEntity } from './zones/models';

// Listed rather than globbed: a webpack bundle has no directory to scan.
export const ENTITIES = [
  ZoneEntity,
  NodeEntity,
  NodeUpdateEntity,
  DeviceEntity,
  PinTransitionEntity,
  SensorReadingEntity,
];
