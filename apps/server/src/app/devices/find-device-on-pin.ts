import type { Repository } from 'typeorm';
import type { NodeId } from '@tempestas/domain';
import type { DeviceEntity } from './models';

export function findDeviceOnPin(
  devices: Repository<DeviceEntity>,
  nodeId: NodeId,
  pin: number,
): Promise<DeviceEntity | null> {
  return devices.findOne({
    where: { gpio: pin, node: { slug: nodeId } },
    relations: { node: true },
  });
}
