import type { Repository } from 'typeorm';
import { DeviceRole, type Node } from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import type { DeviceEntity, PinTransitionEntity } from '../devices/models';
import type { NodesService } from '../nodes/nodes.service';
import type { ReadingsService } from '../readings/readings.service';
import type { ZoneEntity } from '../zones/models';
import { ZoneHistoryService } from './zone-history.service';

const NOW = new Date('2026-11-23T12:00:00Z');
const HEATER_ID = 'heater-device';

function makeService(bucketWindows: { from: Date; to: Date }[] = []) {
  const zones = {
    find: async () => [{ id: 'pumphouse-zone' }],
  } as unknown as Repository<ZoneEntity>;
  const devices = {
    find: async () => [
      {
        id: HEATER_ID,
        name: 'Heater',
        role: DeviceRole.Heater,
        zoneId: 'pumphouse-zone',
        node: { slug: 'patji' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ],
  } as unknown as Repository<DeviceEntity>;
  const inForceQuery = {
    distinctOn: () => inForceQuery,
    where: () => inForceQuery,
    orderBy: () => inForceQuery,
    addOrderBy: () => inForceQuery,
    getMany: async () => [
      {
        nodeId: 'patji',
        pin: 17,
        energised: true,
        deviceId: HEATER_ID,
        observedAt: new Date('2026-11-20T00:00:00Z'),
        reason: 'level-changed',
      },
    ],
  };
  const transitions = {
    createQueryBuilder: () => inForceQuery,
    find: async () => [
      {
        nodeId: 'patji',
        pin: 17,
        energised: null,
        deviceId: HEATER_ID,
        observedAt: new Date('2026-11-23T06:00:00Z'),
        reason: 'node-offline',
      },
    ],
  } as unknown as Repository<PinTransitionEntity>;
  const nodes = {
    findAll: async (): Promise<Partial<Node>[]> => [
      {
        slug: 'patji',
        zoneId: 'pumphouse-zone',
        online: false,
        lastSeenAt: '2026-11-23T06:00:00Z',
        latestReadingAt: null,
      },
    ],
  } as unknown as NodesService;
  const readings = {
    bucketTemperatures: async (window: { from: Date; to: Date }) => {
      bucketWindows.push(window);
      return [];
    },
  } as unknown as ReadingsService;
  return new ZoneHistoryService(
    zones,
    devices,
    transitions,
    nodes,
    readings,
    new FixedClock(NOW),
  );
}

describe('ZoneHistoryService.buildZoneHistory', () => {
  it('covers the 24 hours to now', async () => {
    const bucketWindows: { from: Date; to: Date }[] = [];
    const report = await makeService(bucketWindows).buildZoneHistory();
    expect(report.from).toBe('2026-11-22T12:00:00.000Z');
    expect(report.to).toBe(NOW.toISOString());
    expect(bucketWindows).toEqual([
      { from: new Date('2026-11-22T12:00:00Z'), to: NOW },
    ]);
  });

  it('cuts a run at the node going offline and marks the rest unknown', async () => {
    const report = await makeService().buildZoneHistory();
    const [heater] = report.zones[0].devices;
    expect(heater.nodeId).toBe('patji');
    expect(heater.spans.map((span) => [span.state, span.to])).toEqual([
      ['on', '2026-11-23T06:00:00.000Z'],
      ['unknown', NOW.toISOString()],
    ]);
  });
});
