import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { DeviceRole, type Node } from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import type { DeviceEntity, PinTransitionEntity } from '../devices/models';
import type { NodesService } from '../nodes/nodes.service';
import type { ZoneEntity } from '../zones/models';
import { ReportsService } from './reports.service';

const NOW = new Date('2026-09-09T19:00:00Z');
const BURNER_ID = 'burner-device';
const CONFIGURED_TIMEZONE = 'America/Toronto';

interface FakeTables {
  rulesConfig?: unknown;
  inForceAtStart?: Partial<PinTransitionEntity>[];
  inWindow?: Partial<PinTransitionEntity>[];
  nodes?: Partial<Node>[];
}

function burnerRow(
  observedAt: string,
  energised: boolean | null,
): Partial<PinTransitionEntity> {
  return {
    nodeId: 'elantris',
    pin: 17,
    energised,
    deviceId: BURNER_ID,
    observedAt: new Date(observedAt),
  };
}

function makeService(tables: FakeTables): ReportsService {
  const zone = {
    rulesConfig: tables.rulesConfig ?? {
      timezone: 'America/Vancouver',
      enabledRoles: [],
      sensorPolicy: { default: { source: 'mean', maxAgeMs: 60_000 } },
      rules: {},
    },
  } as ZoneEntity;
  const devices = {
    find: async () => [
      {
        id: BURNER_ID,
        name: 'CO2 burner',
        role: DeviceRole.Co2Generator,
        zoneId: 'greenhouse-zone',
        node: { slug: 'elantris' },
        zone,
      },
    ],
  } as unknown as Repository<DeviceEntity>;
  const inForceQuery = {
    distinctOn: () => inForceQuery,
    where: () => inForceQuery,
    orderBy: () => inForceQuery,
    addOrderBy: () => inForceQuery,
    getMany: async () => tables.inForceAtStart ?? [],
  };
  const transitions = {
    createQueryBuilder: () => inForceQuery,
    find: async () => tables.inWindow ?? [],
  } as unknown as Repository<PinTransitionEntity>;
  const nodes = {
    findAll: async () =>
      tables.nodes ?? [
        {
          slug: 'elantris',
          online: true,
          lastSeenAt: null,
          latestReadingAt: null,
        },
      ],
  } as unknown as NodesService;
  const config = {
    get: () => CONFIGURED_TIMEZONE,
  } as unknown as ConfigService;
  return new ReportsService(
    devices,
    transitions,
    nodes,
    new FixedClock(NOW),
    config,
  );
}

describe('ReportsService.buildEquipmentRuntime', () => {
  it('covers 30 days unless asked for another number', async () => {
    const report = await makeService({}).buildEquipmentRuntime({});
    expect(report.days).toBe(30);
    expect(report.devices[0].days).toHaveLength(30);
    expect(report.generatedAt).toBe(NOW.toISOString());
  });

  it('starts the window from the row in force before it', async () => {
    const report = await makeService({
      inForceAtStart: [burnerRow('2026-08-01T00:00:00Z', true)],
      inWindow: [burnerRow('2026-09-09T09:00:00Z', false)],
    }).buildEquipmentRuntime({ days: 1 });
    const [today] = report.devices[0].days;
    expect(today).toMatchObject({
      date: '2026-09-09',
      hoursOn: 2,
      hoursOff: 10,
      hoursUnknown: 0,
    });
  });

  it('uses the zone timezone, falling back to the deployment one when the rules do not parse', async () => {
    const zoned = await makeService({}).buildEquipmentRuntime({ days: 1 });
    expect(zoned.devices[0].timezone).toBe('America/Vancouver');
    const fallback = await makeService({
      rulesConfig: { nonsense: true },
    }).buildEquipmentRuntime({ days: 1 });
    expect(fallback.devices[0].timezone).toBe(CONFIGURED_TIMEZONE);
  });

  it('caps an open run at the later of the node last connection and its latest reading', async () => {
    const report = await makeService({
      inWindow: [
        burnerRow('2026-09-09T07:00:00Z', false),
        burnerRow('2026-09-09T15:00:00Z', true),
      ],
      nodes: [
        {
          slug: 'elantris',
          online: false,
          lastSeenAt: '2026-09-09T08:00:00Z',
          latestReadingAt: '2026-09-09T16:30:00Z',
        },
      ],
    }).buildEquipmentRuntime({ days: 1 });
    expect(report.devices[0].days[0]).toMatchObject({
      hoursOn: 1.5,
      hasRunCappedAtLastSeen: true,
    });
  });
});
